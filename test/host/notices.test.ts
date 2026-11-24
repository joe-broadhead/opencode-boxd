// Notices on the stock host (design §3.13, §7.2): `ctx.session.synthetic` posts a notice into the coordinator's
// session with `resume` false and true; `ctx.session.get` reports a session's `parentID`, so a session under another
// one gets no notice; a deleted session gets none either, fails cleanly, and is recorded. A delivered change is not
// repeated by a re-created watcher or a replay, and a genuinely new change reaches each coordinator exactly once more.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createRuntime } from "../../src/exec/runtime.js"
import { ledgerPort } from "../../src/ledger/index.js"
import { Ledger } from "../../src/ledger/store.js"
import { FileNoticeCursors } from "../../src/notice-cursors.js"
import { NoticeQueue } from "../../src/notices.js"
import { parseOptions } from "../../src/options.js"
import type { ImportV0Port, WorkEvent } from "../../src/ports.js"
import type { CoreServices } from "../../src/services.js"
import { TOOLS_RPC_ID } from "../../src/tools-rpc.js"
import { createWatch } from "../../src/watch.js"
import { attempt, cleanup, HOST_VERSION, session, startHost, until, type Host } from "./harness.js"

setDefaultTimeout(180_000)
afterAll(cleanup)

const idle = (seq: number, workId: string): WorkEvent => ({ seq, at: new Date().toISOString(), workId, from: "busy", to: "idle", outcome: "completed" })

/** A notice queue on the host's own session API, as the watcher builds it. */
function queue(host: Host, mode: "wake" | "queue", unsubscribed: string[], root = host.ledger) {
  return new NoticeQueue({
    mode: () => mode,
    sessions: host.probe().session,
    now: () => new Date(),
    cursors: new FileNoticeCursors(root),
    unsubscribe: async (session) => void unsubscribed.push(session),
  })
}

const synthetic = async (host: Host, sessionID: string) => {
  const inbox = await host.client.session.inbox.list({ sessionID })
  const posted = inbox.findLast((item) => item.type === "synthetic")
  return posted?.type === "synthetic" ? posted.payload.text : undefined
}

const synthetics = async (host: Host, sessionID: string) => {
  const inbox = await host.client.session.inbox.list({ sessionID })
  return inbox.flatMap((item) => (item.type === "synthetic" ? [item.payload.text] : []))
}

/** One tools RPC call, as a script makes it. */
const rpcCall = async (host: Host, method: string, input: Record<string, unknown>, sessionID: string) => {
  const rpc = host.client.rpc as unknown as { call: (request: object) => Promise<{ output: Record<string, unknown> }> }
  return (await rpc.call({ rpcID: TOOLS_RPC_ID, method, input: { sessionID, input }, location: host.location })).output
}

/** The real watcher over the host's ledger, behind the host's own session API and the fake boxd CLI. */
async function watch(host: Host) {
  const runtime = createRuntime({ boxdBin: host.boxd.bin, opencodeBin: host.boxd.fake.opencodeBin })
  const complete = { state: "complete" as const, works: 0, blocked: [] as string[] }
  const importV0: ImportV0Port = {
    state: () => complete,
    run: async () => complete,
    readPhase: async () => {
      throw new Error("readPhase is not part of the notices test.")
    },
    adopt: async () => {
      throw new Error("adopt is not part of the notices test.")
    },
    dispose: async () => undefined,
  }
  const ledger = ledgerPort(new Ledger(host.ledger), importV0)
  const core: CoreServices = {
    options: parseOptions({ notices: "queue", autoSleepMinutes: 0 }),
    hostVersion: HOST_VERSION,
    projectDirectory: host.location.directory,
    ledgerRoot: host.ledger,
    boxdBin: host.boxd.bin,
    opencodeBin: host.boxd.fake.opencodeBin,
    clock: { now: () => new Date() },
    sessions: host.probe().session,
    report: () => {},
    ...runtime,
    importV0,
    ledger,
  }
  const watcher = createWatch(core, { autoStart: false })
  return {
    watcher,
    ledger,
    async dispose() {
      await watcher.dispose()
      await ledger.dispose()
      await runtime.dispose()
    },
  }
}

describe("notices on a stock host", () => {
  test("a queued notice lands in the coordinator's session and starts no turn", async () => {
    const host = await startHost()
    try {
      const coordinator = (await host.client.sessions.create({ agent: "build", location: host.location })).id
      const notices = queue(host, "queue", [])
      notices.enqueue(idle(5, "review-api"), coordinator, "none")
      await notices.flushDue()
      const text = await until("the notice is in the inbox", () => synthetic(host, coordinator))
      expect(text).toBe("boxd: 1 work changed — review-api idle (completed, not saved). boxd_status({ since: 4 }) has the details.")
      expect(notices.dropped()).toEqual([])
      await notices.stop()
    } finally {
      await host.close()
    }
  })

  test("a waking notice starts the coordinator's turn", async () => {
    const host = await startHost({ model: true })
    try {
      const coordinator = (await host.client.sessions.create({ agent: "build", location: host.location })).id
      const notices = queue(host, "wake", [])
      notices.enqueue(idle(9, "db-mig"), coordinator, "fresh")
      await notices.flushDue()
      expect(await until("the notice is in the inbox", () => synthetic(host, coordinator))).toContain("db-mig idle (completed, saved)")
      // The woken session runs a turn on the mock model, which records the request.
      await until("the coordinator's turn ends", async () => (await host.client.session.get({ sessionID: coordinator })).outcome !== undefined, 30_000)
      expect(notices.dropped()).toEqual([])
      await notices.stop()
    } finally {
      await host.close()
    }
  })

  test("a session under another, and a deleted session, get no notice; each is recorded and unsubscribed", async () => {
    const host = await startHost()
    try {
      const root = (await host.client.sessions.create({ agent: "build", location: host.location })).id
      const child = (await host.client.sessions.create({ agent: "build", parentID: root, location: host.location })).id
      expect((await host.probe().session.get({ sessionID: child } as never)) as { parentID?: string }).toMatchObject({ parentID: root })
      const deleted = (await host.client.sessions.create({ agent: "build", location: host.location })).id
      await host.client.session.remove({ sessionID: deleted })
      const unsubscribed: string[] = []
      const notices = queue(host, "wake", unsubscribed)
      notices.enqueue(idle(3, "child-work"), child, "none")
      notices.enqueue(idle(4, "gone-work"), deleted, "none")
      await notices.flushDue()
      expect(await synthetic(host, child)).toBeUndefined()
      expect(notices.dropped().map((item) => [item.session, item.dropped]).sort()).toEqual([
        [child, "the session now has a parent"],
        [deleted, "the session is gone"],
      ].sort())
      expect(unsubscribed.sort()).toEqual([child, deleted].sort())
      await notices.stop()
    } finally {
      await host.close()
    }
  })

  test("a delivered change is not repeated by a re-created watcher, and the next change reaches each coordinator once", async () => {
    const host = await startHost({ options: { notices: "off" } })
    try {
      const first = await session(host)
      const second = await session(host)
      // Two real works, each created from its own coordinator over the model path; the fake CLI and guest do the work.
      expect(await attempt(host, first, "build", "boxd_ensure", "reject", { workId: "ci-a" })).toMatchObject({ asked: undefined, ok: true, output: { state: "ready" } })
      expect(await attempt(host, second, "build", "boxd_ensure", "reject", { workId: "ci-b" })).toMatchObject({ asked: undefined, ok: true, output: { state: "ready" } })
      const run = await watch(host)
      const seen: WorkEvent[] = []
      run.watcher.watch.subscribe((event) => seen.push(event))
      await run.watcher.tick()
      // A change through the fake CLI: each sleep appends its work's `asleep` event.
      expect(await rpcCall(host, "boxd_sleep", { workId: "ci-a" }, first)).toMatchObject({ state: "asleep" })
      expect(await rpcCall(host, "boxd_sleep", { workId: "ci-b" }, second)).toMatchObject({ state: "asleep" })
      await run.watcher.tick()
      await run.watcher.flushNotices()
      const asleep = seen.filter((event) => event.to === "asleep")
      expect(asleep.map((event) => event.workId).sort()).toEqual(["ci-a", "ci-b"])
      expect(await synthetics(host, first)).toEqual([expect.stringContaining("ci-a asleep (boxd_sleep)")])
      expect(await synthetics(host, second)).toEqual([expect.stringContaining("ci-b asleep (boxd_sleep)")])
      await run.dispose()

      // The same events, replayed through a new queue over the persisted cursor store, post nothing.
      const replay = queue(host, "queue", [])
      replay.enqueue(asleep.find((event) => event.workId === "ci-a")!, first, "none")
      replay.enqueue(asleep.find((event) => event.workId === "ci-b")!, second, "none")
      await replay.flushDue()
      await replay.stop()
      expect(await synthetics(host, first)).toHaveLength(1)
      expect(await synthetics(host, second)).toHaveLength(1)

      // A genuinely new change through a watcher created after the first one was disposed: exactly one more each.
      const again = await watch(host)
      await again.watcher.tick()
      expect(await rpcCall(host, "boxd_resume", { workId: "ci-a" }, first)).toMatchObject({ state: "ready" })
      expect(await rpcCall(host, "boxd_resume", { workId: "ci-b" }, second)).toMatchObject({ state: "ready" })
      await again.watcher.tick()
      await again.watcher.flushNotices()
      const firstInbox = await synthetics(host, first)
      const secondInbox = await synthetics(host, second)
      expect(firstInbox).toHaveLength(2)
      expect(secondInbox).toHaveLength(2)
      expect(firstInbox[1]).toContain("ci-a ready")
      expect(secondInbox[1]).toContain("ci-b ready")
      await again.dispose()
    } finally {
      await host.close()
    }
  })
})
