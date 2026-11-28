/**
 * Package D's fleet model: how a work's phase is read from its record, the machine listing and the last guest read,
 * and the one guest read that status, job and the watcher share (design §3.1, §3.2, §3.13). Package D owns this file.
 *
 * The rules it keeps:
 *
 * - **A read never wakes a machine.** A guest read runs only for a machine that a listing at most 2 s old shows
 *   `running` (the runner enforces it), uses only the helper already on the machine
 *   `phase`), and never uploads anything or writes the ledger.
 * - **Status and the watcher never read an idle guest:** an inbound exec resets the machine's idle clock, so polling an
 *   idle or ready work would keep it awake. Only `busy`, `starting`, `creating` or unknown works are read, and a work a
 *   prompt reached since its last read.
 * - **Guest text stays data.** `lastText` and `tail` are redacted and cut; a failed run's words become a §5 code
 *   before they reach an event or a notice.
 * - **A work is its whole session tree.** Its phase is `busy` while any session in it (the root and every child its
 *   subagents started) is active, and `lastActivityAt` is the newest session time in the tree, never older than the
 *   root's last assistant message. The helper follows every page of the session listing; a listing that fails or cannot
 *   finish fails the read, so a read that could not see the whole tree never answers idle.
 */
import { BoxdError, isCode, type Code } from "../errors.js"
import type { Phase, WorkRecord } from "../ledger/types.js"
import type { DoneReport, Listing, MachineRow, OpContext, PhaseAnswer, Reading, ReadTarget, RunOutcome } from "../ports.js"
import { excerpt } from "../redact.js"
import { failureCode } from "../outcome.js"
import type { CoreServices } from "../services.js"

/** What the plugin last knew about one work's guest, from a guest read or an event; kept in memory per process. */
export interface Observed {
  readonly phase: Phase
  readonly outcome: RunOutcome | null
  /** A §5 code only. */
  readonly code?: Code
  readonly needsInput?: "form" | "permission"
  readonly reading?: Reading & { readonly at: string }
  /** When the phase was last confirmed by a guest read, in epoch milliseconds. */
  readonly readAt?: number
  /** When the work entered this phase, as an ISO time. */
  readonly since: string
  readonly lastText?: string
  readonly lastActivityAt?: string
  /** The guest's done report from the newest read; a read without one clears it. */
  readonly done?: DoneReport
  readonly waiting?: { readonly steer: number; readonly queue: number }
  readonly guestVersion?: string | null
  readonly modelCost?: number
  /** Guest reads that failed in a row: two make the work `unreachable`. */
  readonly failures: number
  /** Sweeps in a row whose listing did not show the machine: two make the work `gone`. */
  readonly absent: number
}

/** The phases a guest read may refresh; an idle, ready or asleep work is never read by status or the watcher. */
export const READABLE: ReadonlySet<Phase> = new Set<Phase>(["busy", "starting", "creating"])

/**
 * `lastText`'s limits: 200 characters in status, 300 in `boxd_job` and in the watcher's cache of an observed work.
 * A `boxd_job` read with `full: true` returns up to `FULL_TEXT_LIMIT` in its result, never in the cache.
 */
export const STATUS_TEXT_LIMIT = 200
export const JOB_TEXT_LIMIT = 300

const time = (iso: string | undefined) => (iso ? Date.parse(iso) : Number.NaN)

/** The machine row a record names, by region and name; undefined when the listing has none. */
export function rowOf(record: WorkRecord, listing: Listing | undefined): MachineRow | undefined {
  if (!listing || record.region === null) return undefined
  return listing.machines.find((machine) => machine.region === record.region && machine.name === record.machine)
}

/** What the record alone says about a running machine: never prompted, a prompt after the last run, or idle. */
export function recordPhase(record: WorkRecord): Phase {
  if (!record.lastSubmit) return "ready"
  const ran = time(record.run?.at)
  return Number.isNaN(ran) || ran < time(record.lastSubmit.at) ? "busy" : "idle"
}

/** True when a prompt reached the work after the last thing the plugin observed of its guest. */
export function promptedSince(record: WorkRecord, observed: Observed | undefined): boolean {
  if (!record.lastSubmit) return false
  const seen = observed?.readAt ?? time(observed?.since)
  return Number.isNaN(seen) || time(record.lastSubmit.at) > seen
}

/**
 * A work's phase now, from its record, the listing (undefined when it could not be read), and what was last observed.
 * A missing machine reads `gone` here; deciding that a work is gone for good belongs to drop's two-check rule.
 */
export function phaseOf(record: WorkRecord, listing: Listing | undefined, observed: Observed | undefined): Phase {
  if (record.state === "closed") return "closed"
  if (record.region === null) return "gone"
  if (!listing) return observed?.phase ?? recordPhase(record)
  const row = rowOf(record, listing)
  if (!row) return record.pendingCreate ? "creating" : "gone"
  switch (row.status) {
    case "running":
      return runningPhase(record, observed)
    case "starting":
      return "starting"
    case "hibernated":
    case "stopped":
    case "standby":
      return "asleep"
    case "destroyed":
      return "gone"
    default:
      return "unreachable"
  }
}

function runningPhase(record: WorkRecord, observed: Observed | undefined): Phase {
  if (observed && !promptedSince(record, observed) && ["busy", "idle", "ready", "unreachable"].includes(observed.phase)) return observed.phase
  return recordPhase(record)
}

/** Whether status or the watcher may read this work's guest now: running, prompted, and not idle by what it knows. */
export function wantsRead(record: WorkRecord, listing: Listing, observed: Observed | undefined, now: number, maxAgeMs: number): boolean {
  if (record.state !== "open" || !record.session?.rootId || record.region === null) return false
  if (rowOf(record, listing)?.status !== "running") return false
  if (observed?.readAt !== undefined && now - observed.readAt < maxAgeMs && !promptedSince(record, observed)) return false
  // With nothing observed yet, the record is the cached phase: a prompt after the last run is the only reason to read.
  if (observed === undefined) return recordPhase(record) === "busy"
  if (promptedSince(record, observed)) return true
  return READABLE.has(observed.phase) || observed.phase === "unreachable"
}

/** The read target for a work: by name, with the listing that shows it running (design §4.1, L-g). */
export function readTarget(record: WorkRecord, listing: Listing): ReadTarget {
  return { region: record.region!, name: record.machine, listing, machineId: record.machineId }
}

/**
 * One guest read: the helper's `phase`, under the read rule; never uploads anything and never writes the ledger.
 */
export function readGuest(
  services: Pick<CoreServices, "guest">,
  record: WorkRecord,
  listing: Listing,
  input: { readonly tail?: number; readonly full?: boolean },
  context: OpContext,
): Promise<PhaseAnswer> {
  const sessionId = record.session!.rootId!
  const target = readTarget(record, listing)
  return services.guest.phase(target, { sessionId, ...(input.tail ? { tail: input.tail } : {}), ...(input.full ? { full: true } : {}) }, context)
}

/** A guest answer as what the plugin knows: the phase, the run, a §5 code for a failure, and the cut guest text. */
export function observe(answer: PhaseAnswer, previous: Observed | undefined, at: Date, limit = JOB_TEXT_LIMIT): Observed {
  const phase: Phase = answer.phase === "busy" ? "busy" : "idle"
  const code: Code | undefined =
    answer.phase === "missing" ? "SESSION_MISSING" : answer.outcome === "failed" ? failureCode({ outcome: "failed", ...(answer.error ? { error: answer.error } : {}) }) : undefined
  const lastText = answer.lastText ? excerpt(answer.lastText, limit) : undefined
  return {
    phase,
    outcome: answer.outcome,
    ...(code ? { code } : {}),
    ...(answer.needsInput ? { needsInput: answer.needsInput } : {}),
    ...(answer.reading ? { reading: { ...answer.reading, at: at.toISOString() } } : previous?.reading ? { reading: previous.reading } : {}),
    readAt: at.getTime(),
    since: previous && previous.phase === phase ? previous.since : at.toISOString(),
    ...(lastText ? { lastText } : {}),
    ...(answer.lastActivityAt ? { lastActivityAt: answer.lastActivityAt } : {}),
    ...(answer.done ? { done: answer.done } : {}),
    waiting: answer.waiting,
    guestVersion: answer.guestVersion,
    ...(answer.modelCost !== undefined ? { modelCost: answer.modelCost } : {}),
    failures: 0,
    absent: 0,
  }
}

/**
 * True for a read that was not made, rather than one that failed: the read rule refused it (the machine is not running
 * in a fresh listing, `kind: "not-readable"`, or no listing young enough could be had, `kind: "listing-stale"`), the
 * listing it needed failed (`kind: "listing-failed"`), or the call stopped it. The work keeps its cached phase, marked stale (design §3.1 step 3); it is never a guest failure.
 */
export function notRead(error: unknown): boolean {
  if (!(error instanceof BoxdError)) return false
  return error.code === "CANCELLED" || ["not-readable", "listing-stale", "listing-failed"].includes(String(error.details.kind))
}

/**
 * A failed guest read as what the plugin knows: it counts, and two in a row make the work `unreachable` with the
 * failure's code. A read that was not made (`notRead`) never comes here.
 */
export function observeFailure(error: unknown, previous: Observed | undefined, fallback: Phase, at: Date): Observed {
  const code: Code = error instanceof BoxdError && isCode(error.code) ? error.code : "BOXD_FAILED"
  const failures = (previous?.failures ?? 0) + 1
  const phase: Phase = failures >= 2 ? "unreachable" : (previous?.phase ?? fallback)
  return { ...base(previous, phase, at), failures, ...(failures >= 2 ? { code } : {}) }
}

/** An observation of a phase the listing or an event showed, keeping what the last read said. */
export function base(previous: Observed | undefined, phase: Phase, at: Date): Observed {
  const kept: Observed = previous ?? { phase, outcome: null, since: at.toISOString(), failures: 0, absent: 0 }
  return { ...kept, phase, since: previous && previous.phase === phase ? previous.since : at.toISOString() }
}

/** The outcome a work shows: the last read's, else the record's. */
export function outcomeOf(record: WorkRecord, observed: Observed | undefined): RunOutcome | null {
  if (observed && observed.readAt !== undefined) return observed.outcome
  return observed?.outcome ?? record.run?.outcome ?? null
}

/** A failed run's code, from what was observed or the record's own run. */
export function codeOf(record: WorkRecord, observed: Observed | undefined): Code | undefined {
  if (observed?.code) return observed.code
  if (record.run?.outcome === "failed") return failureCode({ outcome: "failed", ...(record.run.error ? { error: record.run.error } : {}) })
  return undefined
}

/**
 * The work's done report: the newest of the last read's and the record's, or undefined when neither has one. A prompt
 * after the report clears it, whether the read is older than the prompt or the record's report predates the submit.
 */
export function doneOf(record: WorkRecord, observed: Observed | undefined): DoneReport | undefined {
  const live = observed && !promptedSince(record, observed) ? observed.done : undefined
  const candidates = [live, record.done].filter((report): report is DoneReport => report !== undefined)
  const report = candidates.sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0]
  if (!report) return undefined
  const submitted = time(record.lastSubmit?.at)
  return !Number.isNaN(submitted) && submitted > Date.parse(report.at) ? undefined : report
}
