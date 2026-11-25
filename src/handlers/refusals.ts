/**
 * The contract's one error table (contract §12) over boxd's own codes.
 *
 * A handler's internal failure is a `BoxdError` (or a `SourceError` from the events module) with a precise code. The
 * contract's table is closed, and the standard says a plugin uses the contract's codes rather than declaring its own, so
 * each internal code maps to the nearest contract code here; the precise sentence and the one next step travel
 * unchanged in the refusal. A code the table does not hold is `UNAVAILABLE`.
 */
import type { ErrorCode } from "@we-the-rebel-alliance/plugin-contract/events"
import { refusal, RegisterError } from "@we-the-rebel-alliance/plugin-contract/register"
import { BoxdError, type Code } from "../errors.js"
import type { Refusal } from "../results.js"

/** boxd's code to the contract's. The value is the family the failure belongs to, not a rename of the same sentence. */
export const CONTRACT_CODE: Readonly<Record<Code, ErrorCode>> = {
  // Setup and options.
  HOST_UNTESTED: "HOST_UNTESTED",
  OPTIONS_INVALID: "OPTIONS_INVALID",
  STATUS_UNAVAILABLE: "UNAVAILABLE",
  SKILLS_INVALID: "UNAVAILABLE",
  RULES_NOT_ADDED: "UNAVAILABLE",
  // Input.
  NAME_INVALID: "INPUT_INVALID",
  PATH_REFUSED: "INPUT_INVALID",
  FILE_TOO_LARGE: "TOO_LARGE",
  FILE_CONFLICT: "INPUT_INVALID",
  // Which machine.
  NOT_OURS: "INPUT_INVALID",
  NOT_REASSIGNABLE: "INPUT_INVALID",
  MACHINE_LIMIT: "UNAVAILABLE",
  REGION_NOT_ALLOWED: "INPUT_INVALID",
  SIZE_UNAVAILABLE: "UNAVAILABLE",
  MACHINE_STARTING: "UNAVAILABLE",
  MACHINE_GONE: "INPUT_INVALID",
  MACHINE_ASLEEP: "INPUT_INVALID",
  AGENT_UNREACHABLE: "UNAVAILABLE",
  // Golden images.
  GOLDEN_MISSING: "INPUT_INVALID",
  GOLDEN_BUILD_FAILED: "UNAVAILABLE",
  GOLDEN_HAS_CREDENTIAL: "INPUT_INVALID",
  // The machine.
  MACHINE_SHARED: "INPUT_INVALID",
  MACHINE_ISOLATED: "INPUT_INVALID",
  // The session.
  SESSION_BUSY: "UNAVAILABLE",
  SESSION_MISSING: "UNAVAILABLE",
  RUN_FAILED: "UNAVAILABLE",
  RUN_INTERRUPTED: "UNAVAILABLE",
  // The guest.
  GUEST_AUTH_FAILED: "NEEDS_SIGN_IN",
  GUEST_VERSION: "INPUT_INVALID",
  GUEST_UNRESPONSIVE: "UNAVAILABLE",
  GUEST_SERVER_DOWN: "UNAVAILABLE",
  GUEST_FAILED: "UNAVAILABLE",
  GUEST_WORKSPACE: "UNAVAILABLE",
  // Files and git.
  NOT_SAVED: "INPUT_INVALID",
  UNTRACKED: "INPUT_INVALID",
  UNPUSHED: "UNAVAILABLE",
  UNPUSHED_UNKNOWN: "UNAVAILABLE",
  DIRTY: "INPUT_INVALID",
  GIT_UNKNOWN: "UNAVAILABLE",
  EXPORT_INVALID: "INPUT_INVALID",
  IMPORT_FAILED: "UNAVAILABLE",
  // The CLI and the runner.
  BOXD_FAILED: "UNAVAILABLE",
  BOXD_MISSING: "NEEDS_SIGN_IN",
  TIMEOUT: "UNAVAILABLE",
  CANCELLED: "UNAVAILABLE",
  CREATE_UNCERTAIN: "UNAVAILABLE",
  // The ledger.
  LEDGER_FAILED: "UNAVAILABLE",
  LEDGER_LOCKED: "UNAVAILABLE",
  // Cost and cleanup.
  BUDGET_REACHED: "BUDGET_EXCEEDED",
}

/** The contract code for a boxd code, or `UNAVAILABLE` for one the table above does not hold. */
export const contractCodeOf = (code: string): ErrorCode => (CONTRACT_CODE as Readonly<Record<string, ErrorCode>>)[code] ?? "UNAVAILABLE"

/** A result refusal as the contract's error form. */
export function contractRefusal(result: Refusal): RegisterError {
  return new RegisterError(refusal(contractCodeOf(result.error), result.message, result.next))
}

/** A thrown internal failure as the contract's error form: a `BoxdError` keeps its sentence and next step. */
export function contractFailure(error: unknown): RegisterError {
  if (error instanceof RegisterError) return error
  if (error instanceof BoxdError) return new RegisterError(refusal(contractCodeOf(error.code), error.what, error.next))
  return new RegisterError(refusal("UNAVAILABLE", error instanceof Error ? error.message.split("\n", 1)[0] ?? "boxd failed" : String(error), "Try again; if it keeps failing, run /boxd and follow its next step."))
}
