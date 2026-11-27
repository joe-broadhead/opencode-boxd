/**
 * Package E's cost service (design §C.4, §C.5): rates, the per-hour estimate, today, the cleanup suggestions, the
 * budget and the automation state, for D's status and C1's and C2's budget checks. Package E owns `src/cost/*`.
 *
 * Every figure but `today` comes from the watcher's snapshot, with no CLI call. `today` is one `manage usage --since
 * <local midnight>` read, shared by concurrent callers and kept for 10 minutes; while boxd has not marked the period
 * complete (up to 25 minutes), the estimate for the last 25 minutes is added. The rates come from the same read, and
 * are kept for a day; a member, who cannot read usage, gets boxd's public rates, marked `public`.
 */
import { boxdError } from "../errors.js"
import { asHours, hoursAt, localDay } from "../ledger/hours.js"
import type { CallTag, FleetWatch, OpContext, Rates, Usage, WorkSnapshot } from "../ports.js"
import type { BudgetState, CleanupAction, CostBlock, CostHours } from "../results.js"
import type { CoreServices, CostPort } from "../services.js"
import { figures, suggestions } from "./fleet.js"
import { basis, money, PUBLIC_RATES } from "./rates.js"
import { automationState, sharedOf } from "./shared.js"

/** How long one `manage usage` read for today is reused. */
export const USAGE_CACHE_MS = 10 * 60_000
/** How long the organisation's rates are reused. */
export const RATES_CACHE_MS = 24 * 60 * 60_000
/** boxd's metering lag: usage is complete up to 25 minutes after the fact. */
export const UNMETERED_MINUTES = 25

type CostCore = Pick<CoreServices, "options" | "clock" | "boxd" | "runner" | "ledger"> & { readonly watch: FleetWatch }

/** Local midnight of `now`, in boxd's `--since` form (UTC, whole seconds). */
export function localMidnight(now: Date): string {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  return midnight.toISOString().replace(/\.\d{3}Z$/, "Z")
}

/** The open works the estimate counts: every work the watcher knows that has not left boxd. */
const counted = (works: readonly WorkSnapshot[]) => works.filter((work) => work.phase !== "closed" && work.phase !== "gone")

export interface CostInternals extends CostPort {
  /** The rates now: the organisation's when usage was read in the last day, else boxd's public ones. */
  rates(): Rates
  /**
   * Today's boxd machine cost with the unmetered tail, rounded for display, or null with boxd's reason; `raw` is the
   * unrounded figure the budget compares; `estimated` is boxd's own flag on the figure.
   */
  today(context: CallTag): Promise<Today>
  /**
   * The budget from the last usage read only, with no CLI call: what the report shows. Undefined with no `budget`
   * option, or before any read today.
   */
  cachedBudget(): BudgetState | undefined
}

export interface Today {
  readonly machines: number | null
  readonly raw: number | null
  readonly currency: string | null
  readonly complete: boolean
  readonly estimated: boolean
  readonly unavailable?: string
}

/** The rates and the cached budget of a cost port, with boxd's public rates for a port that is not this one (a fake). */
export function internalsOf(cost: CostPort): Pick<CostInternals, "rates" | "cachedBudget"> {
  const internals = cost as Partial<CostInternals>
  return {
    rates: typeof internals.rates === "function" ? () => internals.rates!() : () => PUBLIC_RATES.EUR,
    cachedBudget: typeof internals.cachedBudget === "function" ? () => internals.cachedBudget!() : () => undefined,
  }
}

export function createCost(core: CostCore): CostInternals {
  let usage: { readonly day: string; readonly at: number; readonly value: Usage } | undefined
  let rates: { readonly at: number; readonly value: Rates } | undefined
  const now = () => core.clock.now()
  const op = (call: CallTag): OpContext => ({ call, pool: "background" })

  const currentRates = (): Rates => (rates && now().getTime() - rates.at <= RATES_CACHE_MS ? rates.value : PUBLIC_RATES.EUR)

  async function todayUsage(call: CallTag): Promise<Usage> {
    const day = localMidnight(now())
    if (usage && usage.day === day && now().getTime() - usage.at <= USAGE_CACHE_MS) return usage.value
    return core.runner.singleFlight(`cost:usage:${day}`, async () => {
      let value: Usage
      try {
        value = await core.boxd.usage(day, op(call))
      } catch (error) {
        // A failed read is not cached: the next call tries again.
        return { available: false, reason: `boxd manage usage failed: ${error instanceof Error ? error.message.split("\n")[0]!.slice(0, 160) : String(error)}` } as const
      }
      usage = { day, at: now().getTime(), value }
      if (value.available) rates = { at: now().getTime(), value: value.rates }
      return value
    })
  }

  function todayOf(value: Usage): Today {
    if (!value.available) return { machines: null, raw: null, currency: null, complete: false, estimated: true, unavailable: value.reason }
    const tail = value.complete ? 0 : figures(counted(core.watch.snapshot().works), currentRates()).perHour * (UNMETERED_MINUTES / 60)
    const raw = value.total + tail
    return { machines: Math.round(raw * 100) / 100, raw, currency: value.currency, complete: value.complete, estimated: value.estimated || !value.complete }
  }
  const today = async (call: CallTag) => todayOf(await todayUsage(call))

  /** The budget compares the unrounded figure; `today` in the answer is rounded for display only. */
  function budgetOf(day: Today): BudgetState | undefined {
    const option = core.options.budget
    if (!option) return undefined
    const state = day.raw === null ? "unknown" : day.raw >= option.daily ? "reached" : "ok"
    return { daily: option.daily, today: day.machines, action: option.action, state }
  }
  const budget = async (call: CallTag) => (core.options.budget ? budgetOf(await today(call)) : undefined)
  const cachedBudget = () => (core.options.budget && usage && usage.day === localMidnight(now()) ? budgetOf(todayOf(usage.value)) : undefined)

  /** Machine cost per work since the oldest open work was created, matched by machine id; null for a member. */
  async function perWork(works: readonly WorkSnapshot[], call: CallTag): Promise<Map<string, number> | null> {
    const records = await core.ledger.list({}, op(call))
    const oldest = records.reduce<string | undefined>((min, record) => (min === undefined || record.createdAt < min ? record.createdAt : min), undefined)
    const since = oldest === undefined ? localMidnight(now()) : new Date(oldest).toISOString().replace(/\.\d{3}Z$/, "Z")
    let value: Usage
    try {
      value = await core.boxd.usage(since, op(call))
    } catch {
      return null
    }
    if (!value.available) return null
    const byMachine = new Map(value.machines.map((machine) => [machine.machineId as string, machine.cost]))
    return new Map(works.flatMap((work) => (work.machineId && byMachine.has(work.machineId) ? [[work.workId, money(byMachine.get(work.machineId)!)] as const] : [])))
  }

  /** The ledger's machine-hours, from its records alone: every work, today, and since the oldest open work. */
  async function ledgerHours(call: CallTag): Promise<CostHours> {
    const records = await core.ledger.list({ closed: true }, op(call))
    const at = now()
    const day = localDay(at)
    const oldest = records.filter((record) => record.state === "open").reduce<number | undefined>((min, record) => {
      const at = Date.parse(record.createdAt)
      return Number.isNaN(at) ? min : min === undefined || at < min ? at : min
    }, undefined)
    let ledgerExisted = 0
    let ledgerRunning = 0
    let todayExisted = 0
    let todayRunning = 0
    let sinceExisted = 0
    let sinceRunning = 0
    for (const record of records) {
      const hours = hoursAt(record, at)
      ledgerExisted += hours.existedSeconds
      ledgerRunning += hours.runningSeconds
      if (hours.day === day) {
        todayExisted += hours.todayExistedSeconds
        todayRunning += hours.todayRunningSeconds
      }
      const created = Date.parse(record.createdAt)
      if (oldest !== undefined && !Number.isNaN(created) && created >= oldest) {
        sinceExisted += hours.existedSeconds
        sinceRunning += hours.runningSeconds
      }
    }
    return {
      ledger: { existed: asHours(ledgerExisted), running: asHours(ledgerRunning) },
      today: { existed: asHours(todayExisted), running: asHours(todayRunning) },
      since: oldest === undefined ? { existed: 0, running: 0 } : { existed: asHours(sinceExisted), running: asHours(sinceRunning) },
    }
  }

  const port: CostInternals = {
    rates: currentRates,
    today,
    cachedBudget,
    async block(options, call): Promise<CostBlock> {
      const [day, hours] = await Promise.all([today(call), ledgerHours(call)])
      const works = counted(core.watch.snapshot().works)
      const rate = currentRates()
      const fleet = figures(works, rate)
      const block: CostBlock = {
        currency: rate.currency,
        perHour: { estimate: fleet.perHour, running: fleet.running, asleep: fleet.asleep, basis: basis(rate), ratesSource: rate.source },
        // boxd machine cost only: model spend is not measured.
        today: {
          machines: day.machines,
          complete: day.complete,
          ...(day.unavailable ? { unavailable: day.unavailable } : {}),
        },
        hours,
      }
      if (!options.works) return block
      const machine = day.machines === null ? null : await perWork(works, call)
      const rows = [...fleet.works]
        .sort((a, b) => b.perHour - a.perHour || a.workId.localeCompare(b.workId))
        .slice(0, Math.max(0, options.limit))
        .map((row) => ({ workId: row.workId, machine: machine?.get(row.workId) ?? null, model: null, perHour: row.perHour }))
      return { ...block, works: rows }
    },
    async cleanup(): Promise<readonly CleanupAction[]> {
      return suggestions(counted(core.watch.snapshot().works), currentRates())
    },
    automation: () => automationState(core.options, sharedOf(port)),
    budget,
    async assertBudget(call) {
      if (!core.options.budget) return
      const day = await today(call)
      const state = budgetOf(day)
      if (!state || state.action !== "refuse" || state.state !== "reached") return
      const currency = day.currency ?? currentRates().currency
      const estimate = day.estimated ? " (boxd's estimate)" : ""
      throw boxdError(
        "BUDGET_REACHED",
        `Today's machine cost${estimate}, ${currency} ${state.today!.toFixed(2)}, has reached the budget's daily limit of ${currency} ${state.daily.toFixed(2)}, and budget.action is refuse. A call that would make a machine run is refused.`,
        { today: state.today, daily: state.daily, currency },
      )
    },
  }
  sharedOf(port)
  return port
}
