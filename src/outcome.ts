// What the guest session's last run did. OpenCode records it on the session (`outcome`) and on its last idle message,
// with the failure's structured error beside it, so the plugin reads it from what the guest or the imported transcript
// already holds: never from a model call, and never by asking the guest to run anything.
import { shortReason } from "./redact.js"
import { CODES } from "./errors.js"

/** The three states the plugin reports. */
export type RunOutcome = "completed" | "failed" | "aborted"

export interface GuestRun {
  readonly outcome: RunOutcome | null
  /** A failed run's error as `<type>: <first line>`, redacted; absent otherwise. */
  readonly error?: string
}

const STATES: Record<string, RunOutcome> = { succeeded: "completed", failed: "failed", interrupted: "aborted" }

/** OpenCode's word for a run's outcome as the plugin's, or null when it has none. */
export function mapOutcome(value: unknown): RunOutcome | null {
  return typeof value === "string" ? (STATES[value] ?? null) : null
}

interface StructuredError {
  readonly type?: unknown
  readonly message?: unknown
}

/**
 * The error line: the error's type and the first line of its message, redacted and cut. A structured error's `response`
 * body is never read, because it can hold a provider's request and a token.
 */
export function errorLine(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const { type, message } = error as StructuredError
  const text = shortReason(typeof message === "string" ? message : "")
  if (!text) return undefined
  const name = typeof type === "string" && /^[a-z][\w.-]{0,40}$/i.test(type) ? type : "error"
  return shortReason(`${name}: ${text}`)
}

/**
 * A run read from a session's info and its messages, as `GET /api/session/<id>` and `/message`, or an export, hold
 * them. The session's own `outcome` wins; the last idle message fills a gap and carries the error.
 */
export function readRun(info: unknown, messages?: unknown): GuestRun {
  const session = info && typeof info === "object" ? (info as { outcome?: unknown }) : {}
  let outcome = mapOutcome(session.outcome)
  let error: string | undefined
  if (Array.isArray(messages)) {
    for (const message of [...messages].reverse()) {
      if (!message || typeof message !== "object") continue
      const record = message as { type?: unknown; outcome?: unknown; error?: unknown }
      if (record.type !== "idle") continue
      outcome ??= mapOutcome(record.outcome)
      if (outcome === "failed") error = errorLine(record.error)
      break
    }
  }
  return { outcome, ...(error ? { error } : {}) }
}

/**
 * Whether a failure is about the guest's model credentials, which is the one class with its own next step: the image
 * needs a working sign-in before another prompt can succeed.
 */
export function isCredentialFailure(run: GuestRun): boolean {
  if (run.outcome !== "failed" || !run.error) return false
  return /provider\.auth|auth|api.?key|credential|unauthori[sz]ed|forbidden|401|403|sign.?in/i.test(run.error)
}

/**
 * The code a failed run reports, from the one table: a credential failure has its own next step, because the image
 * needs a working sign-in before another prompt can succeed.
 */
export function failureCode(run: GuestRun): "GUEST_AUTH_FAILED" | "GUEST_RUN_FAILED" {
  return isCredentialFailure(run) ? "GUEST_AUTH_FAILED" : "GUEST_RUN_FAILED"
}

/** The one next step for a failed run, as the code's next step and the harvest's. */
export function nextStepFor(run: GuestRun): string {
  return CODES[failureCode(run)]
}

/** The sentence a failed run puts in front of a status or a tool result. */
export function failureText(run: GuestRun, workId: string): string {
  return `The last run of ${workId} failed${run.error ? ` (${run.error})` : ""}.`
}
