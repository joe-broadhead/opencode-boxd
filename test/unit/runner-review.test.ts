// The review of package A (wave B, boxd #20): its reproductions, kept as tests. The read rule is checked when a read
// starts, not when it is queued (M-1); one joiner's Stop never cancels the others of a shared flight (M-2); a flight
// holds no machine lock of the caller that started it, so two holders never overlap on one machine (M-3); Stop and
// dispose reach a whole process tree with a bounded escalation and never hang on a pipe a descendant holds (L-1, L-2).
// Processes are found by the pid files their own scripts write, never by name across the machine.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBoxdCli } from "../../src/boxd/cli.js"
import { BoxdError } from "../../src/errors.js"
import { createRunner } from "../../src/exec/runner.js"
import type { BoxdPort, MachineId, OpContext, ReadTarget } from "../../src/ports.js"
import { startFakeCli, type FakeCli } from "../host/fake-cli.js"

const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "boxd-review-")))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (callId: string, signal?: AbortSignal, pool: OpContext["pool"] = "foreground"): OpContext => ({ call: { callId, source: "boxd_status" }, pool, ...(signal ? { signal } : {}) })
const code = (error: unknown) => (error instanceof BoxdError ? error.code : String(error))
const settle = <T>(promise: Promise<T>) => promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/**
 * A descendant that leaves the child's process group (a new session) and keeps its stdout open, writing its pid first.
 * `os.setsid` from Python, which every test machine has, where the `setsid` binary is Linux's alone.
 */
const escape = (file: string, seconds: number) =>
  `python3 -c 'import os, sys; os.setsid(); open(sys.argv[1], "w").write(str(os.getpid())); os.execvp("sleep", ["sleep", sys.argv[2]])' ${file} ${seconds}`

let files = 0
const pidFile = () => join(dir, `pid-${++files}`)
async function readPid(path: string): Promise<number> {
  for (let tries = 0; tries < 200 && !existsSync(path); tries++) await sleep(10)
  for (let tries = 0; tries < 50 && readFileSync(path, "utf8").trim() === ""; tries++) await sleep(10)
  return Number(readFileSync(path, "utf8"))
}

describe("locks", () => {
  test("a lock whose holder's child is killed from outside is released; the waiter proceeds", async () => {
    const runner = createRunner()
    const id = { id: "m1" as MachineId }
    const file = pidFile()
    const holder = settle(runner.withMachineLock(id, ctx("a"), () => runner.spawn({ ...ctx("a"), bin: "sh", args: ["-c", `echo $$ > ${file}; exec sleep 31`], timeoutMs: 60_000 })))
    const pid = await readPid(file)
    let waiterRan = false
    const waiter = runner.withMachineLock(id, ctx("b"), async () => {
      waiterRan = true
    })
    await sleep(200)
    expect(waiterRan).toBe(false)
    process.kill(pid, "SIGKILL")
    // Killed from outside: an answer with the signal's exit, not an error.
    expect((await holder).ok).toBe(true)
    await waiter
    expect(waiterRan).toBe(true)
    expect(runner.lockedMachines()).toBe(0)
    await runner.dispose()
  })

  test("Stop while waiting on the lock: CANCELLED, uncertain false; the holder is unaffected; the lock passes on", async () => {
    const runner = createRunner()
    const id = { id: "m2" as MachineId }
    let release!: () => void
    const holder = runner.withMachineLock(id, ctx("a"), () => new Promise<void>((resolve) => (release = resolve)))
    const stop = new AbortController()
    const stopped = settle(runner.withMachineLock(id, ctx("b", stop.signal), async () => "ran"))
    const third = runner.withMachineLock(id, ctx("c"), async () => "third")
    await sleep(20)
    stop.abort()
    const answer = await stopped
    expect(answer.ok).toBe(false)
    expect(code((answer as { error: unknown }).error)).toBe("CANCELLED")
    expect((answer as { error: BoxdError }).error.details.uncertain).toBe(false)
    release()
    await holder
    expect(await third).toBe("third")
    expect(runner.lockedMachines()).toBe(0)
    await runner.dispose()
  })

  test("M-3: a flight started inside X's lock does not inherit it: two holders never overlap on X", async () => {
    const runner = createRunner()
    const X = { id: "mx" as MachineId }
    let inside = 0
    let overlap = false
    const enter = async () => {
      inside += 1
      if (inside > 1) overlap = true
      await sleep(100)
      inside -= 1
    }
    let flight!: Promise<unknown>
    await runner.withMachineLock(X, ctx("a"), async () => {
      flight = runner.singleFlight("build", async () => {
        await sleep(50)
        return runner.withMachineLock(X, ctx("flight"), enter)
      })
    })
    const other = runner.withMachineLock(X, ctx("c"), enter)
    expect((await settle(flight)).ok).toBe(true)
    await other
    expect(overlap).toBe(false)
    await runner.dispose()
  })

  test("M-3: a flight started under one machine's lock may take another machine's lock", async () => {
    const runner = createRunner()
    const answer = await runner.withMachineLock({ id: "m_one" as MachineId }, ctx("a"), () =>
      runner.singleFlight("golden:fra:2x8", () => runner.withMachineLock({ id: "m_builder" as MachineId }, ctx("build"), async () => runner.holds({ id: "m_one" as MachineId }))),
    )
    expect(answer).toBe(false)
    await runner.dispose()
  })

  test("M-3: a joined flight holds no lock of its starter either", async () => {
    const runner = createRunner()
    const X = { id: "mj" as MachineId }
    const seen = await runner.withMachineLock(X, ctx("a"), () => runner.join("guest:fra/oc-a:x", ctx("a"), async () => runner.holds(X)))
    expect(seen).toBe(false)
    await runner.dispose()
  })

  test("a lock holder that throws synchronously still releases", async () => {
    const runner = createRunner()
    const id = { id: "m3" as MachineId }
    await settle(
      runner.withMachineLock(id, ctx("a"), () => {
        throw new Error("boom")
      }),
    )
    expect(await runner.withMachineLock(id, ctx("b"), async () => 1)).toBe(1)
    await runner.dispose()
  })
})

describe("joined flights (M-2)", () => {
  test("a joiner's Stop detaches that joiner alone; the flight runs for the others", async () => {
    const runner = createRunner()
    let runs = 0
    let flightSignal!: AbortSignal
    const flight = async (context: OpContext) => {
      runs += 1
      flightSignal = context.signal!
      await sleep(100)
      return "answer"
    }
    const stopA = new AbortController()
    const a = settle(runner.join("k", ctx("A", stopA.signal), flight))
    const b = settle(runner.join("k", ctx("B"), flight))
    await sleep(10)
    stopA.abort()
    const answerA = await a
    expect(answerA.ok ? "ran" : code(answerA.error)).toBe("CANCELLED")
    expect(await b).toEqual({ ok: true, value: "answer" })
    expect(runs).toBe(1)
    expect(flightSignal.aborted).toBe(false)
    await runner.dispose()
  })

  test("when every joiner has left, the flight is stopped, its child killed, and the next caller starts a new one", async () => {
    const runner = createRunner({ killGraceMs: 200 })
    const file = pidFile()
    const stopA = new AbortController()
    const stopB = new AbortController()
    const flight = (context: OpContext) => runner.spawn({ ...context, bin: "sh", args: ["-c", `echo $$ > ${file}; exec sleep 32`], timeoutMs: 60_000 })
    const a = settle(runner.join("k", ctx("A", stopA.signal), flight))
    const b = settle(runner.join("k", ctx("B", stopB.signal), flight))
    const pid = await readPid(file)
    stopA.abort()
    await sleep(50)
    expect(alive(pid)).toBe(true)
    stopB.abort()
    expect([(await a).ok, (await b).ok]).toEqual([false, false])
    for (let tries = 0; tries < 50 && alive(pid); tries++) await sleep(20)
    expect(alive(pid)).toBe(false)
    expect(await runner.join("k", ctx("C"), async () => "fresh")).toBe("fresh")
    await runner.dispose()
  })
})

describe("the boxd port's shared reads", () => {
  let fake: FakeCli
  let runner: ReturnType<typeof createRunner>
  let boxd: BoxdPort
  beforeEach(() => {
    fake = startFakeCli()
    runner = createRunner()
    boxd = createBoxdCli({ bin: fake.bin, runner })
  })
  afterEach(async () => {
    await runner.dispose()
    fake.dispose()
  })

  test("M-2: Stop of call A does not cancel call B that joined A's listing", async () => {
    fake.machine({ name: "oc-a", region: "fra" })
    await boxd.list({ maxAgeMs: 0 }, ctx("warm"))
    fake.update((state) => void (state.latencyMs = [800, 800]))
    // Older than the 1 ms the calls below accept, so both take a new listing rather than the warm one.
    await sleep(10)
    const stop = new AbortController()
    const a = settle(boxd.list({ maxAgeMs: 1 }, ctx("A", stop.signal)))
    await sleep(5)
    const b = settle(boxd.list({ maxAgeMs: 1 }, ctx("B")))
    await sleep(100)
    stop.abort()
    const [answerA, answerB] = await Promise.all([a, b])
    expect(answerA.ok ? "ok" : code(answerA.error)).toBe("CANCELLED")
    expect(answerB.ok).toBe(true)
    expect(fake.spawns().filter((spawn) => spawn.argv[1] === "list")).toHaveLength(2)
  })

  test("M-2: the same for the machine limit and the snapshots", async () => {
    await boxd.list({ maxAgeMs: 0 }, ctx("warm"))
    fake.update((state) => void (state.latencyMs = [500, 500]))
    const reads: Array<(context: OpContext) => Promise<unknown>> = [(context) => boxd.machineLimit(context), (context) => boxd.snapshots(context)]
    for (const read of reads) {
      const stop = new AbortController()
      const a = settle(read(ctx("A", stop.signal)))
      await sleep(5)
      const b = settle(read(ctx("B")))
      await sleep(50)
      stop.abort()
      expect([(await a).ok, (await b).ok]).toEqual([false, true])
    }
  })

  test("M-1: a read that waited in a queue past its listing's age joins a fresh listing; the machine now asleep is refused not-readable and never woken", async () => {
    fake.machine({ name: "oc-a", region: "fra" })
    const listing = await boxd.list({ maxAgeMs: 0 }, ctx("l"))
    const blockers = Array.from({ length: 12 }, (_, index) => runner.spawn({ ...ctx(`blocker${index}`), bin: "sleep", args: ["3"], timeoutMs: 10_000 }))
    await sleep(50)
    const target: ReadTarget = { region: "fra", name: "oc-a", listing, machineId: null }
    const read = settle(boxd.exec(target, "echo read-ran", { timeoutSeconds: 5, json: false }, ctx("r")))
    await sleep(100)
    // The machine hibernates while the read waits in the queue.
    fake.update((state) => void (state.machines.find((machine) => machine.name === "oc-a")!.status = "hibernated"))
    await Promise.all(blockers)
    const answer = await read
    expect(answer.ok).toBe(false)
    const error = (answer as { error: BoxdError }).error
    expect([error.code, error.details.kind]).toEqual(["MACHINE_ASLEEP", "not-readable"])
    expect(fake.read().wokenByExec ?? []).toEqual([])
    expect(fake.calls().filter((call) => call.startsWith("machine exec"))).toEqual([])
  })

  test("reads that waited in a queue past their listing's age still run on a running machine, sharing one fresh listing", async () => {
    fake.machine({ name: "oc-a", region: "fra" })
    const listing = await boxd.list({ maxAgeMs: 0 }, ctx("l"))
    const blockers = Array.from({ length: 12 }, (_, index) => runner.spawn({ ...ctx(`blocker${index}`), bin: "sleep", args: ["2.5"], timeoutMs: 10_000 }))
    await sleep(50)
    const target: ReadTarget = { region: "fra", name: "oc-a", listing, machineId: null }
    const lists = () => fake.calls().filter((call) => call.startsWith("machine list")).length
    const before = lists()
    const reads = Array.from({ length: 6 }, (_, index) => settle(boxd.exec(target, `echo read-${index}`, { timeoutSeconds: 5, json: false }, ctx(`r${index}`))))
    await Promise.all(blockers)
    const answers = await Promise.all(reads)
    expect(answers.map((answer) => answer.ok)).toEqual([true, true, true, true, true, true])
    // One fresh listing for the reads that waited; a second only if they outlived that one's 2 s.
    expect(lists() - before).toBeGreaterThanOrEqual(1)
    expect(lists() - before).toBeLessThanOrEqual(2)
    expect(fake.read().wokenByExec ?? []).toEqual([])
  })

  test("M-1: a read whose machine went to sleep before its slot came answers MACHINE_ASLEEP at the start", async () => {
    fake.machine({ name: "oc-a", region: "fra" })
    const blockers = Array.from({ length: 12 }, (_, index) => runner.spawn({ ...ctx(`blocker${index}`), bin: "sleep", args: ["0.3"], timeoutMs: 10_000 }))
    await sleep(20)
    // A listing that stays fresh enough, taken by hand, whose row is changed in place to the later state.
    const listing = { takenAt: Date.now(), fresh: true, machines: [{ name: "oc-a", region: "fra" as const, id: null, status: "running" as "running" | "hibernated", size: null, labels: {}, sharing: "private" as const, isolated: null }] }
    const read = settle(boxd.copyFrom({ region: "fra", name: "oc-a", listing, machineId: null }, "/home/boxd/x", join(dir, "x"), ctx("r")))
    listing.machines[0]!.status = "hibernated"
    await Promise.all(blockers)
    const answer = await read
    expect(answer.ok ? "ran" : code(answer.error)).toBe("MACHINE_ASLEEP")
    expect(fake.calls().filter((call) => call.startsWith("machine cp"))).toEqual([])
  })
})

describe("process trees", () => {
  test("L-1: Stop kills a group member that ignores SIGTERM and outlives the leader", async () => {
    const file = pidFile()
    const runner = createRunner({ killGraceMs: 300 })
    const stop = new AbortController()
    const script = `trap '' TERM; (trap '' TERM; exec sleep 61) </dev/null >/dev/null 2>&1 & echo $! > ${file}; trap - TERM; sleep 61`
    const run = settle(runner.spawn({ ...ctx("t", stop.signal), bin: "sh", args: ["-c", script], timeoutMs: 60_000 }))
    const grandchild = await readPid(file)
    stop.abort()
    expect((await run).ok).toBe(false)
    for (let tries = 0; tries < 50 && alive(grandchild); tries++) await sleep(20)
    const survived = alive(grandchild)
    if (survived) process.kill(grandchild, "SIGKILL")
    expect(survived).toBe(false)
    await runner.dispose()
  })

  test("L-2: dispose settles a child whose escaped descendant holds its stdout, within the bound", async () => {
    const file = pidFile()
    const runner = createRunner({ killGraceMs: 200 })
    const script = `${escape(file, 33)} & sleep 33`
    const run = settle(runner.spawn({ ...ctx("t"), bin: "sh", args: ["-c", script], timeoutMs: 60_000 }))
    const escaped = await readPid(file)
    const started = Date.now()
    const done = await Promise.race([runner.dispose().then(() => "disposed"), sleep(4000).then(() => "hung")])
    expect(done).toBe("disposed")
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(runner.health().children.now).toBe(0)
    expect((await run).ok).toBe(false)
    // It left the child's own process group, so no kill of that group can reach it: the test ends it.
    process.kill(escaped, "SIGKILL")
  })

  test("L-2: a timeout settles the same way: the slot comes back", async () => {
    const file = pidFile()
    const runner = createRunner({ killGraceMs: 100 })
    const script = `${escape(file, 34)} & sleep 34`
    const answer = await settle(runner.spawn({ ...ctx("t"), bin: "sh", args: ["-c", script], timeoutMs: 300 }))
    expect(answer.ok ? "ran" : code(answer.error)).toBe("TIMEOUT")
    expect(runner.health().children.now).toBe(0)
    process.kill(await readPid(file), "SIGKILL")
    await runner.dispose()
  })
})
