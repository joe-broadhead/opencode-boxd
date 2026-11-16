/**
 * The words the hooks add (design §C.4): the fleet line, the compaction part and the idle note. Built only from the
 * plugin's own fields (counts, phases from their fixed set, validated work ids, money and the exact calls), never from
 * guest text, so nothing a guest model wrote can reach a coordinator's context this way. Package E owns this file.
 */
import { assertWorkId } from "../names.js"
import { PHASES, type Phase } from "../ledger/types.js"
import type { Rates, WorkSnapshot } from "../ports.js"
import type { AutomationState, BudgetState } from "../results.js"
import { matches, ratesLabel, ratesNote, sign, suggestions, workPerHour } from "./fleet.js"
import { isRunning } from "./rates.js"

/** The fleet line's limit, in characters (about 50 tokens). */
export const LINE_MAX = 240
/** The compaction part names at most this many works. */
export const COMPACTION_MAX_IDS = 30
/** The idle check speaks about a work waiting on a person once its idle cost passes this, in the billing currency. */
export const NEEDS_INPUT_THRESHOLD = 1

const PHASE_ORDER: readonly Phase[] = ["busy", "idle", "ready", "starting", "creating", "unreachable", "asleep"]

/** A work id the plugin itself would accept, or nothing: the guard that keeps any other string out of a line. */
function safeId(id: string): string | undefined {
  try {
    assertWorkId(id)
    return id
  } catch {
    return undefined
  }
}

const unsaved = (work: WorkSnapshot) => work.saved !== "fresh" && (work.phase === "idle" || work.phase === "asleep" || work.phase === "ready")

/** Money rounded to the nearest 0.10, so the line and its fingerprint move only on a real change. */
const coarse = (value: number) => Math.round(value * 10) / 10

export interface LineInput {
  readonly works: readonly WorkSnapshot[]
  readonly rates: Rates
  readonly automation: AutomationState
  readonly budget?: BudgetState
}

export interface FleetLine {
  readonly text: string
  /** The coarse figures the line is made of: the line is added only when this changes. */
  readonly fingerprint: string
}

/** The fleet line for a coordinator: counts by phase, unsaved works, the cost per hour, and the first cleanup call. */
export function fleetLine(input: LineInput): FleetLine {
  const works = input.works.filter((work) => work.phase !== "closed" && work.phase !== "gone")
  const counts = new Map<Phase, number>()
  for (const work of works) counts.set(work.phase, (counts.get(work.phase) ?? 0) + 1)
  const unsavedIdle = works.filter((work) => work.phase === "idle" && unsaved(work)).length
  const running = works.filter((work) => isRunning(work.phase)).reduce((sum, work) => sum + workPerHour(work, input.rates), 0)
  const money = (value: number) => `${sign(input.rates.currency)}${coarse(value).toFixed(2)}`
  const phases = PHASE_ORDER.flatMap((phase) => {
    const count = counts.get(phase)
    if (!count) return []
    return [phase === "idle" && unsavedIdle ? `${count} idle (${unsavedIdle} unsaved)` : `${count} ${phase}`]
  })
  const first = suggestions(works, input.rates)[0]
  const cleanup = first ? ` Cleanup: ${first.call}${first.savesPerHour ? ` saves ~${money(first.savesPerHour)}/h` : ""}.` : ""
  const automation = input.automation.startsWith("off") ? ` Automation ${input.automation}: cleaning up is yours.` : ""
  const budget =
    input.budget && input.budget.state !== "ok"
      ? input.budget.state === "unknown"
        ? " Budget not measurable (BUDGET_UNKNOWN)."
        : ` Budget reached: ${money(input.budget.today ?? 0)} of ${money(input.budget.daily)} today (boxd's estimate).`
      : ""
  const head = `boxd: ${works.length} works — ${phases.join(", ") || "none running"}; ~${money(running)}/h running${ratesLabel(input.rates)}.`
  // The parts in order of importance; a part that would pass the limit is left out.
  let text = head
  for (const part of [budget, cleanup, automation]) if (part && text.length + part.length <= LINE_MAX) text += part
  const fingerprint = JSON.stringify([[...counts].sort(), unsavedIdle, coarse(running), first?.call ?? null, input.automation, input.budget?.state ?? null])
  return { text: text.slice(0, LINE_MAX), fingerprint }
}

const KNOWN_PHASES: ReadonlySet<string> = new Set(PHASES)

/** The open works as `id (phase)`, at most `COMPACTION_MAX_IDS`, and how many more: plugin ids and known phases only. */
export function openWorks(works: readonly WorkSnapshot[]): string {
  const open = works.filter((work) => work.phase !== "closed" && work.phase !== "gone")
  const named = open.flatMap((work) => {
    const id = safeId(work.workId)
    if (!id) return []
    return [KNOWN_PHASES.has(work.phase) ? `${id} (${work.phase})` : id]
  })
  const shown = named.slice(0, COMPACTION_MAX_IDS)
  const more = open.length - shown.length
  return `boxd works open: ${shown.join(", ") || "none"}${more > 0 ? `, and ${more} more` : ""}`
}

/** The compaction part: the open works with their phase, at most 30 ids, asking the summary to keep them. */
export function compactionText(works: readonly WorkSnapshot[]): string {
  return `Keep this list in the summary: ${openWorks(works)}; boxd_status lists all.`
}

export type BurnReason = "idle-running" | "sleep-failed" | "needs-input" | "budget"

export interface IdleInput extends LineInput {
  readonly now: Date
  /** Works whose automatic harvest or sleep failed. */
  readonly failed: ReadonlySet<string>
}

export interface Burn {
  readonly reasons: readonly BurnReason[]
  /** What the note is about: the reasons and the burning work ids. Silent while it is unchanged. */
  readonly fingerprint: string
  readonly text: string
}

/**
 * Whether money is burning that automation will not stop (§C.4): running idle works while automation is off; works
 * whose automatic sleep failed; works waiting on a person past `NEEDS_INPUT_THRESHOLD` of idle cost; a reached or
 * unmeasurable budget. Undefined when nothing burns. The note names counts, the cost per hour and one call.
 */
export function burning(input: IdleInput): Burn | undefined {
  const works = input.works.filter((work) => isRunning(work.phase))
  const automationOn = input.automation === "on" || input.automation === "on (consent)" || input.automation === "not-owner"
  const idle = works.filter((work) => matches("idle", work))
  const reasons: BurnReason[] = []
  const ids = new Set<string>()
  const sentences: string[] = []
  const perHour = (list: readonly WorkSnapshot[]) => list.reduce((sum, work) => sum + workPerHour(work, input.rates), 0)
  const money = (value: number) => `${sign(input.rates.currency)}${value.toFixed(2)}`

  if (!automationOn && idle.length) {
    reasons.push("idle-running")
    for (const work of idle) ids.add(work.workId)
    sentences.push(`${idle.length} idle ${idle.length === 1 ? "work is" : "works are"} running (~${money(perHour(idle))}/h${ratesNote(input.rates)}) and auto-sleep is ${input.automation}.`)
  }
  const failed = works.filter((work) => input.failed.has(work.workId) && work.phase !== "busy")
  if (failed.length) {
    reasons.push("sleep-failed")
    for (const work of failed) ids.add(work.workId)
    sentences.push(`Auto-sleep failed for ${failed.length} running ${failed.length === 1 ? "work" : "works"} (~${money(perHour(failed))}/h${ratesNote(input.rates)}).`)
  }
  const waiting = works.filter((work) => {
    if (work.needsInput === undefined || !work.idleSince) return false
    const hours = Math.max(0, input.now.getTime() - Date.parse(work.idleSince)) / 3_600_000
    return workPerHour(work, input.rates) * hours > NEEDS_INPUT_THRESHOLD
  })
  if (waiting.length) {
    reasons.push("needs-input")
    for (const work of waiting) ids.add(work.workId)
    const names = waiting.flatMap((work) => (safeId(work.workId) ? [`oc-${work.workId}`] : [])).slice(0, 3)
    sentences.push(`${waiting.length} ${waiting.length === 1 ? "work waits" : "works wait"} on a person (${names.join(", ")}); ask the person to answer it with boxd connect.`)
  }
  if (input.budget && input.budget.state === "reached") {
    reasons.push("budget")
    sentences.push(`Today's machine cost has reached the budget (${money(input.budget.today ?? 0)} of ${money(input.budget.daily)}, boxd's estimate).`)
  }
  if (!reasons.length) return undefined
  const call = idle.length || failed.length || reasons.includes("budget") ? 'Call boxd_sleep({ select: "idle" }) or say why not.' : "Say why they wait."
  const fingerprint = JSON.stringify([reasons, [...ids].sort()])
  return { reasons, fingerprint, text: `boxd: ${sentences.join(" ")} ${call}` }
}
