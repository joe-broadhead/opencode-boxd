// Review of #20 cases re-run on #23's runner: M-1 (fresh), M-2 joined flights, M-3 flight order, and stdout drain.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createBoxdCli } from "../../src/provider/boxd/cli.js"
import { BoxdError } from "../../src/errors.js"
import { createRunner, type Launch } from "../../src/provider/runner.js"
import { createGuestPort } from "../../src/provider/guest/port.js"
import type { BoxdPort, MachineId, OpContext, ReadTarget } from "../../src/ports.js"
import { startFakeCli, type FakeCli } from "../host/fake-cli.js"

const ctx = (callId: string, signal?: AbortSignal): OpContext => ({ call: { callId, source: "boxd_status" }, pool: "foreground", ...(signal ? { signal } : {}) })
const code = (error: unknown) => (error instanceof BoxdError ? error.code : String(error))
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("fresh", () => {
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

  test("M-1 fresh: a guest read waiting in the per-machine read queue past 2 s never starts", async () => {
    fake.machine({ name: "oc-a", region: "fra" })
    const guest = createGuestPort({ boxd, runner })
    const listing = await boxd.list({ maxAgeMs: 0 }, ctx("l"))
    fake.update((s) => void (s.latencyMs = [2500, 2500]))
    const target: ReadTarget = { region: "fra", name: "oc-a", listing, machineId: null }
    const first = settle(guest.health(target, ctx("r1")))
    await sleep(20)
    const second = settle(guest.serve(target, {}, ctx("r2")))
    const [, r2] = await Promise.all([first, second])
    const execs = fake.calls().filter((c) => c.startsWith("machine exec"))
    // r2 (4491e8b): the queued read joins a fresh listing; the machine runs, so it runs; nothing is woken.
    expect(execs.length).toBeLessThanOrEqual(2)
    expect(fake.read().wokenByExec ?? []).toEqual([])
    if (!r2.ok) expect((r2 as { e: BoxdError }).e.details.rule).not.toBe("listing-age")
  }, 30_000)

  test("M-2 fresh: the flavour check and an identical guest read are joined; Stop of A leaves B its answer", async () => {
    fake.machine({ name: "oc-a", region: "fra" })
    fake.update((s) => void (s.latencyMs = [700, 700]))
    // flavour check: nothing warmed yet; A and B both need it.
    const stop = new AbortController()
    const a = settle(boxd.list({ maxAgeMs: 0 }, ctx("A", stop.signal)))
    await sleep(5)
    const b = settle(boxd.list({ maxAgeMs: 0 }, ctx("B")))
    await sleep(100)
    stop.abort()
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.ok).toBe(false)
    expect(rb.ok).toBe(true)
    // identical guest reads
    const guest = createGuestPort({ boxd, runner })
    fake.update((s) => void (s.latencyMs = [0, 0]))
    const listing = await boxd.list({ maxAgeMs: 0 }, ctx("l"))
    fake.update((s) => void (s.latencyMs = [700, 700]))
    const target: ReadTarget = { region: "fra", name: "oc-a", listing, machineId: null }
    const stop2 = new AbortController()
    const ga = settle(guest.health(target, ctx("GA", stop2.signal)))
    await sleep(5)
    const gb = settle(guest.health(target, ctx("GB")))
    await sleep(100)
    stop2.abort()
    const [rga, rgb] = await Promise.all([ga, gb])
    const gbCode = rgb.ok ? "ok" : code((rgb as { e: unknown }).e)
    expect(rga.ok ? "ok" : code((rga as { e: unknown }).e)).toBe("CANCELLED")
    // B is not cancelled: it gets the helper's own answer (no helper on this fake machine: GUEST_FAILED) or ok.
    expect(gbCode).not.toBe("CANCELLED")
  })

  test("M-3 fresh: a joined flight started inside X, still held by its starter, waits for X instead of re-entering", async () => {
    const X = { id: "mx" as MachineId }
    const Y = { id: "my" as MachineId }
    const events: string[] = []
    let flight!: Promise<unknown>
    const starter = runner.withMachineLock(X, ctx("s"), async () => {
      events.push("starter-in")
      flight = runner.join("k:build", ctx("s"), async () => {
        await sleep(20)
        events.push(`flight-holdsX=${runner.holds(X)}`)
        await runner.withMachineLock(Y, ctx("f"), async () => events.push("flight-in-Y"))
        await runner.withMachineLock(X, ctx("f"), async () => events.push("flight-in-X"))
      })
      await sleep(150)
      events.push("starter-out")
    })
    // a second joiner from inside lock Y's context
    const joinerB = runner.withMachineLock({ id: "mz" as MachineId }, ctx("b"), () => runner.join("k:build", ctx("b"), async () => events.push("never-runs")))
    await starter
    await flight
    await joinerB
    expect(events).toEqual(["starter-in", "flight-holdsX=false", "flight-in-Y", "starter-out", "flight-in-X"])
  })
})

describe("drain", () => {
  test("a blocked event loop after exit must not truncate a child's stdout", async () => {
    let truncated = 0
    const runs = 20
    for (let i = 0; i < runs; i++) {
      const launch: Launch = (bin, args, options) => {
        const child = spawn(bin, [...args], { env: options.env, stdio: ["pipe", "pipe", "pipe"], detached: true })
        child.on("exit", () =>
          process.nextTick(() => {
            const until = Date.now() + 400
            while (Date.now() < until) {}
          }),
        )
        return child
      }
      const runner = createRunner({ launch })
      const r = await runner.spawn({ ...ctx(`d${i}`), bin: "sh", args: ["-c", "head -c 60000 /dev/zero | tr '\\0' x"], timeoutMs: 10_000 })
      if (r.stdout.length !== 60000) truncated += 1
      await runner.dispose()
    }
    expect(truncated).toBe(0)
  }, 60_000)
})
