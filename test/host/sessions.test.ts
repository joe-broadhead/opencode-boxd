// Package C2's tools on the stock host (design §7.2), through the host's own executor and the tools RPC, with the fake
// boxd CLI, the fake guest and the fake laptop `opencode`: submit, harvest (the laptop's copy replaced, F1) and drop by
// id end to end; Stop on the model path and on the RPC path ends a long boxd_exec and leaves no process behind; a
// submit from a subagent session and from Code Mode subscribes the root coordinator; read-only means read-only for
// boxd_read; and the host-side stall test, a list of 300 submits under CLI latency.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createRuntime } from "../../src/exec/runtime.js"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { ledgerPort } from "../../src/ledger/index.js"
import { Ledger } from "../../src/ledger/store.js"
import type { WorkRecord } from "../../src/ledger/types.js"
import { CAPS, GUEST_HELPER_PATH, type MachineId, type OpContext } from "../../src/ports.js"
import type { FakeMachine } from "./fake-cli.js"
import { cleanup, HOST_VERSION, session, startHost, until, type Host } from "./harness.js"
import { peakOf } from "./spawn-counter.js"
import { verbOf } from "../support/spawn-count.js"

setDefaultTimeout(120_000)
afterAll(cleanup)

const VERSION_OF = (host: Host) => host.boxd.fake.read().version
const op = (callId: string): OpContext => ({ call: { callId, source: "boxd_ensure" } })

/** One tools RPC call, as a script makes it. */
const rpcCall = (host: Host, method: string, input: Record<string, unknown>, sessionID: string, signal?: AbortSignal) => {
  const rpc = host.client.rpc as unknown as { call: (request: object, options?: object) => Promise<{ output: Record<string, any> }> }
  return rpc.call({ rpcID: TOOLS_RPC_ID, method, input: { sessionID, input }, location: host.location }, signal ? { signal } : undefined)
}

/** The plugin publishes its ledger on its first call; the test then writes records beside it, as `boxd_ensure` would. */
async function ledgerOf(host: Host, sessionID: string) {
  await rpcCall(host, "boxd_read", { workId: "warm-up", log: "server" }, sessionID)
  await until("the plugin published its ledger", async () => existsSync(join(host.ledger, "v1", "complete")))
  const complete = { state: "complete" as const, works: 0, blocked: [] }
  return ledgerPort(new Ledger(host.ledger), { state: () => complete, run: async () => complete })
}

const recordOf = (host: Host, workId: string) => JSON.parse(readFileSync(join(host.ledger, "v1", "works", workId, "work.json"), "utf8")) as WorkRecord

/** A work as `boxd_ensure` leaves it: the machine, the helper and a clean git tree on it, and its open record. */
async function seedWork(host: Host, ledger: Awaited<ReturnType<typeof ledgerOf>>, workId: string, over: Partial<WorkRecord> = {}, install = true): Promise<FakeMachine> {
  const machine = host.boxd.seed(`oc-${workId}`, { status: "running", region: "fra", labels: { owner: "opencode-boxd", role: "session", work: workId } })
  const tree = join(host.boxd.fake.disk(machine), "home", "boxd", "work", workId)
  if (install) {
    const runtime = createRuntime({ boxdBin: host.boxd.bin, opencodeBin: host.boxd.fake.opencodeBin })
    try {
      await runtime.runner.withMachineLock({ id: machine.id as MachineId }, op("seed"), async () => {
        const { target } = await runtime.boxd.checkOwned("fra", machine.name as `oc-${string}`, machine.id as MachineId, op("seed"))
        await runtime.guest.setup(target, { directory: `/home/boxd/work/${workId}`, opencode: VERSION_OF(host) }, op("seed"))
      })
    } finally {
      await runtime.dispose()
    }
    for (const args of [["init", "--quiet"], ["commit", "--quiet", "--allow-empty", "-m", "init"]]) Bun.spawnSync(["git", "-C", tree, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args])
  }
  const record: WorkRecord = {
    format: 1,
    workId,
    state: "open",
    region: "fra",
    machine: `oc-${workId}`,
    machineId: machine.id as MachineId,
    size: "2x8",
    image: { name: "oc-golden", opencode: VERSION_OF(host) },
    laptopDirectory: host.location.directory,
    guestDirectory: `/home/boxd/work/${workId}`,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    guestHelper: "v1",
    ...over,
  }
  await ledger.update([workId], async () => ({ write: [record], value: undefined }), op("seed"))
  return machine
}

/** The host's executor for one tool, as the model path calls it. */
async function executor(host: Host, tool: string) {
  return until(`${tool} is registered`, async () => (await host.probe().tool.list()).find((item) => item.id === tool))
}

describe("package C2 on a stock host", () => {
  test("submit, harvest and drop over the tools RPC: the laptop's copy is replaced on each harvest (F1) and the machine is removed by id", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      const ledger = await ledgerOf(host, build)
      const machine = await seedWork(host, ledger, "e2e")
      // A transcript moves only between matching releases: the guest runs this host's OpenCode.
      host.guest.setVersion(HOST_VERSION)
      host.guest.next("ses_e2e")
      expect((await rpcCall(host, "boxd_submit", { workId: "e2e", text: "Start." }, build)).output).toMatchObject({ state: "admitted", sessionId: "ses_e2e", delivery: "started" })
      host.guest.say("ses_e2e", "Done.", Date.now())
      host.guest.complete("ses_e2e")
      expect((await rpcCall(host, "boxd_harvest", { workId: "e2e" }, build)).output).toMatchObject({ state: "saved", outcome: "completed", sessions: [{ id: "ses_e2e" }] })
      const laptop = () => host.boxd.fake.read().laptopSessions?.ses_e2e?.messages ?? 0
      const first = laptop()
      expect(first).toBeGreaterThan(0)
      await rpcCall(host, "boxd_submit", { workId: "e2e", text: "More." }, build)
      host.guest.say("ses_e2e", "More done.", Date.now())
      host.guest.complete("ses_e2e")
      await rpcCall(host, "boxd_harvest", { workId: "e2e" }, build)
      expect(laptop()).toBeGreaterThan(first)
      expect((await rpcCall(host, "boxd_drop", { workId: "e2e" }, build)).output).toEqual({ state: "dropped", workId: "e2e", machine: "oc-e2e" })
      expect(host.boxd.machines().find((item) => item.id === machine.id)!.status).toBe("destroyed")
      const removes = host.boxd.calls().filter((line) => line.startsWith("machine remove"))
      expect(removes).toHaveLength(1)
      expect(removes[0]!.startsWith(`machine remove ${machine.id} `)).toBe(true)
      expect(recordOf(host, "e2e").state).toBe("closed")
    } finally {
      await host.close()
    }
  })

  test("Stop on the model path ends a long boxd_exec, and no process it started is left", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      const ledger = await ledgerOf(host, build)
      await seedWork(host, ledger, "stop-model", {}, false)
      const marker = `60.${String(process.pid).padStart(7, "0")}${Math.floor(Math.random() * 1e6)}`
      const tool = await executor(host, "boxd_exec")
      const stop = new AbortController()
      const run = tool
        .execute({ workId: "stop-model", command: ["sleep", marker] }, { sessionID: build, agent: "build", messageID: "msg_stop", id: "call_stop_model", signal: stop.signal, progress: async () => {} } as never)
        .then(
          (value: unknown) => (value as { output: Record<string, unknown> }).output,
          (error: unknown) => (error instanceof Error && /interrupt/i.test(error.message) ? "interrupted by the host" : error),
        )
      await until("the command runs", async () => Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim() !== "")
      const stoppedAt = Date.now()
      stop.abort()
      const result = (await run) as Record<string, unknown> | string
      expect(Date.now() - stoppedAt).toBeLessThan(5_000)
      const seen = typeof result === "string" ? result : { state: result.state, error: result.error, uncertain: result.uncertain }
      expect([{ state: "cancelled", error: "CANCELLED", uncertain: true }, "interrupted by the host"]).toContainEqual(seen as never)
      await until("nothing the call started is left", async () => Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim() === "", 5_000)
    } finally {
      await host.close()
    }
  })

  test("Stop on the RPC path (call.signal) ends a long boxd_exec, and no process it started is left", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      const ledger = await ledgerOf(host, build)
      await seedWork(host, ledger, "stop-rpc", {}, false)
      const marker = `61.${String(process.pid).padStart(7, "0")}${Math.floor(Math.random() * 1e6)}`
      const stop = new AbortController()
      const run = rpcCall(host, "boxd_exec", { workId: "stop-rpc", command: ["sleep", marker] }, build, stop.signal).then(
        (value) => value.output,
        (error: unknown) => error,
      )
      await until("the command runs", async () => Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim() !== "")
      stop.abort()
      await run
      await until("nothing the call started is left", async () => Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim() === "", 10_000)
    } finally {
      await host.close()
    }
  })

  test("a submit from a subagent session, and one from a Code Mode program, subscribe the root coordinator (M-b, L-c)", async () => {
    const host = await startHost({ model: true })
    try {
      const root = await session(host)
      const ledger = await ledgerOf(host, root)
      await seedWork(host, ledger, "coord")
      const child = (await host.client.sessions.create({ agent: "build", parentID: root, location: host.location } as never)).id
      expect(((await host.client.session.get({ sessionID: child })) as { parentID?: string }).parentID).toBe(root)
      host.guest.next("ses_coord_work")
      const tool = await executor(host, "boxd_submit")
      const answer = (await tool.execute({ workId: "coord", text: "From a subagent." }, { sessionID: child, agent: "build", messageID: "msg_sub", id: "call_sub", signal: new AbortController().signal, progress: async () => {} } as never)) as { output: Record<string, unknown> }
      expect(answer.output).toMatchObject({ state: "admitted" })
      expect(recordOf(host, "coord").session?.notify).toBe(root)

      // Code Mode is the model path: a program's submit subscribes the session that ran it.
      const program = await host.client.session.create({ location: { directory: host.location.directory }, agent: "build" })
      await host.client.session.prompt({ sessionID: program.id, text: `[[mock:tool:execute:${JSON.stringify({ code: 'const r = await tools.boxd.submit({ workId: "coord", text: "From Code Mode." }); return "submit:" + r.state' })}]]` })
      await until("the program's submit is recorded", async () => recordOf(host, "coord").session?.notify === program.id, 60_000)
    } finally {
      await host.close()
    }
  })

  test("read-only means read-only: boxd_read uploads nothing, adopts nothing and leaves the ledger's bytes as they were", async () => {
    const host = await startHost({ options: { access: "read-only" } })
    try {
      const build = await session(host)
      const ledger = await ledgerOf(host, build)
      const machine = await seedWork(host, ledger, "reader")
      writeFileSync(join(host.boxd.fake.disk(machine), "home", "boxd", "work", "reader", "NOTES.md"), "hello\n")
      // An imported v0 work: the guest has only v0's helper, which has no read action.
      await seedWork(host, ledger, "legacy", { guestHelper: "v0", importedFrom: "v0" }, false)
      const before = treeDigest(join(host.ledger, "v1", "works"))
      const spawned = host.boxd.fake.spawns().length
      expect((await rpcCall(host, "boxd_read", { workId: "reader", path: "NOTES.md" }, build)).output).toMatchObject({ state: "read", text: "hello\n" })
      expect((await rpcCall(host, "boxd_read", { workId: "legacy", log: "server" }, build)).output).toMatchObject({ state: "unreachable", error: "GUEST_FAILED" })
      const after = host.boxd.fake.spawns().slice(spawned).map((spawn) => spawn.argv.join(" "))
      expect(after.filter((line) => line.startsWith("machine cp") || line.includes("--install") || line.includes("/tmp/opencode-boxd"))).toEqual([])
      expect(after.filter((line) => line.startsWith("machine exec")).every((line) => line.includes(GUEST_HELPER_PATH))).toBe(true)
      expect(treeDigest(join(host.ledger, "v1", "works"))).toEqual(before)
    } finally {
      await host.close()
    }
  })

  test("the stall test, host side: a list of 300 submits under CLI latency stays within the caps, and the server's event loop stays free", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      const ledger = await ledgerOf(host, build)
      const helper = readFileSync(new URL("../../guest/guest.py", import.meta.url))
      const ids = Array.from({ length: 300 }, (_, index) => `s${index}`)
      for (const id of ids) {
        const machine = await seedWork(host, ledger, id, {}, false)
        // The helper and its password, as setup leaves them, without a setup exec per machine.
        const home = join(host.boxd.fake.disk(machine), "home", "boxd", ".opencode-boxd")
        Bun.spawnSync(["mkdir", "-p", home, join(host.boxd.fake.disk(machine), "home", "boxd", "work", id)])
        writeFileSync(join(home, "guest.py"), helper)
        writeFileSync(join(home, "password"), "fake", { mode: 0o600 })
      }
      host.guest.next("ses_stall")
      host.boxd.fake.update((state) => void (state.latencyMs = [100, 300]))
      const started = Date.now()
      let lag = 0
      let last = performance.now()
      const sampler = setInterval(() => {
        const now = performance.now()
        lag = Math.max(lag, now - last - 50)
        last = now
      }, 50)
      let answer: Record<string, any>
      try {
        answer = (await rpcCall(host, "boxd_submit", { works: ids.map((workId) => ({ workId, text: "Go." })) }, build)).output
      } finally {
        clearInterval(sampler)
      }
      expect(answer.state).toBe("done")
      expect(answer.counts).toEqual({ admitted: 300 })
      const spawns = host.boxd.fake.spawns().filter((spawn) => spawn.startedAt >= started)
      const boxd = spawns.filter((spawn) => spawn.bin === "boxd").map((spawn) => ({ call: spawn.call, bin: spawn.bin, argv: spawn.argv, verb: verbOf(spawn.bin, spawn.argv), startedAt: spawn.startedAt, endedAt: spawn.endedAt }))
      expect(peakOf(boxd)).toBeLessThanOrEqual(CAPS.shared)
      // Every exec in the window, by the helper action it asked for, its machine and its call. Exactly one prompt per
      // work, each from the submit's own call: a submit never reaches a guest twice. A call that outlasts the watcher's
      // 60 s interval (a slow test machine) also sees the watcher's phase reads of the works it made busy; anything
      // else is a bug.
      const execs = spawns.filter((spawn) => spawn.bin === "boxd" && verbOf(spawn.bin, spawn.argv) === "machine exec").map((spawn) => ({ machine: spawn.argv[2], action: spawn.action, call: spawn.call }))
      const prompts = execs.filter((exec) => exec.action === "prompt")
      expect(prompts).toHaveLength(300)
      expect(new Set(prompts.map((exec) => exec.machine)).size).toBe(300)
      expect(new Set(prompts.map((exec) => exec.call)).size).toBe(1)
      expect(prompts[0]!.call?.startsWith("watcher-")).toBe(false)
      expect(execs.filter((exec) => exec.action !== "prompt" && !(exec.action === "phase" && exec.call?.startsWith("watcher-")))).toEqual([])
      expect(lag).toBeLessThan(150)
    } finally {
      await host.close()
    }
  }, 240_000)
})

/** Every file under a folder with its sha256, for a byte-for-byte comparison. */
function treeDigest(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (folder: string, prefix: string) => {
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name)
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`)
      else out[`${prefix}${name}`] = createHash("sha256").update(readFileSync(path)).digest("hex")
    }
  }
  walk(dir, "")
  return out
}
