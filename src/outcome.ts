// What the guest session's last run did. OpenCode records it on the session (`outcome`) and on its last idle message,
// with the failure's structured error beside it, so the plugin reads it from what the guest or the imported transcript
// already holds: never from a model call, and never by asking the guest to run anything.
import { shortReason } from "./redact.js"
import type { RunOutcome } from "./ports.js"

export interface GuestRun {
  readonly outcome: RunOutcome | null
  /** A failed run's error as `<type>: <first line>`, redacted; absent otherwise. */
  readonly error?: string
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
export function failureCode(run: GuestRun): "GUEST_AUTH_FAILED" | "RUN_FAILED" {
  return isCredentialFailure(run) ? "GUEST_AUTH_FAILED" : "RUN_FAILED"
}
