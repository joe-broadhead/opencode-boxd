/**
 * The local days a work's counters already cover before `at`, split at every local midnight and priced, so the watcher
 * can append one cost event for each day that ended. This is #132's read of #130's counters: it adds no counter of its
 * own, and a day already reported is dropped by `appendEventOnce`'s marker.
 */
import { isRunning, money, perHour } from "./rates.js"
import { localDay } from "../ledger/hours.js"
import type { CostSeconds, MeteredDay, MeteredHours, Phase } from "../ledger/types.js"
import type { Rates, Reading, Size } from "../ports.js"

export interface Pricing {
  readonly rates: Rates
  readonly size: Size
  readonly reading?: Reading
  readonly share?: number
}

const exists = (phase: Phase) => phase !== "gone" && phase !== "closed"

const startOfDay = (day: string): number => {
  const [year, month, date] = day.split("-").map(Number)
  const local = new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1)
  local.setHours(0, 0, 0, 0)
  return local.getTime()
}

const nextDay = (day: string): string => {
  const next = new Date(startOfDay(day))
  next.setDate(next.getDate() + 1)
  return localDay(next)
}

const add = (seconds: CostSeconds, phase: Phase, elapsed: number): CostSeconds => ({
  existed: seconds.existed + (exists(phase) ? elapsed : 0),
  running: seconds.running + (isRunning(phase) ? elapsed : 0),
  asleep: seconds.asleep + (phase === "asleep" ? elapsed : 0),
})

/**
 * The local days before `at` that the record's last change covers, from its own day to yesterday, split at local
 * midnight and priced at the given reading and share. The first day starts from the counters' `today*` figures; every
 * later day starts from zero.
 */
export function endedDays(hours: MeteredHours, at: Date, pricing: Pricing): MeteredDay[] {
  const today = localDay(at)
  const hourRate = perHour(hours.phase, pricing.size, pricing.reading ?? hours.reading, pricing.rates) * (pricing.share ?? hours.share ?? 1)
  const last = Date.parse(hours.at)
  const start = Number.isNaN(last) ? at.getTime() : Math.min(last, at.getTime())
  const days: MeteredDay[] = []
  for (let day = hours.day; day < today; day = nextDay(day)) {
    const from = Math.max(start, startOfDay(day))
    const end = new Date(startOfDay(day))
    end.setDate(end.getDate() + 1)
    const elapsed = Math.max(0, end.getTime() - from) / 1000
    const own = day === hours.day
    const base = own
      ? { existed: hours.todayExistedSeconds, running: hours.todayRunningSeconds, asleep: hours.todayAsleepSeconds }
      : { existed: 0, running: 0, asleep: 0 }
    days.push({
      day,
      seconds: add(base, hours.phase, elapsed),
      amount: money((own ? hours.todayCost : 0) + hourRate * (elapsed / 3600)),
      currency: own ? hours.currency : pricing.rates.currency,
      ratesSource: own ? hours.ratesSource : pricing.rates.source,
    })
  }
  return days
}
