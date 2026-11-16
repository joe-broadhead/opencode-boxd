// Notices on the stock host (design §3.13, §7.2): `ctx.session.synthetic` posts a notice into the coordinator's
// session with `resume` false and true; `ctx.session.get` reports a session's `parentID`, so a session under another
// one gets no notice; a deleted session gets none either, fails cleanly, and is recorded.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { NoticeQueue } from "../../src/notices.js"
import type { WorkEvent } from "../../src/ports.js"
import { cleanup, startHost, until, type Host } from "./harness.js"

setDefaultTimeout(120_000)
afterAll(cleanup)

const idle = (seq: number, workId: string): WorkEvent => ({ seq, at: new Date().toISOString(), workId, from: "busy", to: "idle", outcome: "completed" })

/** A notice queue on the host's own session API, as the watcher builds it. */
function queue(host: Host, mode: "wake" | "queue", unsubscribed: string[]) {
  return new NoticeQueue({
    mode: () => mode,
    sessions: host.probe().session,
    now: () => new Date(),
    unsubscribe: async (session) => void unsubscribed.push(session),
  })
}

const synthetic = async (host: Host, sessionID: string) => {
  const inbox = await host.client.session.inbox.list({ sessionID })
  const posted = inbox.findLast((item) => item.type === "synthetic")
  return posted?.type === "synthetic" ? posted.payload.text : undefined
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
})
