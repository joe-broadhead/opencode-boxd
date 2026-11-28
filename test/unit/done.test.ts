// The done report: what the guest declares with `boxd_done`, what the laptop reads, keeps and clears, and where it
// shows (job, status, the works list and the idle event). The report is guest data: its summary is cut and redacted,
// its pull request references are checked, and it is never instructions.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { harvestWork } from "../../src/fleet/harvest.js"
import { jobRun } from "../../src/fleet/job.js"
import { sleepWork } from "../../src/fleet/sleep.js"
import { fleetStatus, statusInput, workList } from "../../src/fleet/status.js"
import { submitWork } from "../../src/fleet/submit.js"
import type { DoneReport } from "../../src/ports.js"
import type { JobResult, StatusResult } from "../../src/results.js"
import { createWatch } from "../../src/watch.js"
import { startWorld, type World } from "../support/fleet-world.js"

// A world is real processes on a shared machine: give each test room beyond bun's 5 s default.
setDefaultTimeout(30_000)

const report = (at: string, summary = "The task is finished and its tests pass.", prs = ["https://github.com/example/repo/pull/7"]): DoneReport => ({ at, summary, prs })

/** Makes a work's guest answer with a done report whenever its whole tree is idle, as the guest helper will (#78). */
function reportsDone(world: World, workId: string, done: DoneReport): void {
  const real = world.services.guest.phase
  world.services.guest.phase = async (target, input, op) => {
    const answer = await real(target, input, op)
    return target.name === `oc-${workId}` && answer.phase === "idle" ? { ...answer, done } : answer
  }
}

/** Makes a work's export carry the report in its run, as the guest helper will (#78). */
function exportsDone(world: World, workId: string, done: DoneReport): void {
  const real = world.services.guest.export
  world.services.guest.export = async (target, input, op) => {
    const answer = await real(target, input, op)
    return answer.outcome === "exported" && target.name === `oc-${workId}` ? { ...answer, run: { ...answer.run, done } } : answer
  }
}

describe("the done report in a work", () => {
  let world: World
  beforeEach(async () => {
    world = await startWorld()
  })
  afterEach(async () => {
    await world.dispose()
  })

  const job = (input: Record<string, unknown>, callId = "done_job") => jobRun(world.services, input, { tag: { callId, source: "boxd_job" } })
  const status = (input: Record<string, unknown> = { view: "all" }, callId = "done_status") =>
    fleetStatus(world.services, statusInput(input), { tag: { callId, source: "boxd_status" }, guestReads: true })
  const at = (offsetMs = 1_000) => new Date(world.clock.now.getTime() + offsetMs).toISOString()

  test("job answers done true with the summary and prs, and false for a work that declared nothing", async () => {
    await world.work("finished", { busy: true })
    await world.work("plain")
    const done = report(at())
    reportsDone(world, "finished", done)
    world.guest.complete("ses_finished")
    const answer = (await job({ workId: "finished" })) as JobResult
    expect(answer).toMatchObject({ state: "idle", done: true, summary: done.summary, prs: done.prs })
    const plain = (await job({ workId: "plain" })) as JobResult
    expect(plain.done).toBe(false)
    expect(plain.summary).toBeUndefined()
    expect(plain.prs).toBeUndefined()
  })

  test("status and the works list show the report; a done, unsaved work's attention says so", async () => {
    await world.work("finished", { busy: true })
    const done = report(at())
    reportsDone(world, "finished", done)
    world.guest.complete("ses_finished")
    const answer = (await status()) as StatusResult
    expect(answer.works).toEqual([expect.objectContaining({ workId: "finished", phase: "idle", done })])
    const needs = (await status({ view: "attention" }, "done_attention")) as StatusResult
    expect(needs.attention).toEqual([expect.objectContaining({ workId: "finished", why: "done-unsaved", next: 'boxd_harvest({ workId: "finished" })' })])
    const list = workList(answer.works ?? [])
    expect(list.data.items).toEqual([expect.objectContaining({ id: "finished", text: "idle, completed, done" })])
  })

  test("the record keeps the report after sleep and harvest, and a new submit clears it", async () => {
    await world.work("kept")
    const done = report(at())
    reportsDone(world, "kept", done)
    const seen = (await job({ workId: "kept" })) as JobResult
    expect(seen.done).toBe(true)
    await sleepWork(world.services, { workId: "kept" }, { op: world.context("sleep", "boxd_sleep"), by: "tool" })
    expect((await world.ledger.get("kept", world.context("read")))?.done).toEqual(done)

    const newer = report(at(2_000), "The task is finished again, with the review changes.")
    exportsDone(world, "kept", newer)
    await harvestWork(world.services, { workId: "kept", files: [], partial: false }, { op: world.context("harvest", "boxd_harvest"), by: "tool" })
    expect((await world.ledger.get("kept", world.context("read")))?.done).toEqual(newer)

    await submitWork(world.services, { workId: "kept", text: "One more thing.", mode: "steer", files: [] }, { op: world.context("submit", "boxd_submit"), by: "tool" })
    expect((await world.ledger.get("kept", world.context("read")))?.done).toBeUndefined()
  })

  test("a report older than the latest submit is not read as done", async () => {
    await world.bulk([{ workId: "stale", status: "hibernated" }])
    const early = report(at(-5_000))
    await world.record("stale", (record) => ({ ...record, done: early, lastSubmit: { at: at(5_000), delivery: "steer" } }))
    const seen = (await job({ workId: "stale" })) as JobResult
    expect(seen).toMatchObject({ state: "asleep", done: false })
    expect(seen.summary).toBeUndefined()
  })

  test("an idle event carries done, the record keeps it, and the watcher nudges the works source for every event", async () => {
    await world.work("watched", { busy: true })
    const done = report(at())
    reportsDone(world, "watched", done)
    let changed = 0
    const watcher = createWatch({ ...world.services }, {
      autoStart: false,
      changed: () => {
        changed += 1
      },
    })
    const events: Array<{ workId: string; to: string; done?: true }> = []
    watcher.watch.subscribe((event) => events.push({ workId: event.workId, to: event.to, ...(event.done ? { done: event.done } : {}) }))
    await watcher.tick()
    expect(events).toEqual([{ workId: "watched", to: "busy" }])
    expect(changed).toBe(1)
    world.guest.complete("ses_watched")
    world.clock.now = new Date(world.clock.now.getTime() + 61_000)
    await watcher.tick()
    expect(events.at(-1)).toEqual({ workId: "watched", to: "idle", done: true })
    expect(changed).toBe(2)
    expect((await world.ledger.get("watched", world.context("read")))?.done).toEqual(done)
    await watcher.dispose()
  })
})
