/**
 * The fleet's cost and its cleanup suggestions, computed from the watcher's snapshot alone (design §C.4): no CLI call,
 * no guest read. Pure functions, so status, the hooks and `/boxd-cleanup` agree on every figure. Package E owns this file.
 *
 * Each suggestion matches exactly one row of the selector table in §C.4, so a suggested call acts on the works it
 * counted (C2 resolves the selector again at call time, against a fresh listing):
 *
 * | Tool | `select` | Matches |
 * |---|---|---|
 * | `boxd_sleep` | `idle` | running works whose phase is `idle` or `ready`, not waiting on a person |
 * | `boxd_sleep` | `finished` | `idle` works whose last run has an outcome, not waiting on a person |
 * | `boxd_harvest` | `unsaved-finished` | finished works (running or asleep) whose `saved` is not `fresh` |
 * | `boxd_drop` | `saved-finished` | works with `saved: fresh` and outcome `completed`, running or asleep, not busy |
 */
import type { Rates, WorkSnapshot } from "../ports.js"
import type { CleanupAction } from "../results.js"
import { isRunning, money, perHour, sleepSaving } from "./rates.js"

export type SelectName = CleanupAction["select"]

const notWaiting = (work: WorkSnapshot) => work.needsInput === undefined

/** Whether a snapshot work matches a selector of §C.4. */
export function matches(select: SelectName, work: WorkSnapshot): boolean {
  switch (select) {
    case "idle":
      return (work.phase === "idle" || work.phase === "ready") && notWaiting(work)
    case "finished":
      return work.phase === "idle" && work.outcome !== null && notWaiting(work)
    case "unsaved-finished":
      return (work.phase === "idle" || work.phase === "asleep") && work.outcome !== null && work.saved !== "fresh"
    case "saved-finished":
      return work.saved === "fresh" && work.outcome === "completed" && work.phase !== "busy" && (isRunning(work.phase) || work.phase === "asleep")
  }
}

export const workPerHour = (work: WorkSnapshot, rates: Rates) => perHour(work.phase, work.size, work.reading, rates)

export interface FleetFigures {
  readonly perHour: number
  readonly running: number
  readonly asleep: number
  readonly works: ReadonlyArray<{ readonly workId: string; readonly perHour: number }>
}

/** The fleet's estimated cost per hour, and each work's. */
export function figures(works: readonly WorkSnapshot[], rates: Rates): FleetFigures {
  let total = 0
  let running = 0
  let asleep = 0
  const each: { workId: string; perHour: number }[] = []
  for (const work of works) {
    const hour = workPerHour(work, rates)
    total += hour
    if (isRunning(work.phase)) running++
    else if (work.phase === "asleep") asleep++
    each.push({ workId: work.workId, perHour: money(hour) })
  }
  return { perHour: money(total), running, asleep, works: each }
}

const call = (tool: string, select: SelectName) => `${tool}({ select: "${select}" })`

/**
 * The suggested actions, in the order a person or an agent should take them: the sleep of finished works, then the
 * broader sleep of every idle work when it reaches more, then the harvest that a drop needs, then the drop. Each names
 * one call and how much it saves.
 */
export function suggestions(works: readonly WorkSnapshot[], rates: Rates): CleanupAction[] {
  const of = (select: SelectName) => works.filter((work) => matches(select, work))
  const sleepSaves = (list: readonly WorkSnapshot[]) => money(list.reduce((sum, work) => sum + sleepSaving(work.size, work.reading, rates), 0))
  const sleeps: CleanupAction[] = []
  const finished = of("finished")
  const idle = of("idle")
  // `finished` first: the narrowest safe sleep, the one §C.4 leads with; `idle` only when it reaches more works.
  if (finished.length) sleeps.push({ action: "sleep", select: "finished", works: finished.length, savesPerHour: sleepSaves(finished), call: call("boxd_sleep", "finished") })
  if (idle.length > finished.length) sleeps.push({ action: "sleep", select: "idle", works: idle.length, savesPerHour: sleepSaves(idle), call: call("boxd_sleep", "idle") })
  const out = [...sleeps]
  const unsaved = of("unsaved-finished")
  if (unsaved.length) {
    const noun = unsaved.length === 1 ? "work is" : "works are"
    out.push({ action: "harvest", select: "unsaved-finished", works: unsaved.length, why: `${unsaved.length} finished ${noun} not saved; drop needs a harvest`, call: call("boxd_harvest", "unsaved-finished") })
  }
  const saved = of("saved-finished")
  if (saved.length) out.push({ action: "drop", select: "saved-finished", works: saved.length, savesPerDay: money(saved.reduce((sum, work) => sum + workPerHour(work, rates), 0) * 24), call: call("boxd_drop", "saved-finished") })
  return out
}

/** A currency's sign for the short lines: € and $, or the code and a space. */
export const sign = (currency: string) => (currency === "EUR" ? "€" : currency === "USD" ? "$" : `${currency} `)

/** Money for a line: two decimals. */
export const shown = (currency: string, value: number) => `${sign(currency)}${value.toFixed(2)}`

/**
 * What a figure from these rates is labelled with: nothing for the organisation's own rates; for a member, who cannot
 * read them, the public rates' currency, so a figure is never presented as the organisation's own currency.
 */
export const ratesLabel = (rates: Rates) => (rates.source === "public" ? ` (public ${rates.currency} rates)` : "")
/** The same, inside parentheses that are already open. */
export const ratesNote = (rates: Rates) => (rates.source === "public" ? `, public ${rates.currency} rates` : "")
