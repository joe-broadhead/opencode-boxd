// `budget.labels`: a label's machines, today's machine-hours and cost per day are capped beside the ledger's own
// caps. The option refuses a malformed entry before anything runs; ensure refuses a new work whose labels are at a
// cap and lets an unlabelled one through; a slot work joining a shared machine adds no machine; status carries each
// cap with its use.
import { afterEach, describe, expect, test } from "bun:test"
import { budgetLabelMatch, parseOptions } from "../../src/options.js"
import { localDay } from "../../src/ledger/hours.js"
import type { WorkRecord } from "../../src/ledger/types.js"
import type { EnsureResult } from "../../src/results.js"
import { statusInput, fleetStatus } from "../../src/fleet/status.js"
import { fakes, T0, work, type Fakes } from "../support/cost-fakes.js"
import { startWorld } from "../support/fleet-world.js"
import { startKit, workRecord, type Kit } from "../support/machines-kit.js"

const tag = { callId: "t", source: "boxd_status" } as const
const opened: Fakes[] = []
const kits: Kit[] = []
const make = (input: Parameters<typeof fakes>[0] = {}) => {
  const value = fakes(input)
  opened.push(value)
  return value
}
afterEach(async () => {
  for (const value of opened.splice(0)) value.dispose()
  for (const value of kits.splice(0)) await value.dispose()
})
const kit = async (input: Parameters<typeof startKit>[0] = {}) => {
  const value = await startKit(input)
  kits.push(value)
  return value
}
const errorOf = async (promise: Promise<unknown>) =>
  promise.then(
    (value) => {
      throw new Error(`expected a refusal, got ${JSON.stringify(value)}`)
    },
    (error: { code?: string; what?: string; details?: Record<string, unknown> }) => error,
  )

/** A record that ran `hours` today, with the labels a cap matches. */
const ranHours = (hours: number, at = T0) => ({
  existedSeconds: hours * 3600,
  runningSeconds: hours * 3600,
  asleepSeconds: 0,
  todayExistedSeconds: hours * 3600,
  todayRunningSeconds: hours * 3600,
  todayAsleepSeconds: 0,
  cost: 0,
  todayCost: 0,
  currency: "EUR",
  ratesSource: "usage" as const,
  day: localDay(at),
  phase: "idle" as const,
  at: at.toISOString(),
})
const labelled = (workId: string, over: Partial<WorkRecord> = {}) => workRecord(workId, { labels: { product: "alpha" }, laptopDirectory: "/tmp", ...over })

describe("the budget.labels option", () => {
  test("parses one cap per matching label, and refuses each malformed entry in the house form", () => {
    expect(parseOptions({ budget: { labels: [{ match: "product=alpha", machines: 6 }], action: "refuse" } }).budget).toEqual({
      labels: [{ match: "product=alpha", machines: 6 }],
      action: "refuse",
    })
    expect(budgetLabelMatch("feature=boxd-plugin/59")).toEqual({ key: "feature", value: "boxd-plugin/59" })
    for (const match of ["owner=alpha", "Product=alpha", "product=", "product=alpha=extra", "product"]) expect(budgetLabelMatch(match)).toBeUndefined()
    const bad = (labels: unknown) => {
      try {
        parseOptions({ budget: { labels, action: "refuse" } })
        throw new Error("expected OPTIONS_INVALID")
      } catch (error) {
        return error as { code?: string; what?: string }
      }
    }
    for (const labels of [
      [],
      [{ match: "owner=alpha", machines: 1 }],
      [{ match: "product=alpha" }],
      [{ match: "product=alpha", machines: -1 }],
      [{ match: "product=alpha", machineHours: 0 }],
      [{ match: "product=alpha", daily: 0 }],
      [{ match: "product=alpha", machines: 1 }, { match: "product=alpha", daily: 1 }],
    ]) {
      const error = bad(labels)
      expect(error.code).toBe("OPTIONS_INVALID")
      expect(error.what).toContain("budget.labels")
    }
  })
})

describe("a label cap in the budget state", () => {
  test("shows this ledger's matching machines, today's hours and cost per day, and ignores an unlabelled or another ledger's work", async () => {
    const records = [
      { ...workRecord("a", { labels: { product: "alpha" }, hours: ranHours(2) }) },
      { ...workRecord("b", { labels: { product: "alpha" }, hours: ranHours(1) }) },
      { ...workRecord("other", { labels: { product: "beta" } }) },
    ]
    const works = [
      work("a", { labels: { product: "alpha" } }),
      work("b", { labels: { product: "alpha" } }),
      work("other", { labels: { product: "beta" } }),
      work("plain"),
      work("foreign", { labels: { product: "alpha" }, phase: "closed" }),
    ]
    const f = make({
      options: { budget: { labels: [{ match: "product=alpha", machines: 3, machineHours: 4, daily: 100 }], action: "refuse" } },
      records,
      works,
    })
    f.labels.set("oc-foreign", { ledger: "another", "work.product": "alpha" })
    const state = await f.services.cost.budget(tag)
    const label = state?.labels?.[0]
    expect(label).toMatchObject({ match: "product=alpha", machines: { inUse: 2, limit: 3 }, machineHours: { today: 3, cap: 4 }, state: "ok" })
    const perDay = ((0.0376 + 0.0376) * 24)
    expect(label?.daily?.perDay).toBeCloseTo(perDay, 2)
    expect(label?.daily?.cap).toBe(100)
  })

  test("status carries each label cap with its use, from the watcher's own works", async () => {
    const world = await startWorld({
      options: { budget: { labels: [{ match: "product=alpha", machines: 2, machineHours: 4, daily: 100 }], action: "warn" } },
      cost: "real",
    })
    try {
      await world.work("a", { labels: { product: "alpha" } })
      await world.work("plain")
      const status = await fleetStatus(world.services, statusInput({ view: "all", limit: 10 }), { tag, guestReads: false })
      expect(status.budget?.state).toBe("ok")
      expect(status.budget?.labels?.[0]).toMatchObject({ match: "product=alpha", machines: { inUse: 1, limit: 2 }, machineHours: { today: 0, cap: 4 }, daily: { cap: 100 }, state: "ok" })
    } finally {
      await world.dispose()
    }
  })

  test("allows a matching create under its machines cap, refuses one at it, and lets an unlabelled one pass", async () => {
    const under = make({
      options: { budget: { labels: [{ match: "product=alpha", machines: 2 }], action: "refuse" } },
      records: [workRecord("a", { labels: { product: "alpha" } })],
      works: [work("a", { labels: { product: "alpha" } })],
    })
    await under.services.cost.assertCreateBudget(tag, { labels: { product: "alpha" }, createsMachine: true })

    const at = make({
      options: { budget: { labels: [{ match: "product=alpha", machines: 2 }], action: "refuse" } },
      records: [workRecord("a", { labels: { product: "alpha" } }), workRecord("b", { labels: { product: "alpha" } })],
      works: [work("a", { labels: { product: "alpha" } }), work("b", { labels: { product: "alpha" } })],
    })
    const error = (await at.services.cost
      .assertCreateBudget(tag, { labels: { product: "alpha" }, createsMachine: true })
      .catch((caught: unknown) => caught)) as { code?: string; what?: string; details?: Record<string, unknown> }
    expect(error.code).toBe("BUDGET_REACHED")
    expect(error.what).toContain("product=alpha")
    expect(error.what).toContain("2 machines")
    expect(error.details).toMatchObject({ scope: "labels", match: "product=alpha", inUse: 2, cap: 2 })
    await at.services.cost.assertCreateBudget(tag, { createsMachine: true })
    const warn = make({
      options: { budget: { labels: [{ match: "product=alpha", machines: 2 }], action: "warn" } },
      records: [workRecord("a", { labels: { product: "alpha" } }), workRecord("b", { labels: { product: "alpha" } })],
      works: [work("a", { labels: { product: "alpha" } }), work("b", { labels: { product: "alpha" } })],
    })
    await warn.services.cost.assertCreateBudget(tag, { labels: { product: "alpha" }, createsMachine: true })
    expect((await warn.services.cost.budget(tag))?.labels?.[0]?.state).toBe("reached")
  })

  test("refuses at a matching machineHours or daily cap, and names the label and its cap", async () => {
    const hours = make({
      options: { budget: { labels: [{ match: "product=alpha", machineHours: 2 }], action: "refuse" } },
      records: [workRecord("a", { labels: { product: "alpha" }, hours: ranHours(3) })],
      works: [work("a", { labels: { product: "alpha" } })],
    })
    const hoursError = (await hours.services.cost
      .assertCreateBudget(tag, { labels: { product: "alpha" }, createsMachine: true })
      .catch((caught: unknown) => caught)) as { code?: string; what?: string }
    expect(hoursError.code).toBe("BUDGET_REACHED")
    expect(hoursError.what).toContain("product=alpha")
    expect(hoursError.what).toContain("machineHours 2.00 h")

    const daily = make({
      options: { budget: { labels: [{ match: "product=alpha", daily: 0.5 }], action: "refuse" } },
      works: [work("a", { labels: { product: "alpha" } })],
    })
    const dailyError = (await daily.services.cost
      .assertCreateBudget(tag, { labels: { product: "alpha" }, createsMachine: true })
      .catch((caught: unknown) => caught)) as { code?: string; what?: string }
    expect(dailyError.code).toBe("BUDGET_REACHED")
    expect(dailyError.what).toContain("product=alpha")
    expect(dailyError.what).toContain("per day")
  })
})

describe("boxd_ensure with budget.labels", () => {
  test("refuses the labelled work at its machines cap before any create, and still creates an unlabelled one", async () => {
    const k = await kit({ realCost: true, options: { budget: { labels: [{ match: "product=alpha", machines: 1 }], action: "refuse" } } })
    await k.golden("fra")
    const ledger = await k.services.ledger.id({ call: { callId: "id", source: "boxd_ensure" } })
    const existing = k.counter.fake.machine({ name: "oc-old", region: "fra", labels: { owner: "boxd", role: "session", work: "old", "work.product": "alpha", ledger } })
    await k.write(labelled("old", { region: "fra", machineId: existing.id as never }))
    k.reset()
    const error = await errorOf(k.runs.boxd_ensure({ workId: "new", labels: { product: "alpha" } }, k.call()))
    expect(error.code).toBe("BUDGET_REACHED")
    expect(error.what).toContain("product=alpha")
    expect(k.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
    expect(await k.record("new")).toBeUndefined()

    const plain = (await k.runs.boxd_ensure({ workId: "plain" }, k.call())) as EnsureResult
    expect(plain).toMatchObject({ state: "ready", created: true })
    expect(await k.record("plain")).toBeDefined()
  })

  test("warn creates the labelled work, and its machine carries work.product", async () => {
    const k = await kit({ realCost: true, options: { budget: { labels: [{ match: "product=alpha", machines: 0 }], action: "warn" } } })
    await k.golden("fra")
    k.reset()
    const result = (await k.runs.boxd_ensure({ workId: "warned", labels: { product: "alpha", feature: "boxd-plugin/59" } }, k.call())) as EnsureResult
    expect(result).toMatchObject({ state: "ready", created: true })
    expect((await k.record("warned"))?.labels).toEqual({ product: "alpha", feature: "boxd-plugin/59" })
    const created = k.calls().find((entry) => entry.startsWith("machine new oc-warned"))!
    expect(created).toContain("--label work.feature=boxd-plugin/59 --label work.product=alpha")
    expect(k.counter.fake.read().machines.find((entry) => entry.name === "oc-warned")?.labels).toMatchObject({ "work.product": "alpha", "work.feature": "boxd-plugin/59" })
  })

  test("a slot work joining a shared machine adds no machine and is not refused at its label's machines cap", async () => {
    const k = await kit({ realCost: true, options: { budget: { labels: [{ match: "product=alpha", machines: 1 }], action: "refuse" } } })
    const ledger = await k.services.ledger.id({ call: { callId: "id", source: "boxd_ensure" } })
    const shared = k.counter.fake.machine({ name: "oc-shared-team", region: "fra", labels: { owner: "boxd", role: "session", shared: "team", ledger } })
    await k.write(labelled("first", { region: "fra", machine: "oc-shared-team", machineId: shared.id as never, slot: true }))
    k.reset()
    const second = (await k.runs.boxd_ensure({ workId: "second", machine: "team", labels: { product: "alpha" } }, k.call())) as EnsureResult
    expect(second).toMatchObject({ state: "ready", created: false })
    expect(k.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
    expect((await k.record("second"))?.labels).toEqual({ product: "alpha" })
  })

  test("refuses a labelled work at its label's machineHours cap before any create", async () => {
    const k = await kit({ realCost: true, options: { budget: { labels: [{ match: "product=alpha", machineHours: 1 }], action: "refuse" } } })
    await k.golden("fra")
    await k.write(labelled("old", { region: "fra", hours: ranHours(2, new Date()) }))
    k.reset()
    const error = await errorOf(k.runs.boxd_ensure({ workId: "new", labels: { product: "alpha" } }, k.call()))
    expect(error.code).toBe("BUDGET_REACHED")
    expect(error.what).toContain("machineHours")
    expect(k.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
  })
})
