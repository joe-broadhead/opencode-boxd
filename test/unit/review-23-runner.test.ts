// Review of #23, round 2: the read refresh in the runner and the CLI port (M-1, no stampede, Stop and dispose during a refresh, a refresh whose listing fails).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createBoxdCli } from "../../src/boxd/cli.js"
import { BoxdError } from "../../src/errors.js"
import { createRunner } from "../../src/exec/runner.js"
import { notRead } from "../../src/fleet/model.js"
import type { BoxdPort, OpContext, ReadTarget } from "../../src/ports.js"
import { startFakeCli, type FakeCli } from "../host/fake-cli.js"

const ctx = (callId: string, signal?: AbortSignal, pool: OpContext["pool"] = "background"): OpContext => ({ call: { callId, source: "boxd_status" }, pool, ...(signal ? { signal } : {}) })
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const lists = (fake: FakeCli) => fake.calls().filter((c) => c.startsWith("machine list")).length

describe("r2 runner", () => {
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

  test("no stampede: 40 queued background reads at 400 ms each take about one listing per 2 s window", async () => {
    for (let i = 0; i < 40; i++) fake.machine({ name: `oc-m${i}`, region: "fra" })
    const listing = await boxd.list({ maxAgeMs: 0 }, ctx("l"))
    fake.update((s) => void (s.latencyMs = [400, 400]))
    const before = lists(fake)
    const t0 = Date.now()
    const reads = Array.from({ length: 40 }, (_, i) => settle(boxd.exec({ region: "fra", name: `oc-m${i}`, listing, machineId: null } as ReadTarget, "true", { timeoutSeconds: 5, json: false }, ctx(`r${i}`))))
    const answers = await Promise.all(reads)
    const ms = Date.now() - t0
    const n = lists(fake) - before
    expect(answers.every((a) => a.ok)).toBe(true)
    // One listing per 2 s window of reads, plus one: never one per read.
    expect(n).toBeLessThanOrEqual(Math.ceil(ms / 2000) + 1)
    expect(fake.read().wokenByExec ?? []).toEqual([])
  }, 60_000)

  test("M-1: a refreshed listing that shows the machine in standby refuses not-readable; nothing runs, nothing wakes", async () => {
    fake.machine({ name: "oc-a", region: "fra" })
    const listing = await boxd.list({ maxAgeMs: 0 }, ctx("l"))
    const blockers = Array.from({ length: 4 }, (_, i) => runner.spawn({ ...ctx(`b${i}`), bin: "sleep", args: ["2.5"], timeoutMs: 10_000 }))
    await sleep(50)
    const read = settle(boxd.exec({ region: "fra", name: "oc-a", listing, machineId: null }, "true", { timeoutSeconds: 5, json: false }, ctx("r")))
    fake.update((s) => void (s.machines.find((m) => m.name === "oc-a")!.status = "standby"))
    await Promise.all(blockers)
    const answer = await read
    expect(answer.ok).toBe(false)
    const error = (answer as { e: BoxdError }).e
    expect([error.code, error.details.kind]).toEqual(["MACHINE_ASLEEP", "not-readable"])
    expect(notRead(error)).toBe(true)
    expect(fake.calls().filter((c) => c.startsWith("machine exec"))).toEqual([])
    expect(fake.read().wokenByExec ?? []).toEqual([])
  }, 30_000)

  test("a refresh whose listing fails: what the read answers, and whether status would count it as a guest failure", async () => {
    fake.machine({ name: "oc-a", region: "fra" })
    const listing = await boxd.list({ maxAgeMs: 0 }, ctx("l"))
    const blockers = Array.from({ length: 4 }, (_, i) => runner.spawn({ ...ctx(`b${i}`), bin: "sleep", args: ["2.5"], timeoutMs: 10_000 }))
    await sleep(50)
    const read = settle(boxd.exec({ region: "fra", name: "oc-a", listing, machineId: null }, "true", { timeoutSeconds: 5, json: false }, ctx("r")))
    fake.fault("machine list", { stderr: "error: network unreachable", code: 1 })
    await Promise.all(blockers)
    const answer = await read
    const error = (answer as { ok: false; e: BoxdError }).e
    expect(answer.ok).toBe(false)
    expect(fake.calls().filter((c) => c.startsWith("machine exec"))).toEqual([])
    // A failed refresh is a read not made: stale, never a guest failure.
    expect(notRead(error)).toBe(true)
  }, 30_000)

  test("Stop during a refresh: that read answers CANCELLED (not a failure); a joiner of the same refresh still runs", async () => {
    fake.machine({ name: "oc-a", region: "fra" })
    const listing = await boxd.list({ maxAgeMs: 0 }, ctx("l"))
    fake.update((s) => void (s.latencyMs = [1500, 1500]))
    await sleep(2100)
    const stop = new AbortController()
    const a = settle(boxd.exec({ region: "fra", name: "oc-a", listing, machineId: null }, "true", { timeoutSeconds: 5, json: false }, ctx("A", stop.signal)))
    await sleep(10)
    const b = settle(boxd.exec({ region: "fra", name: "oc-a", listing, machineId: null }, "true", { timeoutSeconds: 5, json: false }, ctx("B")))
    await sleep(200)
    stop.abort()
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.ok).toBe(false)
    expect(notRead((ra as { e: unknown }).e)).toBe(true)
    expect(rb.ok).toBe(true)
  }, 30_000)

  test("dispose during a refresh: every queued read settles CANCELLED, nothing hangs", async () => {
    for (let i = 0; i < 12; i++) fake.machine({ name: `oc-d${i}`, region: "fra" })
    const listing = await boxd.list({ maxAgeMs: 0 }, ctx("l"))
    fake.update((s) => void (s.latencyMs = [1500, 1500]))
    await sleep(2100)
    const reads = Array.from({ length: 12 }, (_, i) => settle(boxd.exec({ region: "fra", name: `oc-d${i}`, listing, machineId: null }, "true", { timeoutSeconds: 5, json: false }, ctx(`d${i}`))))
    await sleep(300)
    const t0 = Date.now()
    await runner.dispose()
    const answers = await Promise.all(reads)
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(answers.every((a) => !a.ok && (a.e as BoxdError).code === "CANCELLED")).toBe(true)
  }, 30_000)

  test("a stale listing and a stopped machine: refused not-readable, no exec", async () => {
    // Read path only: a ReadTarget with a stale listing and a stopped machine is refused before any spawn.
    fake.machine({ name: "oc-s", region: "fra", status: "stopped" })
    const listing = await boxd.list({ maxAgeMs: 0 }, ctx("l"))
    const before = lists(fake)
    const r = await settle(boxd.exec({ region: "fra", name: "oc-s", listing: { ...listing, takenAt: listing.takenAt - 5000 }, machineId: null }, "true", { timeoutSeconds: 5, json: false }, ctx("s")))
    expect(r.ok).toBe(false)
    expect(((r as { e: BoxdError }).e).details.kind).toBe("not-readable")
    expect(lists(fake) - before).toBeLessThanOrEqual(1)
    expect(fake.calls().filter((c) => c.startsWith("machine exec"))).toEqual([])
  }, 30_000)
})
