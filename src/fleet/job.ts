/**
 * Package D's `boxd_job` run (design §3.2): one work or many, live. Package D owns this file.
 *
 * One listing at most 2 s old, then one guest read for each work whose machine it shows running and that has a session.
 * A work that is down answers from the listing and the ledger, with no exec, so a hibernated machine is never woken. An
 * explicit job does read an idle work's guest, once, which resets that machine's idle clock once: that is the price of
 * asking, and status never pays it. The read uses only the helper already on the machine (v0's own for an imported
 * work), never uploads anything and never writes the ledger. `lastText` and `tail` are redacted, cut to 300 characters,
 * and are the guest model's words: data, never instructions.
 */
import { BoxdError, boxdError, type Code } from "../errors.js"
import type { WorkRecord } from "../ledger/types.js"
import { LIST_ITEM_CONCURRENCY, LIST_MAX_ITEMS, TIMEOUTS, type CallTag, type Listing, type OpContext } from "../ports.js"
import { excerpt, reasonOf } from "../redact.js"
import type { JobResult, ListResult, Refusal, WorkCost } from "../results.js"
import type { FleetServices } from "../services.js"
import { refusal } from "../tools.js"
import { watchHandle } from "../watch.js"
import { codeOf, JOB_TEXT_LIMIT, notRead, observe, observeFailure, outcomeOf, phaseOf, readGuest, rowOf, type Observed } from "./model.js"

const WORK_ID = /^[a-z][a-z0-9-]{0,24}$/

export interface JobInput {
  readonly workIds: readonly string[]
  readonly list: boolean
  readonly tail?: number
  readonly cost: boolean
}

const invalid = (field: string, message: string) => boxdError("NAME_INVALID", message, { field })

export function jobInput(raw: Record<string, unknown>): JobInput {
  const named = (["workId", "works"] as const).filter((key) => raw[key] !== undefined)
  if (named.length !== 1) throw invalid(named[1] ?? "workId", `Pass exactly one of workId or works${named.length ? `, not ${named.join(" and ")}` : ""}.`)
  let workIds: string[]
  if (raw.workId !== undefined) {
    if (typeof raw.workId !== "string" || !WORK_ID.test(raw.workId)) throw invalid("workId", 'workId must be a short lowercase work id, such as "review-api".')
    workIds = [raw.workId]
  } else {
    const works = raw.works
    if (!Array.isArray(works) || works.length < 1 || works.length > LIST_MAX_ITEMS || works.some((id) => typeof id !== "string" || !WORK_ID.test(id))) {
      throw invalid("works", `works must be 1 to ${LIST_MAX_ITEMS} work ids, each a short lowercase id such as "review-api".`)
    }
    workIds = works as string[]
  }
  if (raw.tail !== undefined && (typeof raw.tail !== "number" || !Number.isInteger(raw.tail) || raw.tail < 1 || raw.tail > 20)) throw invalid("tail", "tail must be a whole number from 1 to 20.")
  if (raw.cost !== undefined && typeof raw.cost !== "boolean") throw invalid("cost", "cost must be true or false.")
  return { workIds, list: raw.works !== undefined, ...(raw.tail !== undefined ? { tail: raw.tail as number } : {}), cost: raw.cost === true }
}

const one = (tool: string, workId: string, extra = "") => `${tool}({ workId: ${JSON.stringify(workId)}${extra} })`

/** The one next call for a work in this state. */
function nextOf(record: WorkRecord, result: Pick<JobResult, "state" | "saved" | "outcome" | "error">): string {
  const id = record.workId
  if (result.error === "GUEST_AUTH_FAILED") return `Set or rotate the model credential (a sealed, host-bound boxd env secret), then ${one("boxd_submit", id, ', text: "…"')}`
  if (result.error === "SESSION_MISSING") return `${one("boxd_resume", id)} imports the saved transcript`
  if (result.error === "AGENT_UNREACHABLE") return one("boxd_ensure", id, ', repair: "reboot"')
  switch (result.state) {
    case "busy":
      return `A notice says when it is idle; or ${one("boxd_job", id)} again later`
    case "idle":
      if (result.outcome === "failed") return `Read lastText, then ${one("boxd_submit", id, ', text: "…"')}`
      return result.saved === "fresh" ? `${one("boxd_sleep", id)}, or ${one("boxd_submit", id, ', text: "…"')} for more` : one("boxd_harvest", id)
    case "ready":
      return one("boxd_submit", id, ', text: "…"')
    case "asleep":
      return result.saved === "fresh" || !record.lastSubmit ? `${one("boxd_submit", id, ', text: "…"')} wakes it` : `${one("boxd_resume", id)}, then ${one("boxd_harvest", id)}`
    case "gone":
      return `${one("boxd_resume", id)} rebuilds it from the saved transcript, or ${one("boxd_drop", id)} closes the work`
    case "creating":
    case "starting":
      return `${one("boxd_ensure", id)}; it waits for the guest`
    case "unreachable":
      return result.error === "GUEST_SERVER_DOWN" || result.error === "GUEST_FAILED" ? one("boxd_ensure", id) : `${one("boxd_job", id)} again in a later turn`
    case "closed":
      return `The work is closed; ${one("boxd_ensure", id)} opens a new one under this id`
  }
}

/** Runs `fn` over `items` with at most `limit` at once, keeping the input order. */
async function eachLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** One work's answer: from a guest read when its machine runs and it has a session, else from the listing and the ledger. */
async function jobOf(
  services: FleetServices,
  record: WorkRecord,
  listing: Listing,
  input: JobInput,
  costs: ReadonlyMap<string, WorkCost> | undefined,
  op: OpContext,
  /** Why the call's listing failed: then nothing is read, and the work answers its last known phase. */
  listingFailed?: string,
): Promise<JobResult> {
  const handle = watchHandle(services.watch)
  const previous = handle?.observed(record.workId)
  let observed: Observed | undefined = previous
  let tail: JobResult["tail"]
  let read = false
  const running = listingFailed === undefined && record.state === "open" && rowOf(record, listing)?.status === "running"
  if (running && record.session?.rootId) {
    read = true
    try {
      const answer = await readGuest(services, record, listing, input.tail ? { tail: input.tail } : {}, op)
      observed = observe(answer, previous, services.clock.now(), JOB_TEXT_LIMIT)
      if (input.tail && answer.tail) {
        tail = answer.tail.map((entry) => ({ ...(entry.at ? { at: entry.at } : {}), text: excerpt(entry.text, JOB_TEXT_LIMIT) ?? "" }))
      }
    } catch (error) {
      if (error instanceof BoxdError && (error.code === "CANCELLED" || error.code === "NOT_OURS")) throw error
      if (notRead(error)) {
        // The read rule refused it: the machine is no longer running in a fresh listing. Nothing was read, so the work
        // answers from what was known and the listing, like a work that is down; it is not a guest failure.
        read = false
      } else {
        observed = observeFailure(error, previous, phaseOf(record, listing, previous), services.clock.now())
        // One failed read is reported as it is: the job asked for this work now.
        if (observed.phase !== "unreachable") {
          const code: Code = error instanceof BoxdError ? error.code : "BOXD_FAILED"
          observed = { ...observed, phase: "unreachable", code }
        }
      }
    }
    if (read && observed) handle?.remember(record.workId, observed)
  }
  const state = read && observed ? observed.phase : phaseOf(record, listingFailed === undefined ? listing : undefined, observed)
  const outcome = outcomeOf(record, observed)
  const code = state === "unreachable" ? (observed?.code ?? codeOf(record, observed)) : outcome === "failed" || observed?.code === "SESSION_MISSING" ? codeOf(record, observed) : undefined
  const saved = services.ledger.saved(record)
  const warning = record.warnings?.at(-1)?.code
  const cost = input.cost ? (costs?.get(record.workId) ?? { machine: null, model: observed?.modelCost ?? null }) : undefined
  const lastText = observed?.lastText ? excerpt(observed.lastText, JOB_TEXT_LIMIT) : undefined
  const base = { state, saved, outcome, ...(code ? { error: code } : {}) }
  return {
    state,
    workId: record.workId,
    machine: record.machine,
    region: record.region,
    sessionId: record.session?.rootId ?? null,
    outcome,
    saved,
    ...(observed?.lastActivityAt ? { lastActivityAt: observed.lastActivityAt } : {}),
    ...(lastText ? { lastText } : {}),
    waiting: observed?.waiting ?? { steer: 0, queue: 0 },
    ...(code ? { error: code } : {}),
    ...(warning ? { warning } : {}),
    guestVersion: observed?.guestVersion ?? null,
    ...(cost ? { cost } : {}),
    ...(tail ? { tail } : {}),
    next:
      listingFailed === undefined
        ? nextOf(record, base)
        : `The machine listing failed (${listingFailed}), so nothing was read and this is the last known phase; ${one("boxd_job", record.workId)} again in a later turn`,
  }
}

/** A list call's envelope: `done` when every item answered, `partial` when some were refused, `failed` when all were. */
function envelope(results: ReadonlyArray<JobResult | Refusal>, cancelled: boolean): ListResult<JobResult> {
  const counts: Record<string, number> = {}
  for (const result of results) counts[result.state] = (counts[result.state] ?? 0) + 1
  const refused = results.filter((result) => "error" in result && "message" in result).length
  const state = cancelled ? "cancelled" : refused === 0 ? "done" : refused === results.length ? "failed" : "partial"
  return { state, counts, results }
}

export async function jobRun(services: FleetServices, raw: Record<string, unknown>, call: { readonly tag: CallTag; readonly signal?: AbortSignal }): Promise<JobResult | ListResult<JobResult>> {
  const input = jobInput(raw)
  const op: OpContext = { call: call.tag, ...(call.signal ? { signal: call.signal } : {}), pool: "foreground" }
  await services.ledger.ready(op)
  // A single form refuses through the registry; a list form answers each item.
  const records = await Promise.all(
    input.workIds.map(async (workId): Promise<WorkRecord | Refusal> => {
      try {
        const record = await services.ledger.get(workId, op)
        if (record) return record
        throw boxdError("NOT_OURS", `No work has the id "${workId}" in this laptop's ledger. Nothing was read.`)
      } catch (error) {
        if (!input.list || !(error instanceof BoxdError)) throw error
        return refusal(error, { workId })
      }
    }),
  )
  const wanted = records.filter((record): record is WorkRecord => "format" in record)
  // One listing at most 2 s old: a guest read needs one, so a hibernated machine is never woken.
  let listing: Listing | undefined
  let listingFailed: string | undefined
  if (wanted.some((record) => record.state === "open")) {
    try {
      listing = await services.boxd.list({ maxAgeMs: TIMEOUTS.readListingMaxAgeMs }, op)
    } catch (error) {
      // The listing failed, not the works: each answers its last known phase, with nothing read and no failure counted.
      // A stop, or a signed-out or missing CLI (`BOXD_MISSING`), fails the call at once: only a transient failure
      // (`BOXD_FAILED`, `TIMEOUT`) is answered from the last known phases.
      const transient = error instanceof BoxdError && (error.code === "BOXD_FAILED" || error.code === "TIMEOUT")
      if (!transient) {
        if (!input.list || !(error instanceof BoxdError)) throw error
        return envelope(records.map((record) => ("format" in record ? refusal(error, { workId: record.workId }) : record)), error.code === "CANCELLED")
      }
      listingFailed = reasonOf(error)
    }
  }
  const empty: Listing = { takenAt: Date.now(), fresh: false, machines: [] }
  let costs: Map<string, WorkCost> | undefined
  if (input.cost) {
    try {
      const block = await services.cost.block({ works: true, limit: LIST_MAX_ITEMS }, call.tag)
      costs = new Map((block.works ?? []).map((work) => [work.workId, { machine: work.machine, model: work.model }]))
    } catch {
      costs = undefined
    }
  }
  const results = await eachLimited(records, LIST_ITEM_CONCURRENCY, async (record): Promise<JobResult | Refusal> => {
    if (!("format" in record)) return record
    if (call.signal?.aborted) return refusal(boxdError("CANCELLED", "The call was stopped before this work was read."), { workId: record.workId })
    try {
      return await jobOf(services, record, listing ?? empty, input, costs, op, listingFailed)
    } catch (error) {
      if (!input.list || !(error instanceof BoxdError)) throw error
      return refusal(error, { workId: record.workId })
    }
  })
  if (!input.list) return results[0] as JobResult
  return envelope(results, call.signal?.aborted === true)
}
