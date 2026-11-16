// A failed `machine list` is a listing failure, never a guest failure (review of #23, round 2, MEDIUM-1): status, the
// watcher and boxd_job keep each work's last known phase, count no failure toward `unreachable`, and still answer.
// And package E's real cost and cleanup providers, as status and the TUI render them.
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import { cleanupView } from "../../src/cleanup.js"
import { jobRun } from "../../src/fleet/job.js"
import { sessionRuns } from "../../src/fleet/sessions.js"
import { fleetStatus, statusInput } from "../../src/fleet/status.js"
import type { JobResult, ListResult } from "../../src/results.js"
import { cleanupText } from "../../src/tui.js"
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

describe("package E's real providers", () => {
  test("status renders E's cost and cleanup blocks, and the TUI renders E's cleanup view", async () => {
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
    const view = await cleanupView({ ...w.services, actions: sessionRuns(w.services).actions }).view({ callId: "view", source: "cleanup-command" })
    expect(view.state).toBe("ok")
    const text = cleanupText(view)
    expect(text).toContain("- finished: idle")
    expect(text).toContain("/boxd-cleanup asks you to confirm each action with a permission prompt.")
  })
})
