/**
 * The machine time and its cost a work's record carries (design §C.4). The ledger counts the interval between two
 * phase changes into `MeteredHours`: the time a machine existed (every phase but `gone` and `closed`), the time it ran
 * (the running phases of `cost/rates.ts`), the time it was asleep, and each in the current local day. The same interval
 * is priced at `perHour(previous phase, size, last reading, rates)` with the rates current at that change, and a slot
 * work is charged its share of its shared machine. No boxd call and no owner's sign-in is needed.
 *
 * A read that shows the figure adds the interval from the record's last change to now, without writing: the next phase
 * change counts from that same last change, so no second or fraction of money is counted twice.
 */
import { isRunning, money, perHour, PUBLIC_RATES } from "../cost/rates.js"
import type { Rates, Reading, Size } from "../ports.js"
import type { MeteredHours, Phase, WorkRecord } from "./types.js"

/** Phases in which the work's machine exists: every phase but gone and closed. */
const exists = (phase: Phase) => phase !== "gone" && phase !== "closed"

/** `YYYY-MM-DD` in this machine's local day. */
export function localDay(at: Date): string {
  const year = at.getFullYear()
  const month = String(at.getMonth() + 1).padStart(2, "0")
  const day = String(at.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

/** The first instant of `at`'s local day. */
function startOfDay(at: Date): number {
  const local = new Date(at)
  local.setHours(0, 0, 0, 0)
  return local.getTime()
}

/** What prices one counted interval: the work's machine, the last guest reading, the rates and its share of the machine. */
export interface HoursFacts {
  readonly size: Size
  readonly rates: Rates
  readonly reading?: Reading
  readonly share?: number
}

/** The counters before the first phase change: nothing counted yet, in the current rates' currency. */
function zero(phase: Phase, at: Date, facts: HoursFacts): MeteredHours {
  const share = facts.share ?? 1
  return {
    existedSeconds: 0,
    runningSeconds: 0,
    asleepSeconds: 0,
    todayExistedSeconds: 0,
    todayRunningSeconds: 0,
    todayAsleepSeconds: 0,
    cost: 0,
    todayCost: 0,
    currency: facts.rates.currency,
    ratesSource: facts.rates.source,
    ...(facts.reading ? { reading: facts.reading } : {}),
    share,
    day: localDay(at),
    phase,
    at: at.toISOString(),
  }
}

/**
 * One record's counters, counted to `phase` at `at`: the elapsed interval goes to the phase that was current before,
 * at the rates current now. A currency change starts `cost` and `todayCost` again in the new currency rather than adding
 * two currencies. A record from before money was counted keeps its seconds and starts its money at this interval.
 */
export function countHours(previous: MeteredHours | undefined, phase: Phase, at: Date, facts: HoursFacts): MeteredHours {
  const now = at.getTime()
  const day = localDay(at)
  if (!previous) return zero(phase, at, facts)
  const last = Date.parse(previous.at)
  const start = Number.isNaN(last) ? now : Math.min(last, now)
  const elapsed = Math.max(0, now - start) / 1000
  // A gap that crosses local midnight counts only its part after midnight into today's counters; the cumulative
  // counters keep the whole interval.
  const today = Math.max(0, now - Math.max(start, startOfDay(at))) / 1000
  const sameDay = previous.day === day
  const sameCurrency = (previous.currency ?? facts.rates.currency) === facts.rates.currency
  const share = facts.share ?? previous.share ?? 1
  const reading = facts.reading ?? previous.reading
  const hour = perHour(previous.phase, facts.size, reading, facts.rates)
  const intervalCost = (elapsed / 3600) * hour * share
  const todayIntervalCost = (today / 3600) * hour * share
  // Another currency starts the money counters again, rather than adding two currencies. An interval that costs
  // nothing (gone, or no elapsed time) leaves the recorded money, its currency and its source as they were.
  const priced = intervalCost > 0 || todayIntervalCost > 0
  const switched = priced && !sameCurrency
  return {
    existedSeconds: previous.existedSeconds + (exists(previous.phase) ? elapsed : 0),
    runningSeconds: previous.runningSeconds + (isRunning(previous.phase) ? elapsed : 0),
    asleepSeconds: (previous.asleepSeconds ?? 0) + (previous.phase === "asleep" ? elapsed : 0),
    todayExistedSeconds: (sameDay ? previous.todayExistedSeconds : 0) + (exists(previous.phase) ? today : 0),
    todayRunningSeconds: (sameDay ? previous.todayRunningSeconds : 0) + (isRunning(previous.phase) ? today : 0),
    todayAsleepSeconds: (sameDay ? (previous.todayAsleepSeconds ?? 0) : 0) + (previous.phase === "asleep" ? today : 0),
    cost: switched ? intervalCost : (previous.cost ?? 0) + intervalCost,
    todayCost: switched ? todayIntervalCost : (sameDay ? (previous.todayCost ?? 0) : 0) + todayIntervalCost,
    currency: priced ? facts.rates.currency : (previous.currency ?? facts.rates.currency),
    ratesSource: priced ? facts.rates.source : (previous.ratesSource ?? facts.rates.source),
    ...(reading ? { reading } : {}),
    share,
    day,
    phase,
    at: at.toISOString(),
  }
}

/**
 * The counters as they read now: the record's last change plus the interval since, with no write. A closed work stops
 * at its close even when no closed event was recorded; a record with no counters reads zero.
 */
export function hoursAt(record: Pick<WorkRecord, "hours" | "state" | "closed" | "size">, now: Date, rates: Rates = PUBLIC_RATES.EUR): MeteredHours {
  if (!record.hours) {
    const facts = { size: record.size, rates }
    return zero(record.state === "closed" ? "closed" : "creating", now, facts)
  }
  const until = record.state === "closed" && record.closed && record.hours.phase !== "closed" ? new Date(record.closed.at) : now
  return countHours(record.hours, record.hours.phase, until, {
    size: record.size,
    rates,
    ...(record.hours.reading ? { reading: record.hours.reading } : {}),
    ...(record.hours.share !== undefined ? { share: record.hours.share } : {}),
  })
}

/** The displayed seconds and estimate: whole machine-seconds and money to four decimals. */
export const shownWorkHours = (hours: MeteredHours) => ({
  seconds: {
    existed: Math.round(Math.max(0, hours.existedSeconds)),
    running: Math.round(Math.max(0, hours.runningSeconds)),
    asleep: Math.round(Math.max(0, hours.asleepSeconds ?? 0)),
  },
  estimate: {
    amount: money(Math.max(0, hours.cost ?? 0)),
    currency: hours.currency ?? PUBLIC_RATES.EUR.currency,
    ratesSource: hours.ratesSource ?? PUBLIC_RATES.EUR.source,
  },
})
