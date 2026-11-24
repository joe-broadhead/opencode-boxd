/**
 * The words the idle check adds (design §C.4): the burn note. Built only from the plugin's own fields (phases from their
 * fixed set, validated work ids, money and the exact calls), never from guest text, so nothing a guest model wrote can
 * reach a coordinator's context this way. Package E owns this file.
 */
import { assertWorkId } from "../names.js"
import type { Rates, WorkSnapshot } from "../ports.js"
import type { AutomationState, BudgetState } from "../results.js"
import { matches, ratesNote, sign, workPerHour } from "./fleet.js"
import { isRunning } from "./rates.js"

/** The idle check speaks about a work waiting on a person once its idle cost passes this, in the billing currency. */
export const NEEDS_INPUT_THRESHOLD = 1

/** A work id the plugin itself would accept, or nothing: the guard that keeps any other string out of a line. */
function safeId(id: string): string | undefined {
  try {
    assertWorkId(id)
    return id
  } catch {
    return undefined
  }
}

export interface LineInput {
  readonly works: readonly WorkSnapshot[]
  readonly rates: Rates
  readonly automation: AutomationState
  readonly budget?: BudgetState
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
