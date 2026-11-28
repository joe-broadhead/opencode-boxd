// Cost events in `events.jsonl`: one per work for each local day that ended, carrying that day's seconds and estimate,
// and one for a work's whole life when it closes. A restart or a second watcher on one ledger writes neither twice.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createWatch } from "../../src/watch.js"
import { eventOf, titleOf } from "../../src/handlers/events.js"
import { PUBLIC_RATES } from "../../src/cost/rates.js"
import type { WorkEvent } from "../../src/ports.js"
import { startWorld, type World } from "../support/fleet-world.js"

setDefaultTimeout(30_000)

let world: World | undefined
afterEach(async () => {
  await world?.dispose()
  world = undefined
})

const costEvents = async (w: World): Promise<readonly WorkEvent[]> =>
  (await w.ledger.eventsSince(0, w.context("read"))).events.filter((event) => event.cost !== undefined)

describe("cost events", () => {
  test("writes one day event for a work that existed yesterday, none for one created after midnight, and none twice", async () => {
    world = await startWorld()
    const w = world
    w.clock.now = new Date(2026, 10, 16, 23, 0, 0)
    await w.work("old")
    await w.record("old", (record) => ({ ...record, labels: { product: "widgets", role: "lane", task: "boxd-plugin/132" } }))
    await w.watcher.tick()
    w.clock.now = new Date(2026, 10, 16, 23, 59, 0)
    await w.watcher.tick()

    w.clock.now = new Date(2026, 10, 17, 0, 1, 0)
    await w.work("new")
    await w.watcher.tick()
    const first = await costEvents(w)
    expect(first.map((event) => [event.workId, event.cost!.day])).toEqual([["old", "2026-11-16"]])
    expect(first[0]).toMatchObject({ from: "idle", to: "idle" })
    expect(first[0]!.cost!.seconds).toMatchObject({ existed: 3600, running: 3600, asleep: 0 })
    expect(first[0]!.cost!.currency).toBe("EUR")
    expect(first[0]!.cost!.ratesSource).toBe("public")
    expect(first[0]!.cost!.amount).toBeGreaterThan(0)
    expect(first[0]!.labels).toEqual({ product: "widgets", role: "lane", task: "boxd-plugin/132" })

    // A second tick that day, and a restart on the same ledger, write no second day event.
    await w.watcher.tick()
    const again = createWatch({ ...w.services }, { autoStart: false })
    w.clock.now = new Date(2026, 10, 17, 0, 2, 0)
    await again.tick()
    expect(await costEvents(w)).toHaveLength(1)
    await again.dispose()
  }, 60_000)

  test("reports every day that ended, even when the work stayed in one phase", async () => {
    world = await startWorld()
    const w = world
    w.clock.now = new Date(2026, 10, 16, 23, 0, 0)
    await w.work("idle")
    await w.watcher.tick()
    w.clock.now = new Date(2026, 10, 17, 0, 1, 0)
    await w.watcher.tick()
    w.clock.now = new Date(2026, 10, 18, 0, 1, 0)
    await w.watcher.tick()
    const events = await costEvents(w)
    expect(events.map((event) => event.cost!.day)).toEqual(["2026-11-16", "2026-11-17"])
    expect(events[0]!.cost!.seconds).toMatchObject({ existed: 3600, running: 3600 })
    expect(events[1]!.cost!.seconds).toMatchObject({ existed: 86_400, running: 86_400 })
  }, 60_000)

  test("a tick after the day is written writes nothing and does not nudge changed", async () => {
    let nudges = 0
    world = await startWorld({ changed: () => { nudges += 1 } })
    const w = world
    w.clock.now = new Date(2026, 10, 16, 23, 0, 0)
    await w.work("quiet")
    await w.watcher.tick()
    w.clock.now = new Date(2026, 10, 17, 0, 1, 0)
    await w.watcher.tick()
    expect(await costEvents(w)).toHaveLength(1)

    nudges = 0
    w.clock.now = new Date(2026, 10, 17, 0, 2, 0)
    await w.watcher.tick()
    expect(await costEvents(w)).toHaveLength(1)
    expect(nudges).toBe(0)
  }, 60_000)

  test("two watchers on one ledger write one day event between them", async () => {
    world = await startWorld()
    const w = world
    w.clock.now = new Date(2026, 10, 16, 23, 0, 0)
    await w.work("shared")
    await w.watcher.tick()
    const other = createWatch({ ...w.services }, { autoStart: false })
    w.clock.now = new Date(2026, 10, 17, 0, 1, 0)
    await Promise.all([w.watcher.tick(), other.tick()])
    const events = await costEvents(w)
    expect(events).toHaveLength(1)
    expect(events[0]!.labels).toBeUndefined()
    await other.dispose()
  }, 60_000)

  test("writes one life event at close, carrying the whole life, and no second after a restart or another tick", async () => {
    world = await startWorld()
    const w = world
    w.clock.now = new Date(2026, 10, 17, 10, 0, 0)
    await w.work("closed")
    await w.watcher.tick()
    w.clock.now = new Date(2026, 10, 17, 10, 30, 0)
    await w.ledger.appendEvent({ at: w.clock.now.toISOString(), workId: "closed", from: "idle", to: "closed" }, w.context("drop", "boxd_drop"))
    await w.watcher.tick()

    const first = await costEvents(w)
    expect(first.map((event) => [event.workId, event.cost!.day])).toEqual([["closed", "life"]])
    expect(first[0]).toMatchObject({ from: "closed", to: "closed" })
    expect(first[0]!.cost!.seconds).toMatchObject({ existed: 1800, running: 1800, asleep: 0 })
    expect(first[0]!.cost!.amount).toBeGreaterThan(0)

    await w.watcher.tick()
    const again = createWatch({ ...w.services }, { autoStart: false })
    w.clock.now = new Date(2026, 10, 17, 11, 0, 0)
    await again.tick()
    expect(await costEvents(w)).toHaveLength(1)
    await again.dispose()
  }, 60_000)

  test("eventOf names a cost event's day, seconds, amount, rates and product labels", () => {
    const cost = {
      day: "2026-11-27",
      seconds: { existed: 40_000, running: 11_160, asleep: 3_600 },
      amount: 0.42,
      currency: "EUR",
      ratesSource: "public" as const,
    }
    const labels = { product: "widgets", role: "lane", task: "boxd-plugin/132" }
    const event: WorkEvent = { seq: 9, at: "2026-11-28T00:01:00.000Z", workId: "w1", from: "idle", to: "idle", cost, labels }
    expect(titleOf(event)).toBe("Work w1 cost EUR 0.42 on 2026-11-27, 3.1 running hours")
    expect(eventOf(event).labels).toEqual([
      "cost:2026-11-27",
      "running-seconds:11160",
      "asleep-seconds:3600",
      "amount:0.42",
      "currency:EUR",
      "rates:public",
      "product:widgets",
      "role:lane",
      "task:boxd-plugin/132",
      "phase:idle",
    ])
    const without = eventOf({ ...event, labels: undefined })
    expect(without.labels).not.toContain("product:widgets")
    expect(without.labels).not.toContain("change:idle")
    expect(titleOf({ ...event, cost: { ...cost, day: "life", seconds: { ...cost.seconds, running: 7_200 }, amount: 1.2 } })).toBe("Work w1 cost EUR 1.20 over its life, 2.0 running hours")
    expect(PUBLIC_RATES.EUR.currency).toBe("EUR")
  })
})
