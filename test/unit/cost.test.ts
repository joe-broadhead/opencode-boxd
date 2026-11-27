// Package E's cost service (design §C.1, §C.4, §C.5): the per-hour estimate against hand-computed figures in EUR and
// USD, the selectors behind each cleanup suggestion, today's machine cost with boxd's lag, the budget, and the
// automation state by access.
import { afterEach, describe, expect, test } from "bun:test"
import { localMidnight } from "../../src/cost/index.js"
import { matches, suggestions } from "../../src/cost/fleet.js"
import { perHour, PUBLIC_RATES } from "../../src/cost/rates.js"
import { automationState, consent } from "../../src/cost/shared.js"
import { BoxdError } from "../../src/errors.js"
import { asHours, localDay } from "../../src/ledger/hours.js"
import type { Phase } from "../../src/ledger/types.js"
import type { Usage } from "../../src/ports.js"
import { fakes, minutesAgo, record, T0, work, type Fakes } from "../support/cost-fakes.js"

const EUR = PUBLIC_RATES.EUR
const USD = PUBLIC_RATES.USD
const tag = { callId: "t", source: "boxd_status" } as const
let open: Fakes[] = []
const make = (input: Parameters<typeof fakes>[0] = {}) => {
  const value = fakes(input)
  open.push(value)
  return value
}
afterEach(() => {
  for (const value of open) value.dispose()
  open = []
})

describe("the per-hour estimate (§C.1)", () => {
  test("an idle 4×16 work holding 3 GiB: RAM and disk only, about €0.038/h; hibernated, disk only, about 24 times less", () => {
    const reading = { residentGiB: 3, load1: 0 }
    expect(perHour("idle", "4x16", reading, EUR)).toBeCloseTo(3 * 0.012 + 20 * 0.00008, 10)
    expect(perHour("idle", "4x16", reading, EUR)).toBeCloseTo(0.0376, 10)
    expect(perHour("asleep", "4x16", reading, EUR)).toBeCloseTo(0.0016, 10)
    expect(perHour("idle", "4x16", reading, EUR) / perHour("asleep", "4x16", reading, EUR)).toBeCloseTo(23.5, 1)
  })

  test("the same figures in USD use the USD rates", () => {
    expect(perHour("idle", "4x16", { residentGiB: 3, load1: 0 }, USD)).toBeCloseTo(3 * 0.014 + 20 * 0.000096, 10)
    expect(perHour("asleep", "4x16", undefined, USD)).toBeCloseTo(20 * 0.000096, 10)
  })

  test("a busy work adds its active vCPUs, capped at the machine's", () => {
    expect(perHour("busy", "4x16", { residentGiB: 3, load1: 2.5 }, EUR)).toBeCloseTo(2.5 * 0.039 + 3 * 0.012 + 20 * 0.00008, 10)
    expect(perHour("busy", "1x4", { residentGiB: 2, load1: 3 }, EUR)).toBeCloseTo(1 * 0.039 + 2 * 0.012 + 20 * 0.00008, 10)
  })

  test("a running work with no reading yet counts 1 GiB; gone and closed cost nothing", () => {
    expect(perHour("ready", "2x8", undefined, EUR)).toBeCloseTo(0.012 + 0.0016, 10)
    for (const phase of ["gone", "closed"] as Phase[]) expect(perHour(phase, "2x8", undefined, EUR)).toBe(0)
  })

  test("the cost block: the fleet's estimate, the counts, today, and the basis it states", async () => {
    const f = make({ works: [work("a"), work("b", { phase: "busy", reading: { residentGiB: 4, load1: 2, at: T0.toISOString() } }), work("c", { phase: "asleep" }), work("d", { phase: "closed" })] })
    const block = await f.services.cost.block({ works: true, limit: 10 }, tag)
    const expected = 0.0376 + (2 * 0.039 + 4 * 0.012 + 0.0016) + 0.0016
    expect(block.currency).toBe("EUR")
    expect(block.perHour.estimate).toBeCloseTo(expected, 4)
    expect(block.perHour).toMatchObject({ running: 2, asleep: 1, ratesSource: "usage" })
    expect(block.perHour.basis).toContain("rates ×")
    expect(block.today).toEqual({ machines: 2, complete: true })
    expect(block.works?.map((row) => row.workId)).toEqual(["b", "a", "c"])
    expect(block.works?.[0]).toMatchObject({ model: null, perHour: expect.any(Number) })
  })

  test("today adds the unmetered last 25 minutes while boxd has not marked usage complete", async () => {
    const usage: Usage = { available: true, currency: "EUR", total: 5, estimated: true, complete: false, asOf: T0.toISOString(), rates: { ...EUR, source: "usage" }, machines: [] }
    const f = make({ works: [work("a")], usage })
    const block = await f.services.cost.block({ works: false, limit: 0 }, tag)
    expect(block.today.machines).toBe(Math.round((5 + 0.0376 * (25 / 60)) * 100) / 100)
    expect(block.today.complete).toBe(false)
    expect(block.works).toBeUndefined()
  })

  test("usage is read since local midnight, once per 10 minutes", async () => {
    const f = make({ works: [work("a")] })
    await f.services.cost.block({ works: false, limit: 0 }, tag)
    await f.services.cost.block({ works: false, limit: 0 }, tag)
    expect(f.calls.filter((call) => call.startsWith("usage"))).toEqual([`usage ${localMidnight(T0)}`])
    f.clock.now = new Date(T0.getTime() + 11 * 60_000)
    await f.services.cost.block({ works: false, limit: 0 }, tag)
    expect(f.calls.filter((call) => call.startsWith("usage"))).toHaveLength(2)
    expect(localMidnight(T0)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  test("a member: today's machine cost is null with boxd's reason, and the public rates are used and named as such", async () => {
    const f = make({ works: [work("a")], usage: { available: false, reason: "boxd's machine usage is for organisation owners and admins." } })
    const block = await f.services.cost.block({ works: true, limit: 5 }, tag)
    expect(block.today.machines).toBeNull()
    expect(block.today.unavailable).toContain("owners and admins")
    expect(block.perHour.ratesSource).toBe("public")
    expect(block.perHour.basis).toStartWith("boxd's public EUR rates (this sign-in cannot read the organisation's rates or its billing currency)")
    expect(block.works?.[0]?.machine).toBeNull()
  })

  test("today is boxd machine cost only: no model figure anywhere in the block (MEDIUM-4)", async () => {
    const f = make({ works: [work("a")] })
    const block = await f.services.cost.block({ works: true, limit: 5 }, tag)
    expect(Object.keys(block.today).sort()).toEqual(["complete", "machines"])
    expect(JSON.stringify(block.today)).not.toContain("model")
    expect(block.works?.[0]?.model).toBeNull()
  })

  test("per-work machine cost is matched by machine id", async () => {
    const usage: Usage = { available: true, currency: "USD", total: 1, estimated: false, complete: true, asOf: T0.toISOString(), rates: { ...USD, source: "usage" }, machines: [{ machineId: "vm_a" as never, cost: 0.42 }] }
    const f = make({ works: [work("a"), work("b")], records: [record("a"), record("b")], usage })
    const block = await f.services.cost.block({ works: true, limit: 5 }, tag)
    expect(block.currency).toBe("USD")
    // Since the oldest open work was created, so a work's whole life is counted.
    expect(f.calls).toContain(`usage ${record("a").createdAt.replace(/\.\d{3}Z$/, "Z")}`)
    expect(block.works?.find((row) => row.workId === "a")?.machine).toBe(0.42)
    expect(block.works?.find((row) => row.workId === "b")?.machine).toBeNull()
  })

  test("machine-hours from the ledger: this ledger, today and since the oldest open work, with usage unavailable", async () => {
    const day = localDay(T0)
    const yesterday = minutesAgo(T0, 1_500)
    const hours = (existedSeconds: number, runningSeconds: number, todayExistedSeconds: number, todayRunningSeconds: number, at: string, phase: Phase) => ({
      existedSeconds,
      runningSeconds,
      todayExistedSeconds,
      todayRunningSeconds,
      day: localDay(new Date(at)),
      phase,
      at,
    })
    const old = record("old", { createdAt: minutesAgo(T0, 300), hours: hours(7_200, 3_600, 1_800, 900, T0.toISOString(), "idle") })
    const young = record("young", { createdAt: minutesAgo(T0, 60), hours: hours(1_800, 900, 600, 300, T0.toISOString(), "idle") })
    const closed = record("closed", {
      state: "closed",
      closed: { at: yesterday, how: "dropped" },
      createdAt: yesterday,
      hours: hours(3_600, 1_800, 0, 0, yesterday, "closed"),
    })
    const f = make({ works: [work("old"), work("young")], records: [old, young, closed], usage: { available: false, reason: "boxd's machine usage is for organisation owners and admins." } })
    const block = await f.services.cost.block({ works: true, limit: 10 }, tag)

    // The money figure keeps boxd's reason; the hours need no owner's sign-in.
    expect(block.today.machines).toBeNull()
    expect(block.hours).toEqual({
      ledger: { existed: asHours(7_200 + 1_800 + 3_600), running: asHours(3_600 + 900 + 1_800) },
      today: { existed: asHours(1_800 + 600), running: asHours(900 + 300) },
      since: { existed: asHours(7_200 + 1_800), running: asHours(3_600 + 900) },
    })
    expect(day).toBe(localDay(T0))
  })
})

describe("the selectors and the cleanup suggestions (§C.4)", () => {
  const fleet = [
    work("fin", { phase: "idle", outcome: "completed", saved: "stale" }),
    work("fail", { phase: "idle", outcome: "failed", saved: "fresh" }),
    work("rdy", { phase: "ready", outcome: null, saved: "none" }),
    work("ask", { phase: "idle", outcome: "completed", needsInput: "permission" }),
    work("busy", { phase: "busy", outcome: null, saved: "stale" }),
    work("zz", { phase: "asleep", outcome: "completed", saved: "fresh" }),
    work("zu", { phase: "asleep", outcome: "aborted", saved: "none" }),
    work("done", { phase: "idle", outcome: "completed", saved: "fresh" }),
  ]
  const ids = (select: Parameters<typeof matches>[0]) => fleet.filter((item) => matches(select, item)).map((item) => item.workId)

  test("each selector matches exactly its table row", () => {
    expect(ids("idle")).toEqual(["fin", "fail", "rdy", "done"])
    expect(ids("finished")).toEqual(["fin", "fail", "done"])
    expect(ids("unsaved-finished")).toEqual(["fin", "ask", "zu"])
    expect(ids("saved-finished")).toEqual(["zz", "done"])
  })

  test("the suggestions: finished first, then the broader idle sleep, then the harvest, then the drop, each one call", () => {
    const actions = suggestions(fleet, EUR)
    expect(actions.map((action) => action.call)).toEqual([
      'boxd_sleep({ select: "finished" })',
      'boxd_sleep({ select: "idle" })',
      'boxd_harvest({ select: "unsaved-finished" })',
      'boxd_drop({ select: "saved-finished" })',
    ])
    const sleepFinished = actions.find((action) => action.select === "finished")!
    expect(sleepFinished.works).toBe(3)
    expect(sleepFinished.savesPerHour).toBeCloseTo(3 * 0.036, 4)
    expect(actions.find((action) => action.action === "drop")?.savesPerDay).toBeCloseTo((0.0016 + 0.0376) * 24, 3)
    expect(actions.find((action) => action.action === "harvest")?.why).toContain("drop needs a harvest")
  })

  test("no suggestion when nothing matches", () => {
    expect(suggestions([work("b", { phase: "busy", outcome: null })], EUR)).toEqual([])
  })
})

describe("the budget (§C.5)", () => {
  test("warn: reached is reported and nothing is refused", async () => {
    const f = make({ options: { budget: { daily: 1, action: "warn" } }, works: [work("a")] })
    expect(await f.services.cost.budget(tag)).toMatchObject({ daily: 1, today: 2, action: "warn", state: "reached" })
    await f.services.cost.assertBudget(tag)
  })

  test("refuse: BUDGET_REACHED with today, daily and currency", async () => {
    const f = make({ options: { budget: { daily: 1, action: "refuse" } }, works: [work("a")] })
    const error = await f.services.cost.assertBudget(tag).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(BoxdError)
    expect((error as BoxdError).code).toBe("BUDGET_REACHED")
    expect((error as BoxdError).details).toEqual({ today: 2, daily: 1, currency: "EUR" })
  })

  test("the budget compares the unrounded figure: 4.9983 of 5.00 is not reached, though it shows as 5.00", async () => {
    const usage: Usage = { available: true, currency: "USD", total: 4.98, estimated: true, complete: false, asOf: T0.toISOString(), rates: { ...USD, source: "usage" }, machines: [] }
    const f = make({ options: { budget: { daily: 5, action: "refuse" } }, works: [work("a")], usage })
    const state = await f.services.cost.budget(tag)
    expect(state).toMatchObject({ state: "ok", today: 5, daily: 5 })
    await f.services.cost.assertBudget(tag)
    f.usage = { ...usage, total: 4.99 }
    f.clock.now = new Date(T0.getTime() + 11 * 60_000)
    const error = (await f.services.cost.assertBudget(tag).catch((caught: unknown) => caught)) as BoxdError
    expect(error.code).toBe("BUDGET_REACHED")
    expect(error.what).toContain("Today's machine cost (boxd's estimate), USD 5.01, has reached the budget's daily limit of USD 5.00")
  })

  test("refuse below the limit passes", async () => {
    const f = make({ options: { budget: { daily: 10, action: "refuse" } } })
    expect((await f.services.cost.budget(tag))?.state).toBe("ok")
    await f.services.cost.assertBudget(tag)
  })

  test("a member cannot measure it: unknown, and refuse acts as warn", async () => {
    const f = make({ options: { budget: { daily: 1, action: "refuse" } }, usage: { available: false, reason: "owners and admins" } })
    expect(await f.services.cost.budget(tag)).toMatchObject({ state: "unknown", today: null })
    await f.services.cost.assertBudget(tag)
  })

  test("no budget option: no budget block and no refusal", async () => {
    const f = make()
    expect(await f.services.cost.budget(tag)).toBeUndefined()
    await f.services.cost.assertBudget(tag)
    expect(f.calls).toEqual([])
  })
})

describe("the automation state (§C.3, M-2)", () => {
  test("auto: on at all, off (access) otherwise; on is consent at every level; off is off", () => {
    expect(consent({ access: "all", automation: "auto" })).toBe("on")
    expect(consent({ access: "ask-changes", automation: "auto" })).toBe("off (access)")
    expect(consent({ access: "read-only", automation: "auto" })).toBe("off (access)")
    expect(consent({ access: "all", automation: "on" })).toBe("on")
    expect(consent({ access: "ask-changes", automation: "on" })).toBe("on (consent)")
    expect(consent({ access: "read-only", automation: "on" })).toBe("on (consent)")
    expect(consent({ access: "all", automation: "off" })).toBe("off")
  })

  test("not-owner when another process holds automation.lock; off stays off", () => {
    expect(automationState({ access: "all", automation: "auto" }, { owner: "not-owner" })).toBe("not-owner")
    expect(automationState({ access: "read-only", automation: "auto" }, { owner: "not-owner" })).toBe("off (access)")
    expect(automationState({ access: "all", automation: "auto" }, { owner: "owner" })).toBe("on")
  })

  test("the port answers it", () => {
    expect(make({ options: { access: "ask-changes" } }).services.cost.automation()).toBe("off (access)")
    expect(make({ options: { access: "ask-changes", automation: "on" } }).services.cost.automation()).toBe("on (consent)")
  })
})
