/**
 * What one handler call carries, and the two input rules every boxd method shares.
 *
 * A handler never touches a tool, the RPC or a permission rule: `contract.register` owns those doors. This module
 * only describes a call and the `select` convention the list methods share (`boxd_sleep`, `boxd_harvest`, `boxd_drop`).
 */
import { BoxdError, boxdError } from "./errors.js"
import type { Refusal } from "./results.js"

/** A call's source, its signal, and which door it came by. */
export interface CallContext {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
  /** `model` subscribes the caller's root session to notices by default; `rpc` keeps the existing one. */
  readonly via: "model" | "rpc"
  /**
   * For a `select` call only: the work ids the selector matched. The run acts on exactly these, never on a second
   * match, so the person's prompt named every work that changes.
   */
  readonly matched?: readonly string[]
}

/** What a list method's `select` accepts. */
export interface SelectionSpec {
  /** The method's id, such as `boxd_drop`. */
  readonly id: string
  /** Whether the single form, the list form and `select` are alternatives. */
  readonly list: boolean
  /** The `select` values the method takes; none for most methods. */
  readonly selects?: readonly string[]
}

const WORK_PATTERN = "^[a-z][a-z0-9-]{0,24}$"
const WORK_ID = new RegExp(WORK_PATTERN)

/** The work a call named, when it is a valid id: a refusal says which work it is about. */
function subjectOf(input: Record<string, unknown>): Pick<Refusal, "workId" | "machine"> {
  const workId = typeof input.workId === "string" && WORK_ID.test(input.workId) ? input.workId : undefined
  return workId ? { workId, machine: `oc-${workId}` } : {}
}

/** A coded error as a result: the same shape as any answer, with its state, code, sentence, next step and facts. */
export function refusalResult(error: BoxdError, input: Record<string, unknown> = {}): Refusal {
  return { ...subjectOf(input), ...error.details, state: error.state ?? "failed", error: error.code, message: error.what, next: error.next }
}

const invalid = (field: string, message: string) => boxdError("NAME_INVALID", message, { field })

/**
 * How a call names its works, checked before anything runs. A list method takes exactly one of `workId`, `works` and
 * (where the method has selectors) `select`; `dryRun` only with `select`; a method without selectors takes neither.
 */
export function selectionOf(spec: SelectionSpec, input: Record<string, unknown>): string | undefined {
  const { select, dryRun } = input
  if (select !== undefined) {
    if (!spec.selects?.length) throw invalid("select", `${spec.id} takes no select.`)
    if (typeof select !== "string" || !(spec.selects as readonly string[]).includes(select)) {
      throw invalid("select", `select must be one of ${spec.selects.map((value) => `"${value}"`).join(", ")}.`)
    }
  }
  if (dryRun !== undefined) {
    if (select === undefined) throw invalid("dryRun", "dryRun is taken only with select.")
    if (typeof dryRun !== "boolean") throw invalid("dryRun", "dryRun must be true or false.")
  }
  if (spec.list) {
    const named = (["workId", "works", "select"] as const).filter((key) => input[key] !== undefined)
    if (named.length !== 1) {
      const ways = spec.selects?.length ? "workId, works or select" : "workId or works"
      throw invalid(named[1] ?? "workId", `Pass exactly one of ${ways}${named.length ? `, not ${named.join(" and ")}` : ""}.`)
    }
  }
  return typeof select === "string" ? select : undefined
}
