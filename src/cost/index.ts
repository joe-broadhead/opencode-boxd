/**
 * Package E's cost service (design §C.4, §C.5): rates, the per-hour estimate, today, the cleanup suggestions, the
 * budget and the automation state, for D's status and C1's and C2's budget checks. Package E owns `src/cost/*`.
 *
 * Every figure but `today` and the machine counts comes from the watcher's snapshot, with no CLI call. `today` is one
 * `manage usage --since <local midnight>` read, shared by concurrent callers and kept for 10 minutes; while boxd has not
 * marked the period complete (up to 25 minutes), the estimate for the last 25 minutes is added. The rates come from the
 * same read, and are kept for a day; a member, who cannot read usage, gets boxd's public rates, marked `public`. The
 * machine counts reuse the all-region listing status already took; `budget.daily` alone never reads usage when it is
 * unset, and the machine caps never need an owner's sign-in.
 */
import { boxdError } from "../errors.js"
import { hoursAt, localDay } from "../ledger/hours.js"
import type { WorkRecord } from "../ledger/types.js"
import { budgetLabelMatch, type Budget, type BudgetLabel } from "../options.js"
import { TIMEOUTS, type CallTag, type FleetWatch, type Listing, type OpContext, type Rates, type Region, type Usage, type WorkSnapshot } from "../ports.js"
import type { BudgetLabelState, BudgetState, CleanupAction, CostBlock, CostHours } from "../results.js"
import type { CoreServices, CostPort } from "../services.js"
import { figures, suggestions, workPerHour } from "./fleet.js"
import { labelMachineCount, machineCounts, matchesLabel, type MachineCounts } from "./machines.js"
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
   * The daily budget from the last usage read only, with no CLI call. Undefined with no `budget.daily`, before any read
   * today, or when the option also has a machine cap, whose count this cached answer does not hold.
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

/** The rates now, with boxd's public ones when the cost port cannot answer (a test's empty port). */
export function ratesOf(cost: CostPort): Rates {
  try {
    return internalsOf(cost).rates()
  } catch {
    return PUBLIC_RATES.EUR
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

  /** Hours rounded to 3 decimals, a second of machine time, for the answer; the comparison uses the unrounded figure. */
  const roundHours = (value: number) => Math.round(value * 1000) / 1000
  const shownHours = (value: number) => `${roundHours(value).toFixed(2)} h`

  /** The budget compares unrounded figures; the answer's figures are rounded for display only. */
  function budgetState(option: Budget, day: Today, hours: number, counts: MachineCounts | undefined, labels: readonly BudgetLabelState[] | undefined): BudgetState {
    const money = option.daily === undefined ? "ok" : day.raw === null ? "unknown" : day.raw >= option.daily ? "reached" : "ok"
    const hoursState = option.machineHours === undefined ? "ok" : hours >= option.machineHours ? "reached" : "ok"
    const machines = option.machines === undefined ? "ok" : counts === undefined ? "unknown" : counts.ledger >= option.machines ? "reached" : "ok"
    const orgMachines = option.orgMachines === undefined ? "ok" : counts === undefined ? "unknown" : counts.org >= option.orgMachines ? "reached" : "ok"
    const states = [money, hoursState, machines, orgMachines, ...(labels ?? []).map((label) => label.state)]
    const state: BudgetState["state"] = states.includes("reached") ? "reached" : states.includes("unknown") ? "unknown" : "ok"
    return {
      ...(option.daily === undefined ? {} : { daily: option.daily }),
      today: option.daily === undefined ? null : day.machines,
      ...(option.machineHours === undefined ? {} : { machineHours: { today: roundHours(hours), cap: option.machineHours } }),
      ...(option.machines !== undefined && counts !== undefined ? { machines: { inUse: counts.ledger, limit: option.machines } } : {}),
      ...(option.orgMachines !== undefined && counts !== undefined ? { orgMachines: { inUse: counts.org, limit: option.orgMachines } } : {}),
      ...(labels && labels.length > 0 ? { labels } : {}),
      action: option.action,
      state,
    }
  }

  /** Today's running hours over the records that carry `match`, or every record: closed ones included, because a machine dropped today still ran. */
  function hoursTodayOf(records: readonly WorkRecord[], at: Date, match?: ReturnType<typeof budgetLabelMatch>): number {
    const day = localDay(at)
    return records.reduce((sum, record) => {
      if (match && !matchesLabel(record.labels, match)) return sum
      const hours = hoursAt(record, at)
      // A work closed on an earlier day keeps that day's counters; they are not today's.
      return hours.day === day ? sum + Math.max(0, hours.todayRunningSeconds) / 3600 : sum
    }, 0)
  }

  /** Today's running hours over every work the ledger holds. */
  async function hoursToday(call: CallTag): Promise<number> {
    return hoursTodayOf(await core.ledger.list({ closed: true }, op(call)), now())
  }

  /** The matching works' estimated cost per day, at the same per-hour figures as the fleet's own estimate. */
  function perDayOf(works: readonly WorkSnapshot[], match: string): number {
    const parsed = budgetLabelMatch(match)
    if (!parsed) return 0
    const rate = currentRates()
    return works.reduce((sum, work) => (matchesLabel(work.labels, parsed) ? sum + workPerHour(work, rate) : sum), 0) * 24
  }

  /** One label cap with its figures; `add` is a create this call is about to make. */
  function labelState(
    entry: BudgetLabel,
    records: readonly WorkRecord[],
    ledgerId: string,
    listing: Listing | undefined,
    add?: { readonly region: Region; readonly machine: string; readonly creates: boolean },
  ): BudgetLabelState {
    const match = budgetLabelMatch(entry.match)!
    const machines = entry.machines === undefined || listing === undefined ? undefined : labelMachineCount(listing, records, ledgerId, match, add)
    const hours = entry.machineHours === undefined ? undefined : hoursTodayOf(records, now(), match)
    const perDay = entry.daily === undefined ? undefined : perDayOf(core.watch.snapshot().works, entry.match)
    const states = [
      entry.machines === undefined ? "ok" : machines === undefined ? "unknown" : machines >= entry.machines ? "reached" : "ok",
      entry.machineHours === undefined ? "ok" : hours! >= entry.machineHours ? "reached" : "ok",
      entry.daily === undefined ? "ok" : perDay! >= entry.daily ? "reached" : "ok",
    ]
    const state: BudgetLabelState["state"] = states.includes("reached") ? "reached" : states.includes("unknown") ? "unknown" : "ok"
    return {
      match: entry.match,
      ...(entry.machines !== undefined && machines !== undefined ? { machines: { inUse: machines, limit: entry.machines } } : {}),
      ...(entry.machineHours !== undefined ? { machineHours: { today: roundHours(hours!), cap: entry.machineHours } } : {}),
      ...(entry.daily !== undefined ? { daily: { perDay: money(perDay!), cap: entry.daily } } : {}),
      state,
    }
  }

  interface BudgetFacts {
    readonly day: Today
    readonly hours: number
    readonly counts: MachineCounts | undefined
    readonly labels: readonly BudgetLabelState[] | undefined
    readonly records: readonly WorkRecord[]
  }

  async function currentBudget(
    call: CallTag,
    facts?: { readonly listing?: Listing; readonly inFlight?: number; readonly add?: { readonly region: Region; readonly machine: string; readonly creates: boolean } },
  ): Promise<BudgetFacts> {
    const option = core.options.budget
    const labelCaps = option?.labels
    const needsRecords = option !== undefined && (option.machineHours !== undefined || option.machines !== undefined || option.orgMachines !== undefined || labelCaps !== undefined)
    const records = needsRecords ? await core.ledger.list({ closed: true }, op(call)) : []
    const needsListing = option !== undefined && (option.machines !== undefined || option.orgMachines !== undefined || labelCaps?.some((label) => label.machines !== undefined) === true)
    const listing = needsListing ? (facts?.listing ?? (await core.boxd.list({ maxAgeMs: TIMEOUTS.phaseListingMaxAgeMs }, op(call)))) : undefined
    const ledgerId =
      option !== undefined && (option.machines !== undefined || option.orgMachines !== undefined || labelCaps !== undefined) ? await core.ledger.id(op(call)) : undefined
    const counts =
      option !== undefined && (option.machines !== undefined || option.orgMachines !== undefined)
        ? machineCounts(listing!, ledgerId!, records, facts?.inFlight)
        : undefined
    const hours = option?.machineHours === undefined ? 0 : hoursTodayOf(records, now())
    const day = option?.daily === undefined ? noUsage : await today(call)
    const labels = labelCaps?.map((entry) => labelState(entry, records, ledgerId!, listing, facts?.add))
    return { day, hours, counts, labels, records }
  }

  const noUsage: Today = { machines: null, raw: null, currency: null, complete: false, estimated: false }

  const budget = async (call: CallTag, facts?: { readonly listing?: Listing }) => {
    const option = core.options.budget
    if (!option) return undefined
    const current = await currentBudget(call, facts)
    return budgetState(option, current.day, current.hours, current.counts, current.labels)
  }
  const cachedBudget = () => {
    const option = core.options.budget
    if (!option || option.labels !== undefined || option.machineHours !== undefined || option.machines !== undefined || option.orgMachines !== undefined || !usage || usage.day !== localMidnight(now())) return undefined
    return budgetState(option, todayOf(usage.value), 0, undefined, undefined)
  }

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

  /** The ledger's machine-seconds and their estimate, from its records alone: every work, today, and since the oldest open work. */
  async function ledgerHours(call: CallTag): Promise<CostHours> {
    const records = await core.ledger.list({ closed: true }, op(call))
    const at = now()
    const day = localDay(at)
    const rates = currentRates()
    const oldest = records.filter((record) => record.state === "open").reduce<number | undefined>((min, record) => {
      const at = Date.parse(record.createdAt)
      return Number.isNaN(at) ? min : min === undefined || at < min ? at : min
    }, undefined)
    let ledgerExisted = 0
    let ledgerRunning = 0
    let ledgerAsleep = 0
    let ledgerCost = 0
    let todayExisted = 0
    let todayRunning = 0
    let todayAsleep = 0
    let todayCost = 0
    let sinceExisted = 0
    let sinceRunning = 0
    let sinceAsleep = 0
    let sinceCost = 0
    let ledgerLabel: Pick<CostHours["ledger"]["estimate"], "currency" | "ratesSource"> | undefined
    let todayLabel: typeof ledgerLabel
    let sinceLabel: typeof ledgerLabel
    const labelOf = (hours: ReturnType<typeof hoursAt>) => ({ currency: hours.currency, ratesSource: hours.ratesSource })
    for (const record of records) {
      const hours = hoursAt(record, at, rates)
      ledgerLabel ??= labelOf(hours)
      ledgerExisted += hours.existedSeconds
      ledgerRunning += hours.runningSeconds
      ledgerAsleep += hours.asleepSeconds
      ledgerCost += hours.cost
      if (hours.day === day) {
        todayLabel ??= labelOf(hours)
        todayExisted += hours.todayExistedSeconds
        todayRunning += hours.todayRunningSeconds
        todayAsleep += hours.todayAsleepSeconds
        todayCost += hours.todayCost
      }
      const created = Date.parse(record.createdAt)
      if (oldest !== undefined && !Number.isNaN(created) && created >= oldest) {
        sinceLabel ??= labelOf(hours)
        sinceExisted += hours.existedSeconds
        sinceRunning += hours.runningSeconds
        sinceAsleep += hours.asleepSeconds
        sinceCost += hours.cost
      }
    }
    const work = (existed: number, running: number, asleep: number, amount: number, label: typeof ledgerLabel): CostHours["ledger"] => ({
      seconds: { existed: Math.round(existed), running: Math.round(running), asleep: Math.round(asleep) },
      estimate: { amount: money(amount), ...(label ?? { currency: rates.currency, ratesSource: rates.source }) },
    })
    return {
      ledger: work(ledgerExisted, ledgerRunning, ledgerAsleep, ledgerCost, ledgerLabel),
      today: work(todayExisted, todayRunning, todayAsleep, todayCost, todayLabel),
      since: work(oldest === undefined ? 0 : sinceExisted, oldest === undefined ? 0 : sinceRunning, oldest === undefined ? 0 : sinceAsleep, oldest === undefined ? 0 : sinceCost, sinceLabel),
    }
  }

  const port: CostInternals = {
    rates: currentRates,
    today,
    cachedBudget,
    async block(options, call): Promise<CostBlock> {
      // The usage read also refreshes the rates, so the ledger's estimate is labelled with the currency it read.
      const day = await today(call)
      const hours = await ledgerHours(call)
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
      const option = core.options.budget
      if (!option) return
      const hours = option.machineHours === undefined ? 0 : await hoursToday(call)
      const day = option.daily === undefined ? noUsage : await today(call)
      const currency = day.currency ?? currentRates().currency
      const estimate = day.estimated ? " (boxd's estimate)" : ""
      const daily = option.daily
      const cap = option.machineHours
      const cost = day.machines
      const money = daily !== undefined && day.raw !== null && cost !== null && day.raw >= daily
      const machineHours = cap !== undefined && hours >= cap
      if (option.action !== "refuse" || (!money && !machineHours)) return
      const clauses = [
        ...(money && daily !== undefined && cost !== null
          ? [`today's machine cost${estimate}, ${currency} ${cost.toFixed(2)}, has reached the budget's daily limit of ${currency} ${daily.toFixed(2)}`]
          : []),
        ...(machineHours && cap !== undefined ? [`today's machine-hours, ${shownHours(hours)}, have reached the budget's limit of ${shownHours(cap)}`] : []),
      ]
      const sentence = clauses.join(", and ")
      throw boxdError(
        "BUDGET_REACHED",
        `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}, and budget.action is refuse. A call that would make a machine run is refused.`,
        {
          ...(money && daily !== undefined ? { today: cost, daily, currency } : {}),
          ...(machineHours && cap !== undefined ? { machineHours: { today: roundHours(hours), cap } } : {}),
        },
      )
    },
    async assertCreateBudget(call, facts) {
      const option = core.options.budget
      if (!option) return
      const hasGlobal = option.machines !== undefined || option.orgMachines !== undefined
      const hasLabels = option.labels !== undefined && option.labels.length > 0
      if (!hasGlobal && !hasLabels) return
      const current = await currentBudget(call, {
        ...(facts?.listing ? { listing: facts.listing } : {}),
        ...(facts?.inFlight !== undefined ? { inFlight: facts.inFlight } : {}),
        ...(facts?.machine && facts.region ? { add: { region: facts.region, machine: facts.machine, creates: facts.createsMachine !== false } } : {}),
      })
      if (option.action !== "refuse") return
      const ledger = option.machines !== undefined && current.counts !== undefined && current.counts.ledger >= option.machines
      const org = option.orgMachines !== undefined && current.counts !== undefined && current.counts.org >= option.orgMachines
      if (ledger || org) {
        const scope = ledger ? "machines" : "orgMachines"
        const inUse = ledger ? current.counts!.ledger : current.counts!.org
        const cap = ledger ? option.machines! : option.orgMachines!
        const what =
          scope === "machines"
            ? `This ledger holds ${inUse} machine${inUse === 1 ? "" : "s"}, at budget.machines ${cap}`
            : `The organisation holds ${inUse} machine${inUse === 1 ? "" : "s"}, at budget.orgMachines ${cap}`
        throw boxdError("BUDGET_REACHED", `${what}, and budget.action is refuse. A call that would create another machine is refused.`, { scope, inUse, cap })
      }
      const hits: Array<{ readonly match: string; readonly scope: "machines" | "machineHours" | "daily"; readonly inUse: number; readonly cap: number; readonly what: string }> = []
      for (const entry of option.labels ?? []) {
        const match = budgetLabelMatch(entry.match)
        if (!match || !matchesLabel(facts?.labels, match)) continue
        const state = current.labels?.find((label) => label.match === entry.match)
        if (!state) continue
        if (entry.machines !== undefined && facts?.createsMachine !== false && state.machines && state.machines.inUse >= entry.machines) {
          const inUse = state.machines.inUse
          hits.push({
            match: entry.match,
            scope: "machines",
            inUse,
            cap: entry.machines,
            what: `the label ${entry.match} holds ${inUse} machine${inUse === 1 ? "" : "s"}, at budget.labels machines ${entry.machines}`,
          })
        }
        if (entry.machineHours !== undefined && state.machineHours && state.machineHours.today >= entry.machineHours) {
          const inUse = state.machineHours.today
          hits.push({
            match: entry.match,
            scope: "machineHours",
            inUse,
            cap: entry.machineHours,
            what: `the label ${entry.match} has run ${shownHours(inUse)}, at budget.labels machineHours ${shownHours(entry.machineHours)}`,
          })
        }
        if (entry.daily !== undefined && state.daily && state.daily.perDay >= entry.daily) {
          const inUse = state.daily.perDay
          hits.push({
            match: entry.match,
            scope: "daily",
            inUse,
            cap: entry.daily,
            what: `the label ${entry.match} is estimated at ${currentRates().currency} ${inUse.toFixed(2)} per day, at budget.labels daily ${currentRates().currency} ${entry.daily.toFixed(2)}`,
          })
        }
      }
      if (hits.length === 0) return
      const sentence = hits.map((hit) => hit.what).join(", and ")
      const first = hits[0]!
      throw boxdError(
        "BUDGET_REACHED",
        `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}, and budget.action is refuse. A call that would create another machine is refused.`,
        { scope: "labels", match: first.match, inUse: first.inUse, cap: first.cap },
      )
    },
  }
  sharedOf(port)
  return port
}
