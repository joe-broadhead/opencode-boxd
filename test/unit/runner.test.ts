// The runner (design §4.1, §7.1): an instrumented fake spawn shows the caps hold per pool under 300 queued calls with a
// golden build in flight, a freed shared slot goes to the foreground first without starving the background, the lock
// order cannot deadlock, a timeout kills (SIGTERM, then SIGKILL), Stop drops queued children and kills running ones,
// and the output cap kills an over-large child. One test uses real processes, to show a kill reaches a child's own
// children.
import { afterAll, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Writable } from "node:stream"
import { BoxdError } from "../../src/errors.js"
import { createRunner, type ChildLike, type Launch } from "../../src/provider/runner.js"
import { stillRunning } from "../support/processes.js"
import { CALL_TAG_ENV, CAPS, type MachineId, type OpContext, type Pool, type ReadTarget } from "../../src/ports.js"

const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "boxd-runner-")))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/**
 * A fake process. Its argv says what it does: `<pool> <ms>` lives that long and exits 0; `ignore-term` survives SIGTERM;
 * `print <bytes>` writes that much; `exit <code>` fails. The fake counts who is alive, per pool, and the most at once.
 */
function fakeLaunch() {
  const alive: Record<string, number> = {}
  const peak: Record<string, number> = {}
  let total = 0
  let totalPeak = 0
  const started: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = []
  const signals: Array<{ args: readonly string[]; signal: string }> = []
  const launch: Launch = (_bin, args, options) => {
    started.push({ args, env: options.env })
    const pool = args[0] ?? "x"
    alive[pool] = (alive[pool] ?? 0) + 1
    peak[pool] = Math.max(peak[pool] ?? 0, alive[pool]!)
    total += 1
    totalPeak = Math.max(totalPeak, total)
    const child = new EventEmitter() as EventEmitter & ChildLike
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    Object.assign(child, { pid: undefined, stdout, stderr, stdin: new Writable({ write: (_chunk, _encoding, done) => done() }) })
    let exited = false
    const exit = (code: number | null, signal: NodeJS.Signals | null = null) => {
      if (exited) return
      exited = true
      alive[pool]! -= 1
      total -= 1
      stdout.end()
      stderr.end()
      setImmediate(() => child.emit("close", code, signal))
    }
    ;(child as { kill: ChildLike["kill"] }).kill = (signal: NodeJS.Signals = "SIGTERM") => {
      signals.push({ args, signal })
      if (signal === "SIGKILL" || !args.includes("ignore-term")) exit(null, signal)
      return true
    }
    const ms = Number(args[1] ?? 1)
    if (args.includes("print")) setImmediate(() => stdout.write(Buffer.alloc(Number(args[args.indexOf("print") + 1]), "x")))
    if (args.includes("exit")) setTimeout(() => exit(Number(args[args.indexOf("exit") + 1])), ms)
    else if (!args.includes("forever")) setTimeout(() => exit(0), ms)
    return child
  }
  return { launch, alive, peak, started, signals, totalPeak: () => totalPeak }
}

const context = (callId: string, pool: Pool = "foreground", signal?: AbortSignal): OpContext => ({ call: { callId, source: "boxd_status" }, pool, ...(signal ? { signal } : {}) })
const spawnIn = (runner: ReturnType<typeof createRunner>, pool: Pool, ms: number, extra: string[] = [], signal?: AbortSignal, timeoutMs = 10_000) =>
  runner.spawn({ ...context(`call-${pool}`, pool, signal), bin: "boxd", args: [pool, String(ms), ...extra], timeoutMs })

const code = (error: unknown) => (error instanceof BoxdError ? error.code : String(error))

describe("the caps", () => {
  test("300 foreground, 40 background, 20 exec and 10 import calls never pass 12 shared, 4 background, 4 exec and 2 import", async () => {
    const fake = fakeLaunch()
    const runner = createRunner({ launch: fake.launch })
    const all = [
      ...Array.from({ length: 300 }, () => spawnIn(runner, "foreground", 2)),
      ...Array.from({ length: 40 }, () => spawnIn(runner, "background", 3)),
      ...Array.from({ length: 20 }, () => spawnIn(runner, "exec", 5)),
      ...Array.from({ length: 10 }, () => spawnIn(runner, "import", 5)),
    ]
    const health = runner.health()
    expect(health.pools.foreground.running + health.pools.background.running).toBe(CAPS.shared)
    await Promise.all(all)
    expect((fake.peak.foreground ?? 0) + 0).toBeLessThanOrEqual(CAPS.shared)
    expect(fake.peak.background).toBeLessThanOrEqual(CAPS.background)
    expect(fake.peak.exec).toBe(CAPS.exec)
    expect(fake.peak.import).toBe(CAPS.import)
    expect(fake.totalPeak()).toBeLessThanOrEqual(CAPS.shared + CAPS.exec + CAPS.import)
    expect(runner.health().children).toMatchObject({ now: 0, cap: 18 })
    expect(runner.health().children.peak).toBeLessThanOrEqual(18)
    await runner.dispose()
  })

  test("the shared slots are shared: foreground and background together stay within 12", async () => {
    let shared = 0
    let peak = 0
    const fake = fakeLaunch()
    const launch: Launch = (bin, args, options) => {
      const child = fake.launch(bin, args, options)
      if (args[0] === "foreground" || args[0] === "background") {
        shared += 1
        peak = Math.max(peak, shared)
        child.on("close", () => { shared -= 1 })
      }
      return child
    }
    const runner = createRunner({ launch })
    await Promise.all([...Array.from({ length: 60 }, () => spawnIn(runner, "background", 4)), ...Array.from({ length: 60 }, () => spawnIn(runner, "foreground", 4))])
    expect(peak).toBe(CAPS.shared)
    await runner.dispose()
  })

  test("a freed shared slot goes to the foreground first, and a waiting background call is not starved", async () => {
    const fake = fakeLaunch()
    const runner = createRunner({ launch: fake.launch })
    const order: string[] = []
    const track = (name: string, promise: Promise<unknown>) => promise.then(() => void order.push(name))
    const foreground = Array.from({ length: 200 }, (_, index) => track(`f${index}`, spawnIn(runner, "foreground", 2)))
    const background = track("b", spawnIn(runner, "background", 2))
    await Promise.all([...foreground, background])
    const at = order.indexOf("b")
    // Started after at most 12 foreground grants beyond the first full set: well before the 200 drain.
    expect(at).toBeGreaterThanOrEqual(0)
    expect(at).toBeLessThan(40)
    await runner.dispose()
  })

  test("four long boxd_exec children delay no foreground or background child; a fifth waits in the exec pool", async () => {
    const fake = fakeLaunch()
    const runner = createRunner({ launch: fake.launch })
    const stop = new AbortController()
    const long = Array.from({ length: CAPS.exec }, () => spawnIn(runner, "exec", 60_000, ["forever"], stop.signal).catch(() => "stopped"))
    const fifth = spawnIn(runner, "exec", 1, ["fifth"], stop.signal).catch(() => "stopped")
    const started = Date.now()
    await Promise.all([spawnIn(runner, "foreground", 1), spawnIn(runner, "background", 1)])
    expect(Date.now() - started).toBeLessThan(500)
    expect(runner.health().pools.exec).toEqual({ running: CAPS.exec, queued: 1, cap: CAPS.exec })
    expect(fake.started.some((entry) => entry.args.includes("fifth"))).toBe(false)
    stop.abort()
    await Promise.all([...long, fifth])
    await runner.dispose()
  })

  test("the front of a pool's queue is first in, first out: a request sent to the front never jumps an earlier one there", async () => {
    const fake = fakeLaunch()
    const runner = createRunner({ launch: fake.launch })
    const blockers = Array.from({ length: CAPS.background }, () => spawnIn(runner, "background", 30))
    const order: string[] = []
    const queued = (name: string, front: boolean) =>
      runner.spawn({ ...context(name, "background"), bin: "boxd", args: ["background", "1", name], timeoutMs: 5_000, ...(front ? { front: true } : {}) }).then(() => void order.push(name))
    const all = [queued("back-1", false), queued("front-1", true), queued("back-2", false), queued("front-2", true), queued("front-3", true)]
    await Promise.all([...blockers, ...all])
    expect(fake.started.slice(CAPS.background).map((entry) => entry.args[2])).toEqual(["front-1", "front-2", "front-3", "back-1", "back-2"])
    await runner.dispose()
  })

  test("every child carries its call's tag, and a request in no pool runs in the foreground", async () => {
    const fake = fakeLaunch()
    const runner = createRunner({ launch: fake.launch })
    await runner.spawn({ call: { callId: "call_tagged", source: "boxd_job" }, bin: "boxd", args: ["foreground", "1"], timeoutMs: 1000 })
    expect(fake.started[0]!.env[CALL_TAG_ENV]).toBe("call_tagged")
    expect(fake.peak.foreground).toBe(1)
    await runner.dispose()
  })
})

describe("locks and flights", () => {
  test("300 queued items each change their own machine while a golden build holds its builder's lock: everything finishes", async () => {
    const fake = fakeLaunch()
    const runner = createRunner({ launch: fake.launch })
    const builder = { id: "vm_builder" as MachineId }
    // The build: three steps on its builder machine, each one child, the lock held throughout.
    const build = runner.singleFlight("golden:fra:2x8", () =>
      runner.withMachineLock(builder, context("build"), async () => {
        for (let step = 0; step < 3; step++) await spawnIn(runner, "foreground", 30)
        return "built"
      }),
    )
    const items = Array.from({ length: 300 }, async (_, index) => {
      // An item that needs the image waits for the build holding no lock and no slot, then works on its own machine.
      if (index % 3 === 0) expect(await runner.singleFlight("golden:fra:2x8", () => Promise.resolve("again"))).toBe("built")
      return runner.withMachineLock({ id: `vm_${index % 50}` as MachineId }, context(`item-${index}`), async () => {
        await spawnIn(runner, "foreground", 1)
        await spawnIn(runner, "foreground", 1)
        return index
      })
    })
    const results = await Promise.race([Promise.all([build, ...items]), Bun.sleep(20_000).then(() => "deadlock")])
    expect(results).not.toBe("deadlock")
    expect(fake.peak.foreground).toBeLessThanOrEqual(CAPS.shared)
    await runner.dispose()
  })

  test("two changes to one machine never overlap, and run in the order they asked", async () => {
    const runner = createRunner({ launch: fakeLaunch().launch })
    const events: string[] = []
    const key = { id: "vm_one" as MachineId }
    await Promise.all(
      ["a", "b", "c"].map((name) =>
        runner.withMachineLock(key, context(name), async () => {
          events.push(`${name}+`)
          await Bun.sleep(5)
          events.push(`${name}-`)
        }),
      ),
    )
    expect(events).toEqual(["a+", "a-", "b+", "b-", "c+", "c-"])
    await runner.dispose()
  })

  test("a lock is reentrant for its own machine and refuses a second machine at once, so no cycle can form", async () => {
    const runner = createRunner({ launch: fakeLaunch().launch })
    const one = { id: "vm_one" as MachineId }
    expect(await runner.withMachineLock(one, context("x"), () => runner.withMachineLock(one, context("x"), async () => runner.holds(one)))).toBe(true)
    await expect(runner.withMachineLock(one, context("x"), () => runner.withMachineLock({ id: "vm_two" as MachineId }, context("x"), async () => 1))).rejects.toThrow(/Lock order/)
    expect(runner.holds(one)).toBe(false)
    await runner.dispose()
  })

  test("a create's lock is keyed by region and name until boxd gives an id", async () => {
    const runner = createRunner({ launch: fakeLaunch().launch })
    const key = { create: { region: "fra" as const, name: "oc-a" as const } }
    expect(await runner.withMachineLock(key, context("x"), async () => [runner.holds(key), runner.holds({ create: { region: "nyc", name: "oc-a" } })])).toEqual([true, false])
    await runner.dispose()
  })

  test("a stopped call leaves the lock's queue, and the lock passes on", async () => {
    const runner = createRunner({ launch: fakeLaunch().launch })
    const key = { id: "vm_one" as MachineId }
    let release!: () => void
    const holder = runner.withMachineLock(key, context("holder"), () => new Promise<void>((resolve) => (release = resolve)))
    const stop = new AbortController()
    const waiting = runner.withMachineLock(key, context("waiter", "foreground", stop.signal), async () => "ran")
    const next = runner.withMachineLock(key, context("next"), async () => "next ran")
    await Bun.sleep(5)
    stop.abort()
    expect(code(await waiting.catch((error) => error))).toBe("CANCELLED")
    release()
    await holder
    expect(await next).toBe("next ran")
    await runner.dispose()
  })

  test("a single flight shares one answer between callers, and a later call starts a new one", async () => {
    const runner = createRunner({ launch: fakeLaunch().launch })
    let runs = 0
    const work = () => Bun.sleep(5).then(() => ++runs)
    expect(await Promise.all([runner.singleFlight("k", work), runner.singleFlight("k", work), runner.singleFlight("k", work)])).toEqual([1, 1, 1])
    expect(await runner.singleFlight("k", work)).toBe(2)
    await runner.dispose()
  })
})

describe("bounds and Stop", () => {
  test("a timeout sends SIGTERM, then SIGKILL after the grace, and answers TIMEOUT naming the command, never its input", async () => {
    const fake = fakeLaunch()
    const runner = createRunner({ launch: fake.launch, killGraceMs: 30 })
    const error = await runner.spawn({ ...context("t"), bin: "/usr/bin/boxd", args: ["machine", "exec", "oc-a", "--", "secret prompt", "forever", "ignore-term"], timeoutMs: 20 }).catch((caught) => caught)
    expect(code(error)).toBe("TIMEOUT")
    expect((error as BoxdError).what).toBe("boxd machine exec oc-a did not answer within 20 ms.")
    expect(fake.signals.map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGKILL"])
    expect(runner.health().children.now).toBe(0)
    await runner.dispose()
  })

  test("Stop mid-queue: queued children never start and answer CANCELLED with uncertain false", async () => {
    const fake = fakeLaunch()
    const runner = createRunner({ launch: fake.launch })
    const blockers = Array.from({ length: CAPS.shared }, () => spawnIn(runner, "foreground", 50))
    const stop = new AbortController()
    const queued = Array.from({ length: 20 }, () => spawnIn(runner, "foreground", 1, ["queued"], stop.signal))
    stop.abort()
    const answers = await Promise.all(queued.map((promise) => promise.then(() => "ran", (error: BoxdError) => [error.code, error.details.uncertain])))
    expect(answers).toEqual(Array.from({ length: 20 }, () => ["CANCELLED", false]))
    await Promise.all(blockers)
    expect(fake.started.filter((entry) => entry.args.includes("queued"))).toEqual([])
    expect(runner.health().pools.foreground.queued).toBe(0)
    await runner.dispose()
  })

  test("Stop mid-run: the running child is killed, answers CANCELLED with uncertain true, and its slot passes on", async () => {
    const fake = fakeLaunch()
    const runner = createRunner({ launch: fake.launch })
    const stop = new AbortController()
    const running = Array.from({ length: CAPS.shared }, () => spawnIn(runner, "foreground", 10_000, ["forever"], stop.signal))
    const after = spawnIn(runner, "foreground", 1)
    await Bun.sleep(5)
    stop.abort()
    const answers = await Promise.all(running.map((promise) => promise.then(() => "ran", (error: BoxdError) => [error.code, error.details.uncertain])))
    expect(answers.every((answer) => JSON.stringify(answer) === JSON.stringify(["CANCELLED", true]))).toBe(true)
    expect((await after).code).toBe(0)
    expect(fake.signals.filter((entry) => entry.signal === "SIGTERM")).toHaveLength(CAPS.shared)
    await runner.dispose()
  })

  test("an already stopped call starts nothing", async () => {
    const fake = fakeLaunch()
    const runner = createRunner({ launch: fake.launch })
    const stop = new AbortController()
    stop.abort()
    expect(code(await spawnIn(runner, "foreground", 1, [], stop.signal).catch((error) => error))).toBe("CANCELLED")
    expect(fake.started).toEqual([])
    await runner.dispose()
  })

  test("the output cap kills an over-large child", async () => {
    const fake = fakeLaunch()
    const runner = createRunner({ launch: fake.launch })
    const error = await runner.spawn({ ...context("big"), bin: "boxd", args: ["foreground", "1000", "print", "2048"], timeoutMs: 5000, stdoutCap: 1024 }).catch((caught) => caught)
    expect(code(error)).toBe("BOXD_FAILED")
    expect(fake.signals.map((entry) => entry.signal)).toEqual(["SIGTERM"])
    await runner.dispose()
  })

  test("a binary that cannot be run is BOXD_MISSING, and frees its slot", async () => {
    const runner = createRunner()
    const error = await runner.spawn({ ...context("missing"), bin: join(dir, "no-such-boxd"), args: [], timeoutMs: 5000 }).catch((caught) => caught)
    expect(code(error)).toBe("BOXD_MISSING")
    expect(runner.health().children.now).toBe(0)
    await runner.dispose()
  })

  test("dispose drops the queue and kills every running child", async () => {
    const fake = fakeLaunch()
    const runner = createRunner({ launch: fake.launch })
    const running = Array.from({ length: CAPS.shared }, () => spawnIn(runner, "foreground", 10_000, ["forever"]).catch((error: BoxdError) => error.code))
    const queued = spawnIn(runner, "foreground", 1).catch((error: BoxdError) => error.code)
    await runner.dispose()
    expect(await Promise.all(running)).toEqual(Array.from({ length: CAPS.shared }, () => "CANCELLED"))
    expect(await queued).toBe("CANCELLED")
    expect(code(await spawnIn(runner, "foreground", 1).catch((error) => error))).toBe("CANCELLED")
  })

  test("a real child's own children die with it on Stop: the kill reaches its process group", async () => {
    const runner = createRunner({ killGraceMs: 200 })
    const pidFile = join(dir, "grandchild.pid")
    const stop = new AbortController()
    const run = runner.spawn({ ...context("tree", "foreground", stop.signal), bin: "sh", args: ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], timeoutMs: 30_000 })
    for (let tries = 0; tries < 200 && !existsSync(pidFile); tries++) await Bun.sleep(10)
    const grandchild = Number(readFileSync(pidFile, "utf8"))
    stop.abort()
    expect(code(await run.catch((error) => error))).toBe("CANCELLED")
    expect(await stillRunning([grandchild])).toEqual([])
    await runner.dispose()
  }, 30_000)

  test("health reports the event loop's worst delay while children run", async () => {
    const runner = createRunner({ launch: fakeLaunch().launch, loopSampleMs: 10 })
    const run = spawnIn(runner, "foreground", 120)
    await Bun.sleep(30)
    const until = Date.now() + 60
    while (Date.now() < until) {
      // Block the loop on purpose.
    }
    await run
    expect(runner.health().loopLagMaxMs).toBeGreaterThanOrEqual(40)
    await runner.dispose()
  })
})

describe("the read rule", () => {
  const listing = (status: string, takenAt: number, id: string | null = null) => ({
    takenAt,
    fresh: false,
    machines: [{ name: "oc-a", region: "fra" as const, id: id as MachineId | null, status: status as "running", size: null, labels: {}, sharing: "private" as const, isolated: null }],
  })
  const target = (status: string, takenAt: number, id: string | null = null): ReadTarget => ({ region: "fra", name: "oc-a", listing: listing(status, takenAt, id), machineId: "vm_a" as MachineId })

  test("a running machine in a listing at most 2 s old passes", () => {
    const runner = createRunner({ now: () => 10_000 })
    expect(() => runner.assertReadable(target("running", 8_000))).not.toThrow()
  })

  test("an older listing is refused, so a read never trusts a stale running", () => {
    const runner = createRunner({ now: () => 10_000 })
    expect(() => runner.assertReadable(target("running", 7_999))).toThrow(/at most 2 s old/)
  })

  test("a machine that is not running, or not listed in its region, is MACHINE_ASLEEP, so a read never wakes it", () => {
    const runner = createRunner({ now: () => 10_000 })
    for (const status of ["hibernated", "standby", "starting", "stopped"]) {
      const error = (() => {
        try {
          runner.assertReadable(target(status, 9_500))
        } catch (caught) {
          return caught as BoxdError
        }
      })()
      expect([status, error?.code, error?.details.status]).toEqual([status, "MACHINE_ASLEEP", status])
    }
    const elsewhere: ReadTarget = { ...target("running", 9_500), region: "nyc" }
    expect(() => runner.assertReadable(elsewhere)).toThrow(/not in the nyc listing/)
  })

  test("once the listing carries ids, a name that points at another machine is NOT_OURS", () => {
    const runner = createRunner({ now: () => 10_000 })
    expect(() => runner.assertReadable(target("running", 9_500, "vm_other"))).toThrow(/NOT_OURS/)
    expect(() => runner.assertReadable(target("running", 9_500, "vm_a"))).not.toThrow()
  })
})
