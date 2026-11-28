/**
 * The machine-hours a work's record carries (design §C.4). The ledger counts the interval between two phase changes
 * into `MeteredHours`: the time a machine existed (every phase but `gone` and `closed`) and the time it ran (the running
 * phases of `cost/rates.ts`), together with the part of it in the current local day. No boxd call and no owner's sign-in
 * is needed.
 *
 * A read that shows the figure adds the interval from the record's last change to now, without writing: the next phase
 * change counts from that same last change, so no second is counted twice.
 */
import { isRunning } from "../cost/rates.js"
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

/** Hours for a number of seconds, to two decimals. */
export const asHours = (seconds: number) => Math.round((Math.max(seconds, 0) / 3600) * 100) / 100

/** One record's counters, counted to `phase` at `at`: the elapsed interval goes to the phase that was current before. */
export function countHours(previous: MeteredHours | undefined, phase: Phase, at: Date): MeteredHours {
  const now = at.getTime()
  const day = localDay(at)
  if (!previous) return { existedSeconds: 0, runningSeconds: 0, todayExistedSeconds: 0, todayRunningSeconds: 0, day, phase, at: at.toISOString() }
  const last = Date.parse(previous.at)
  const start = Number.isNaN(last) ? now : Math.min(last, now)
  const elapsed = Math.max(0, now - start) / 1000
  // A gap that crosses local midnight counts only its part after midnight into today's counters; the cumulative
  // counters keep the whole interval.
  const today = Math.max(0, now - Math.max(start, startOfDay(at))) / 1000
  const sameDay = previous.day === day
  return {
    existedSeconds: previous.existedSeconds + (exists(previous.phase) ? elapsed : 0),
    runningSeconds: previous.runningSeconds + (isRunning(previous.phase) ? elapsed : 0),
    todayExistedSeconds: (sameDay ? previous.todayExistedSeconds : 0) + (exists(previous.phase) ? today : 0),
    todayRunningSeconds: (sameDay ? previous.todayRunningSeconds : 0) + (isRunning(previous.phase) ? today : 0),
    day,
    phase,
    at: at.toISOString(),
  }
}

/**
 * The counters as they read now: the record's last change plus the interval since, with no write. A closed work stops
 * at its close even when no closed event was recorded; a record with no counters reads zero.
 */
export function hoursAt(record: Pick<WorkRecord, "hours" | "state" | "closed">, now: Date): MeteredHours {
  if (!record.hours) return { existedSeconds: 0, runningSeconds: 0, todayExistedSeconds: 0, todayRunningSeconds: 0, day: localDay(now), phase: record.state === "closed" ? "closed" : "creating", at: now.toISOString() }
  const until = record.state === "closed" && record.closed && record.hours.phase !== "closed" ? new Date(record.closed.at) : now
  return countHours(record.hours, record.hours.phase, until)
}

/** The displayed hours: `existed` and `running`, in hours to two decimals. */
export const shownHours = (hours: MeteredHours) => ({ existed: asHours(hours.existedSeconds), running: asHours(hours.runningSeconds) })
