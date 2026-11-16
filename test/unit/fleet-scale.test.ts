// Many busy works at a realistic CLI latency (review of #23, HIGH-1): reads that queue past their 2 s listing join a
// fresh shared listing instead of failing, so status, one watcher sweep and a 60-item boxd_job never turn a work
// `unreachable` or `BOXD_FAILED`; the reads that did not fit status's budget are `stale`; and the reads cost one
// listing per 2 s window (design §4.4).
import { afterEach, describe, expect, test } from "bun:test"
import { jobRun } from "../../src/fleet/job.js"
import { fleetStatus, statusInput } from "../../src/fleet/status.js"
import type { JobResult, ListResult } from "../../src/results.js"
import { watchHandle } from "../../src/watch.js"
import { startWorld, type World } from "../support/fleet-world.js"

let world: World | undefined
afterEach(async () => {
  await world?.dispose()
  world = undefined
})

const LATENCY: readonly [number, number] = [300, 300]
const status = (w: World, input: Record<string, unknown>, callId: string) => fleetStatus(w.services, statusInput(input), { tag: { callId, source: "boxd_status" }, guestReads: true })
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, index) => `${prefix}-${index}`)
/** At most one listing per 2 s window of reads, and one to start. */
const listsFor = (ms: number) => Math.ceil(ms / 2_000) + 1

describe("170 busy works at 300 ms per CLI call", () => {
  test("status: no unreachable, no BOXD_FAILED, the unread works stale, one listing per 2 s window", async () => {
    world = await startWorld({ latencyMs: LATENCY })
    const w = world
    const busy = ids("b", 170)
    // Busy by their record: a prompt after the last run. The helper is on every machine.
    await w.bulk(busy.map((workId) => ({ workId })))
    w.installHelper(await w.work("seed"), busy)
    await w.record("seed", (record) => ({ ...record, state: "closed" }))
    w.counter.reset()
    const started = Date.now()
    const answer = await status(w, { view: "all", limit: 300 }, "call_status")
    const took = Date.now() - started
    const handle = watchHandle(w.services.watch)!
    const phases = busy.map((id) => handle.observed(id))
    expect(phases.filter((item) => item?.phase === "unreachable")).toEqual([])
    expect(phases.filter((item) => item?.code === "BOXD_FAILED")).toEqual([])
    expect(answer.works!.filter((work) => work.phase === "unreachable")).toEqual([])
    const read = phases.filter((item) => item?.readAt !== undefined).length
    const stale = answer.works!.filter((work) => work.stale).length
    expect(read).toBeGreaterThan(0)
    expect(read + stale).toBe(busy.length)
    const counts = w.counter.count("call_status")
    expect(counts["machine list"] ?? 0).toBeLessThanOrEqual(listsFor(took))
    expect(w.counter.fake.read().wokenByExec ?? []).toEqual([])
  }, 180_000)

  test("one watcher sweep: every busy work read, no unreachable event, no BOXD_FAILED in a notice", async () => {
    world = await startWorld({ latencyMs: LATENCY })
    const w = world
    const busy = ids("s", 170)
    w.sessions.add("ses_coord")
    await w.bulk(busy.map((workId) => ({ workId, session: { rootId: `ses_${workId.replace(/-/g, "_")}`, notify: "ses_coord" } })))
    w.installHelper(await w.work("seed"), busy)
    await w.record("seed", (record) => ({ ...record, state: "closed" }))
    // Each work starts busy in the log, so every later change is news for its coordinator.
    for (const workId of busy) await w.ledger.appendEvent({ at: w.clock.now.toISOString(), workId, from: "ready", to: "busy" }, w.context("submit", "boxd_submit"))
    const seen: string[] = []
    w.watcher.watch.subscribe((event) => seen.push(`${event.to}/${event.code ?? "-"}`))
    w.counter.reset()
    const started = Date.now()
    await w.watcher.tick()
    const took = Date.now() - started
    await w.watcher.flushNotices()
    expect(seen.filter((item) => item.startsWith("unreachable") || item.includes("BOXD_FAILED"))).toEqual([])
    const handle = watchHandle(w.services.watch)!
    // Every one of the 170 works was read: a queued read whose listing aged joined a fresh one and ran.
    expect(busy.filter((id) => handle.observed(id)?.readAt === undefined)).toEqual([])
    const lists = w.counter.spawns().filter((spawn) => spawn.verb === "machine list").length
    expect(lists).toBeLessThanOrEqual(listsFor(took))
    for (const post of w.sessions.posted) {
      expect(post.text).not.toContain("BOXD_FAILED")
      expect(post.text).not.toContain("unreachable")
    }
  }, 900_000)
})

test("boxd_job over 60 running works at 300 ms per CLI call: every work read, none unreachable", async () => {
  world = await startWorld({ latencyMs: LATENCY })
  const w = world
  const works = ids("j", 60)
  await w.bulk(works.map((workId) => ({ workId, run: { outcome: "completed" as const, at: "2026-11-16T10:00:01.000Z" } })))
  w.installHelper(await w.work("seed"), works)
  w.counter.reset()
  const started = Date.now()
  const answer = (await jobRun(w.services, { works }, { tag: { callId: "job", source: "boxd_job" } })) as ListResult<JobResult>
  const took = Date.now() - started
  const results = answer.results as JobResult[]
  expect(answer.state).toBe("done")
  expect(results.filter((result) => result.state === "unreachable" || result.error === "BOXD_FAILED")).toEqual([])
  const counts = w.counter.count("job")
  expect(counts["machine exec"]).toBe(works.length)
  expect(counts["machine list"] ?? 0).toBeLessThanOrEqual(listsFor(took))
}, 180_000)
