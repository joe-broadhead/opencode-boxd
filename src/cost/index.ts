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
import type { CallTag, FleetWatch, OpContext, Rates, Usage, WorkSnapshot } from "../ports.js"
import type { BudgetState, CleanupAction, CostBlock } from "../results.js"
import type { CoreServices, CostPort } from "../services.js"
import { figures, suggestions } from "./fleet.js"
import { BASIS, money, PUBLIC_RATES } from "./rates.js"
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
  /** Today's machine cost with the unmetered tail, or null with boxd's reason. */
  today(context: CallTag): Promise<{ readonly machines: number | null; readonly complete: boolean; readonly unavailable?: string }>
  /**
   * The budget from the last usage read only, with no CLI call: what the hooks show. Undefined with no `budget`
   * option, or before any read today.
   */
  cachedBudget(): BudgetState | undefined
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

  function todayOf(value: Usage) {
    if (!value.available) return { machines: null, complete: false, unavailable: value.reason }
    const tail = value.complete ? 0 : figures(counted(core.watch.snapshot().works), currentRates()).perHour * (UNMETERED_MINUTES / 60)
    return { machines: Math.round((value.total + tail) * 100) / 100, complete: value.complete }
  }
  const today = async (call: CallTag) => todayOf(await todayUsage(call))

  function budgetOf(machines: number | null): BudgetState | undefined {
    const option = core.options.budget
    if (!option) return undefined
    const state = machines === null ? "unknown" : machines >= option.daily ? "reached" : "ok"
    return { daily: option.daily, today: machines, action: option.action, state }
  }
  const budget = async (call: CallTag) => (core.options.budget ? budgetOf((await today(call)).machines) : undefined)
  const cachedBudget = () => (core.options.budget && usage && usage.day === localMidnight(now()) ? budgetOf(todayOf(usage.value).machines) : undefined)

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

  const port: CostInternals = {
    rates: currentRates,
    today,
    cachedBudget,
    async block(options, call): Promise<CostBlock> {
      const day = await today(call)
      const works = counted(core.watch.snapshot().works)
      const rate = currentRates()
      const fleet = figures(works, rate)
      const block: CostBlock = {
        currency: rate.currency,
        perHour: { estimate: fleet.perHour, running: fleet.running, asleep: fleet.asleep, basis: BASIS, ratesSource: rate.source },
        today: {
          machines: day.machines,
          // Model spend is OpenCode's own USD estimate per session; the watcher's snapshot does not carry it yet.
          models: { currency: "USD", total: 0 },
          complete: day.complete,
          ...(day.unavailable ? { unavailable: day.unavailable } : {}),
        },
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
      const state = await budget(call)
      if (!state || state.action !== "refuse" || state.state !== "reached") return
      const currency = currentRates().currency
      throw boxdError(
        "BUDGET_REACHED",
        `Today's machine cost, ${currency} ${state.today?.toFixed(2)}, has reached the budget's daily limit of ${currency} ${state.daily.toFixed(2)}, and budget.action is refuse. A call that would make a machine run is refused.`,
        { today: state.today, daily: state.daily, currency },
      )
    },
  }
  sharedOf(port)
  return port
}
