// The ledger's machine-hours and their cost (design §C.4): every phase change adds the elapsed interval to the phase
// that was current, so creating, busy, idle and unreachable count as running, asleep counts as existing only, and gone
// or closed add neither. The same interval is priced at the rates current at that change. A restart, or a change missed
// while OpenCode was closed, counts from the record's last change and never twice.
import { afterEach, describe, expect, test } from "bun:test"
import { money, perHour, PUBLIC_RATES } from "../../src/cost/rates.js"
import { ledgerPort } from "../../src/ledger/index.js"
import { hoursAt, localDay, shownWorkHours } from "../../src/ledger/hours.js"
import { Ledger } from "../../src/ledger/store.js"
import type { Phase, WorkRecord } from "../../src/ledger/types.js"
import type { MachineId, Rates, Reading } from "../../src/ports.js"
import { removeRoot, tempRoot } from "../support/ledger-fakes.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) removeRoot(root)
})

const record = (workId: string, over: Partial<WorkRecord> = {}): WorkRecord => ({
  format: 1,
  workId,
  state: "open",
  region: "fra",
  machine: `oc-${workId}`,
  machineId: `vm_${workId}` as MachineId,
  size: "2x8",
  image: { name: "oc-golden-2.4.1-2x8", opencode: "2.4.1" },
  laptopDirectory: "/work/projects/api",
  guestDirectory: `/home/boxd/work/${workId}`,
  createdAt: "2026-11-16T09:00:00.000Z",
  ...over,
})

const minutes = (count: number) => count * 60_000
const EUR = PUBLIC_RATES.EUR
const ORG_EUR: Rates = { ...EUR, vcpuHour: 0.05, ramGiBHour: 0.02, diskGiBHour: 0.0001, source: "usage" }
const ORG_USD: Rates = { ...PUBLIC_RATES.USD, source: "usage" }
const reading: Reading = { residentGiB: 2, load1: 1 }

describe("the ledger's machine-hours", () => {
  test("creating, busy, idle, asleep and gone: existed and running, across a restart and a change missed while closed", async () => {
    const root = tempRoot("boxd-hours-")
    roots.push(root)
    const clock = { now: new Date(2026, 10, 16, 9, 0, 0) }
    const ledger = new Ledger(root, { now: () => clock.now })
    const port = ledgerPort(ledger)
    await ledger.mutate("metered", () => record("metered", { createdAt: clock.now.toISOString() }))
    const context = { call: { callId: "hours", source: "watcher" as const } }
    const change = async (from: Phase | null, to: Phase) => {
      await port.appendEvent({ at: clock.now.toISOString(), workId: "metered", from, to }, context)
    }

    await change(null, "creating")
    clock.now = new Date(clock.now.getTime() + minutes(10))
    await change("creating", "busy")
    clock.now = new Date(clock.now.getTime() + minutes(20))
    await change("busy", "idle")
    expect((await ledger.get("metered"))?.hours).toMatchObject({ existedSeconds: 30 * 60, runningSeconds: 30 * 60, asleepSeconds: 0, phase: "idle" })

    // The plugin restarts between two phase changes; the new ledger counts from what the record keeps, not from zero.
    const restarted = new Ledger(root, { now: () => clock.now })
    const after = ledgerPort(restarted)
    clock.now = new Date(clock.now.getTime() + minutes(15))
    await after.appendEvent({ at: clock.now.toISOString(), workId: "metered", from: "idle", to: "asleep" }, context)
    expect((await restarted.get("metered"))?.hours).toMatchObject({ existedSeconds: 45 * 60, runningSeconds: 45 * 60, asleepSeconds: 0, phase: "asleep" })

    // A phase change OpenCode missed while it was closed: the gap counts from the record's last change, once.
    clock.now = new Date(clock.now.getTime() + minutes(30))
    await after.appendEvent({ at: clock.now.toISOString(), workId: "metered", from: "asleep", to: "gone" }, context)
    expect((await restarted.get("metered"))?.hours).toMatchObject({ existedSeconds: 75 * 60, runningSeconds: 45 * 60, asleepSeconds: 30 * 60, phase: "gone" })

    // Gone adds nothing until the work comes back; creating and busy do.
    clock.now = new Date(clock.now.getTime() + minutes(60))
    await after.appendEvent({ at: clock.now.toISOString(), workId: "metered", from: "gone", to: "creating" }, context)
    clock.now = new Date(clock.now.getTime() + minutes(5))
    await after.appendEvent({ at: clock.now.toISOString(), workId: "metered", from: "creating", to: "busy" }, context)
    const hours = (await restarted.get("metered"))!.hours!
    expect(hours).toMatchObject({ existedSeconds: 80 * 60, runningSeconds: 50 * 60, asleepSeconds: 30 * 60, phase: "busy", at: clock.now.toISOString() })
    expect(shownWorkHours(hours)).toMatchObject({ seconds: { existed: 80 * 60, running: 50 * 60, asleep: 30 * 60 } })
    // Reading it now adds no second to the record.
    expect(hoursAt((await restarted.get("metered"))!, clock.now, EUR)).toMatchObject({ existedSeconds: 80 * 60, runningSeconds: 50 * 60, asleepSeconds: 30 * 60 })
  })

  test("prices every interval at the rates current at its phase change, across a restart, and reads it now without a write", async () => {
    const root = tempRoot("boxd-hours-money-")
    roots.push(root)
    const clock = { now: new Date(2026, 10, 16, 9, 0, 0) }
    const rates = () => EUR
    const ledger = new Ledger(root, { now: () => clock.now, rates })
    const port = ledgerPort(ledger)
    await ledger.mutate("money", () => record("money", { createdAt: clock.now.toISOString() }))
    const context = { call: { callId: "hours", source: "watcher" as const } }
    const change = async (from: Phase | null, to: Phase, at?: Reading) => {
      await port.appendEvent({ at: clock.now.toISOString(), workId: "money", from, to, ...(at ? { reading: at } : {}) }, context)
    }

    await change(null, "creating")
    clock.now = new Date(clock.now.getTime() + minutes(10))
    await change("creating", "busy")
    clock.now = new Date(clock.now.getTime() + minutes(20))
    await change("busy", "idle", reading)

    const creating = perHour("creating", "2x8", undefined, EUR) * (10 / 60)
    const busy = perHour("busy", "2x8", reading, EUR) * (20 / 60)
    const first = (await ledger.get("money"))!.hours!
    expect(first).toMatchObject({ existedSeconds: 30 * 60, runningSeconds: 30 * 60, asleepSeconds: 0, todayExistedSeconds: 30 * 60, todayRunningSeconds: 30 * 60, todayAsleepSeconds: 0, currency: "EUR", ratesSource: "public", reading })
    expect(first.cost).toBeCloseTo(creating + busy, 10)
    expect(first.todayCost).toBeCloseTo(creating + busy, 10)

    // The plugin restarts between two phase changes: the money continues from the record, and nothing is counted twice.
    const restarted = new Ledger(root, { now: () => clock.now, rates })
    const after = ledgerPort(restarted)
    expect(hoursAt((await restarted.get("money"))!, clock.now, EUR).cost).toBeCloseTo(creating + busy, 10)
    clock.now = new Date(clock.now.getTime() + minutes(15))
    const idle = perHour("idle", "2x8", reading, EUR) * (15 / 60)
    // Reading it now prices the interval since the last change, without writing it.
    const live = hoursAt((await restarted.get("money"))!, clock.now, EUR)
    expect(live.cost).toBeCloseTo(creating + busy + idle, 10)
    expect(live.todayCost).toBeCloseTo(creating + busy + idle, 10)
    expect((await restarted.get("money"))!.hours!.at).toBe(first.at)
    await after.appendEvent({ at: clock.now.toISOString(), workId: "money", from: "idle", to: "asleep" }, context)
    expect((await restarted.get("money"))!.hours!.cost).toBeCloseTo(creating + busy + idle, 10)

    clock.now = new Date(clock.now.getTime() + minutes(30))
    await after.appendEvent({ at: clock.now.toISOString(), workId: "money", from: "asleep", to: "gone" }, context)
    const asleep = perHour("asleep", "2x8", reading, EUR) * (30 / 60)
    const expected = creating + busy + idle + asleep
    const hours = (await restarted.get("money"))!.hours!
    expect(hours).toMatchObject({
      existedSeconds: 75 * 60,
      runningSeconds: 45 * 60,
      asleepSeconds: 30 * 60,
      todayExistedSeconds: 75 * 60,
      todayRunningSeconds: 45 * 60,
      todayAsleepSeconds: 30 * 60,
      phase: "gone",
      currency: "EUR",
      ratesSource: "public",
      reading,
    })
    expect(hours.cost).toBeCloseTo(expected, 10)
    expect(hours.todayCost).toBeCloseTo(expected, 10)
    expect(shownWorkHours(hours)).toEqual({
      seconds: { existed: 75 * 60, running: 45 * 60, asleep: 30 * 60 },
      estimate: { amount: money(expected), currency: "EUR", ratesSource: "public" },
    })
    // Reading it now adds no money and writes nothing: the record still ends at the phase change.
    const now = hoursAt((await restarted.get("money"))!, clock.now, EUR)
    expect(now.cost).toBeCloseTo(expected, 10)
    expect(now.todayCost).toBeCloseTo(expected, 10)
    expect(now.at).toBe(hours.at)
  })

  test("today's counters keep only the part after local midnight, while the cumulative counters keep the whole interval", async () => {
    const root = tempRoot("boxd-hours-day-")
    roots.push(root)
    const clock = { now: new Date(2026, 10, 16, 23, 30, 0) }
    const ledger = new Ledger(root, { now: () => clock.now, rates: () => EUR })
    const port = ledgerPort(ledger)
    await ledger.mutate("day", () => record("day", { size: "1x4", createdAt: clock.now.toISOString() }))
    const context = { call: { callId: "hours", source: "watcher" as const } }
    const change = async (from: Phase | null, to: Phase, at?: Reading) => {
      await port.appendEvent({ at: clock.now.toISOString(), workId: "day", from, to, ...(at ? { reading: at } : {}) }, context)
    }

    await change(null, "creating")
    clock.now = new Date(clock.now.getTime() + minutes(20))
    await change("creating", "idle")

    // 23:50 to 00:10: the cumulative counters take 20 minutes, today's only the 10 after midnight.
    clock.now = new Date(clock.now.getTime() + minutes(20))
    await change("idle", "asleep", reading)
    const before = (await ledger.get("day"))!.hours!
    expect(before).toMatchObject({
      existedSeconds: 40 * 60,
      runningSeconds: 40 * 60,
      asleepSeconds: 0,
      todayExistedSeconds: 10 * 60,
      todayRunningSeconds: 10 * 60,
      todayAsleepSeconds: 0,
      day: localDay(clock.now),
    })

    clock.now = new Date(clock.now.getTime() + minutes(30))
    await change("asleep", "gone")
    const hours = (await ledger.get("day"))!.hours!
    expect(hours).toMatchObject({ existedSeconds: 70 * 60, runningSeconds: 40 * 60, asleepSeconds: 30 * 60, todayExistedSeconds: 40 * 60, todayRunningSeconds: 10 * 60, todayAsleepSeconds: 30 * 60 })

    // Each interval is priced whole, and only the part after local midnight goes to today's money.
    const creating = perHour("creating", "1x4", undefined, EUR) * (20 / 60)
    const idle = perHour("idle", "1x4", reading, EUR) * (20 / 60)
    const asleep = perHour("asleep", "1x4", reading, EUR) * (30 / 60)
    expect(hours.cost).toBeCloseTo(creating + idle + asleep, 10)
    expect(hours.todayCost).toBeCloseTo(perHour("idle", "1x4", reading, EUR) * (10 / 60) + asleep, 10)
  })

  test("a rates change prices each interval at its own rates, and a new currency starts the money counters again", async () => {
    const root = tempRoot("boxd-hours-rates-")
    roots.push(root)
    const clock = { now: new Date(2026, 10, 16, 9, 0, 0) }
    let rates: Rates = EUR
    const ledger = new Ledger(root, { now: () => clock.now, rates: () => rates })
    const port = ledgerPort(ledger)
    await ledger.mutate("rates", () => record("rates", { createdAt: clock.now.toISOString() }))
    const context = { call: { callId: "hours", source: "watcher" as const } }
    const change = async (from: Phase | null, to: Phase) => {
      await port.appendEvent({ at: clock.now.toISOString(), workId: "rates", from, to }, context)
    }

    await port.appendEvent({ at: clock.now.toISOString(), workId: "rates", from: null, to: "busy", reading }, context)
    clock.now = new Date(clock.now.getTime() + minutes(60))
    await change("busy", "idle")
    const publicBusy = perHour("busy", "2x8", reading, EUR) * 1

    rates = ORG_EUR
    clock.now = new Date(clock.now.getTime() + minutes(60))
    await change("idle", "busy")
    const orgIdle = perHour("idle", "2x8", reading, ORG_EUR) * 1
    expect((await ledger.get("rates"))!.hours).toMatchObject({ currency: "EUR", ratesSource: "usage" })
    expect((await ledger.get("rates"))!.hours!.cost).toBeCloseTo(publicBusy + orgIdle, 10)

    rates = ORG_USD
    clock.now = new Date(clock.now.getTime() + minutes(60))
    await change("busy", "idle")
    const usdBusy = perHour("busy", "2x8", reading, ORG_USD) * 1
    const hours = (await ledger.get("rates"))!.hours!
    expect(hours).toMatchObject({ currency: "USD", ratesSource: "usage" })
    expect(hours.cost).toBeCloseTo(usdBusy, 10)
    expect(hours.todayCost).toBeCloseTo(usdBusy, 10)
  })

  test("two slot works on one shared machine are each charged a half, so together they are the machine once", async () => {
    const root = tempRoot("boxd-hours-slot-")
    roots.push(root)
    const clock = { now: new Date(2026, 10, 16, 9, 0, 0) }
    const ledger = new Ledger(root, { now: () => clock.now, rates: () => EUR })
    const port = ledgerPort(ledger)
    const shared = { slot: true as const, machine: "oc-shared-fleet" as const, size: "2x8" as const }
    await ledger.mutate("one", () => record("one", { ...shared, createdAt: clock.now.toISOString() }))
    await ledger.mutate("two", () => record("two", { ...shared, createdAt: clock.now.toISOString() }))
    const context = { call: { callId: "hours", source: "watcher" as const } }
    for (const workId of ["one", "two"]) {
      await port.appendEvent({ at: clock.now.toISOString(), workId, from: null, to: "busy", reading }, context)
    }
    clock.now = new Date(clock.now.getTime() + minutes(60))
    for (const workId of ["one", "two"]) {
      await port.appendEvent({ at: clock.now.toISOString(), workId, from: "busy", to: "idle" }, context)
    }
    const one = (await ledger.get("one"))!.hours!
    const two = (await ledger.get("two"))!.hours!
    const machine = perHour("busy", "2x8", reading, EUR) * 1
    expect(one.share).toBe(0.5)
    expect(two.share).toBe(0.5)
    expect(one.cost).toBeCloseTo(machine / 2, 10)
    expect(two.cost).toBeCloseTo(machine / 2, 10)
    expect(one.cost + two.cost).toBeCloseTo(machine, 10)
    expect(one.todayCost + two.todayCost).toBeCloseTo(machine, 10)
  })
})
