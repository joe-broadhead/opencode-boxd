// A failed `machine list` is a listing failure, never a guest failure (review of #23, round 2, MEDIUM-1): status, the
// watcher and boxd_job keep each work's last known phase, count no failure toward `unreachable`, and still answer.
// And package E's real cost and cleanup providers, as status and the TUI render them.
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import type { BoxdError } from "../../src/errors.js"
import { notReadYet } from "../../src/fleet/ensure.js"
import { notRead } from "../../src/fleet/model.js"
import { jobRun } from "../../src/fleet/job.js"
import { fleetStatus, statusInput } from "../../src/fleet/status.js"
import type { JobResult, ListResult, Refusal } from "../../src/results.js"
import { watchHandle } from "../../src/watch.js"
import { startWorld, type World } from "../support/fleet-world.js"

// A world is real processes on a shared machine: give each test room beyond bun's 5 s default.
setDefaultTimeout(30_000)

let world: World | undefined
afterEach(async () => {
  await world?.dispose()
  world = undefined
})

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, index) => `${prefix}-${index}`)
const fault = (w: World, times = 3) => {
  for (let index = 0; index < times; index++) w.counter.fake.fault("machine list", { stderr: "error: network unreachable", code: 1 })
}
const later = (w: World, ms: number) => void (w.clock.now = new Date(w.clock.now.getTime() + ms))

/** Busy works with the helper installed, at a CLI latency that makes reads queue past their listing. */
async function busyFleet(w: World, prefix: string, n: number) {
  const works = ids(prefix, n)
  await w.bulk(works.map((workId) => ({ workId })))
  w.installHelper(await w.work("seed"), works)
  await w.record("seed", (record) => ({ ...record, state: "closed" }))
  return works
}

describe("boxd_job", () => {
  test("its own listing fails: each work answers its last known phase, with nothing read and the reason in next", async () => {
    world = await startWorld()
    const w = world
    await w.bulk([{ workId: "a", run: { outcome: "completed", at: "2026-11-16T10:00:01.000Z" } }, { workId: "b" }])
    fault(w)
    const single = (await jobRun(w.services, { workId: "a" }, { tag: { callId: "one", source: "boxd_job" } })) as JobResult
    expect(single).toMatchObject({ state: "idle", workId: "a" })
    expect(single.error).toBeUndefined()
    expect(single.next).toContain("The machine listing failed")
    fault(w)
    const many = (await jobRun(w.services, { works: ["a", "b"] }, { tag: { callId: "many", source: "boxd_job" } })) as ListResult<JobResult>
    expect(many.state).toBe("done")
    expect(many.results.map((result) => [result.state, (result as JobResult).error ?? null])).toEqual([
      ["idle", null],
      ["busy", null],
    ])
    expect(w.counter.spawns().filter((spawn) => spawn.verb === "machine exec")).toEqual([])
  })

  test("a refresh that fails while its reads queue: no work unreachable, no failure counted", async () => {
    world = await startWorld({ latencyMs: [300, 300] })
    const w = world
    const works = await busyFleet(w, "j", 40)
    setTimeout(() => fault(w), 1_000)
    const answer = (await jobRun(w.services, { works }, { tag: { callId: "job", source: "boxd_job" } })) as ListResult<JobResult>
    const results = answer.results as JobResult[]
    expect(results.filter((result) => result.state === "unreachable" || result.error === "BOXD_FAILED")).toEqual([])
    const handle = watchHandle(w.services.watch)!
    expect(works.filter((id) => (handle.observed(id)?.failures ?? 0) > 0)).toEqual([])
  }, 180_000)
})

describe("a signed-out CLI fails at once", () => {
  const SIGNED_OUT = { stderr: "Not logged in. Run `boxd auth login` first.", code: 1 }

  test("boxd_job answers BOXD_MISSING, single and list, not the last known phase", async () => {
    world = await startWorld()
    const w = world
    await w.bulk([{ workId: "a", run: { outcome: "completed", at: "2026-11-16T10:00:01.000Z" } }, { workId: "b" }])
    w.counter.fake.fault("machine list", SIGNED_OUT)
    const single = await jobRun(w.services, { workId: "a" }, { tag: { callId: "one", source: "boxd_job" } }).then(
      () => undefined,
      (error: unknown) => error as BoxdError,
    )
    expect(single?.code).toBe("BOXD_MISSING")
    w.counter.fake.fault("machine list", SIGNED_OUT)
    const many = (await jobRun(w.services, { works: ["a", "b"] }, { tag: { callId: "many", source: "boxd_job" } })) as ListResult<JobResult>
    expect(many.state).toBe("failed")
    expect(many.results.map((result) => [result.state, (result as unknown as Refusal).error])).toEqual([
      ["unreachable", "BOXD_MISSING"],
      ["unreachable", "BOXD_MISSING"],
    ])
  })

  test("a read's refresh while signed out is the CLI's own refusal: not retryable, not a read to wait out", async () => {
    world = await startWorld()
    const w = world
    const record = await w.work("signed-out")
    const listing = await w.services.boxd.list({ maxAgeMs: 0 }, w.context("warm"))
    const old = { ...listing, takenAt: listing.takenAt - 5_000 }
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    w.counter.fake.fault("machine list", SIGNED_OUT)
    w.counter.reset()
    const refused = await w.services.boxd
      .exec({ region: "fra", name: record.machine, listing: old, machineId: record.machineId }, "true", { timeoutSeconds: 5, json: false }, w.context("read", "boxd_job"))
      .then(
        () => undefined,
        (error: unknown) => error as BoxdError,
      )
    expect(refused?.code).toBe("BOXD_MISSING")
    expect([refused?.details.kind, refused?.details.retryable]).toEqual(["auth", undefined])
    expect(notRead(refused)).toBe(false)
    expect(notReadYet(refused)).toBe(false)
    expect(w.counter.spawns().filter((spawn) => spawn.verb === "machine exec")).toEqual([])
    // A transient failure of the same refresh is a read to wait out.
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    w.counter.fake.fault("machine list", { stderr: "error: network unreachable", code: 1 })
    const transient = await w.services.boxd
      .exec({ region: "fra", name: record.machine, listing: old, machineId: record.machineId }, "true", { timeoutSeconds: 5, json: false }, w.context("read2", "boxd_job"))
      .then(
        () => undefined,
        (error: unknown) => error as BoxdError,
      )
    expect([transient?.code, transient?.details.kind, transient?.details.retryable]).toEqual(["BOXD_FAILED", "listing-failed", true])
    expect([notRead(transient), notReadYet(transient)]).toEqual([true, true])
  })
})

describe("the watcher", () => {
  test("a refresh that fails during a sweep's reads: no unreachable event, no failure counted", async () => {
    world = await startWorld({ latencyMs: [300, 300] })
    const w = world
    const works = await busyFleet(w, "s", 40)
    const seen: string[] = []
    w.watcher.watch.subscribe((event) => seen.push(`${event.to}/${event.code ?? "-"}`))
    setTimeout(() => fault(w), 1_000)
    await w.watcher.tick()
    expect(seen.filter((item) => item.startsWith("unreachable") || item.includes("BOXD_FAILED"))).toEqual([])
    const handle = watchHandle(w.services.watch)!
    expect(works.filter((id) => (handle.observed(id)?.failures ?? 0) > 0)).toEqual([])
  }, 180_000)

  test("the sweep's own listing fails: the sweep is skipped, nothing changes, and the next one runs", async () => {
    world = await startWorld()
    const w = world
    await w.work("busy-one", { busy: true })
    const seen: string[] = []
    w.watcher.watch.subscribe((event) => seen.push(event.to))
    fault(w, 1)
    await w.watcher.tick()
    expect(seen).toEqual([])
    expect(w.watcher.handle.health().watcher).toContain("failed 1 time in a row")
    later(w, 61_000)
    await w.watcher.tick()
    expect(seen).toEqual(["busy"])
    expect(w.watcher.handle.health().watcher).toBeUndefined()
  })
})

describe("the real cost provider", () => {
  test("status renders E's cost block", async () => {
    world = await startWorld({ cost: "real" })
    const w = world
    await w.work("finished")
    await w.record("finished", (record) => ({ ...record, run: { outcome: "completed", at: "2026-11-16T10:00:01.000Z" } }))
    await w.watcher.tick()
    const answer = await fleetStatus(w.services, statusInput({ include: ["cost"] }), { tag: { callId: "status", source: "boxd_status" }, guestReads: true })
    expect(answer.cost.currency).not.toBe("unknown")
    expect(answer.cost.today.unavailable ?? "").not.toContain("cost service is not available")
    expect(answer.cost.perHour.running).toBe(1)
    expect(answer.cost.works?.map((work) => work.workId)).toEqual(["finished"])
    expect(Array.isArray(answer.cleanup)).toBe(true)
    expect(answer.automation).toBe("on")
  })
})
