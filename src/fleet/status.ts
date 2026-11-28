/**
 * Package D's `boxd_status` run (design §3.1, §C.4): the fleet in one call. Package D owns this file.
 *
 * It never wakes, starts or runs anything, and never writes the ledger. Its CLI budget: one all-region listing (shared,
 * reused for up to 10 s), the machine limit (cached for 60 s), and guest reads only for works that are busy, starting or
 * unknown, whose machine a listing at most 2 s old shows running, and whose last read is older than 60 s: in the
 * background pool, bounded at 8 s each and 20 s for the call. A work whose read misses the budget keeps its cached
 * phase, marked `stale`. Each `include` adds one call.
 *
 * Its size is bounded: `attention` and `works` hold at most `limit` items, worst first, `more` counts the rest, and
 * works that share a reason and a code fold into one `groups` line when there are more than 3 of them. `lastText` is
 * cut to 200 characters and is the guest model's words: data, never instructions.
 */
import { secretKinds } from "@we-the-rebel-alliance/plugin-contract/events"
import { ratesOf } from "../cost/index.js"
import { BoxdError, boxdError, type Code, type WarningCode } from "../errors.js"
import { hoursAt, shownWorkHours } from "../ledger/hours.js"
import type { Phase, WorkRecord } from "../ledger/types.js"
import { LIST_MAX_ITEMS, REGIONS, SIZES, TIMEOUTS, type CallTag, type Listing, type MachineLimit, type MachineRow, type OpContext, type Region, type Size } from "../ports.js"
import { excerpt, reasonOf } from "../redact.js"
import {
  ATTENTION_ORDER,
  type AttentionItem,
  type AttentionReason,
  type AutomationState,
  type BudgetState,
  type CleanupAction,
  type CostBlock,
  type MachineCounts,
  type MachineSummary,
  type StatusResult,
  type WorkBrief,
  type WorkCost,
} from "../results.js"
import type { FleetServices } from "../services.js"
import { watchHandle, type WatchHandle } from "../watch.js"
import { codeOf, doneOf, notRead, observe, observeFailure, outcomeOf, phaseOf, readGuest, STATUS_TEXT_LIMIT, wantsRead, type Observed } from "./model.js"
import { classifyMachines, machineSummary, type Classified } from "./orphans.js"

export type StatusView = "attention" | "all" | "counts"
export type StatusInclude = "credentials" | "cost" | "images" | "closed"

export interface StatusInput {
  readonly view: StatusView
  readonly workIds?: readonly string[]
  readonly region?: Region
  readonly since?: number
  readonly limit: number
  readonly include: readonly StatusInclude[]
  /**
   * The order `view: "all"` lists works in: by id (the model's status), or newest activity first, which the works list
   * snapshot asks for so its 50-item cap falls after the sort. Never read from a call's input.
   */
  readonly order?: "id" | "activity"
}

/** How a status call reads: `boxd_status` reads busy guests; `/boxd-status` makes no guest read at all. */
export interface StatusCall {
  readonly tag: CallTag
  readonly signal?: AbortSignal
  readonly guestReads: boolean
}

export const DEFAULT_LIMIT = 25
/** More than this many works sharing a reason and a code fold into one `groups` line. */
const FOLD_ABOVE = 3
/** A group names at most this many work ids. */
const GROUP_IDS = 10
/** Creating or starting for longer than this is `stuck`. */
const STUCK_MS = 10 * 60_000
/** A `leaseDays` timer ending within this long is `lease-expiring`. */
const LEASE_WARN_MS = 24 * 60 * 60_000
const WORK_ID = /^[a-z][a-z0-9-]{0,24}$/
const VIEWS: readonly StatusView[] = ["attention", "all", "counts"]
const INCLUDES: readonly StatusInclude[] = ["credentials", "cost", "images", "closed"]

const invalid = (field: string, message: string) => boxdError("NAME_INVALID", message, { field })

/** The list registry holds 50 items. */
const LIST_CAP = 50
/** Control characters would escape to six bytes each in JSON and only make a work's text unreadable. */
const CONTROLS = /\p{Cc}+/gu

/**
 * Current works as the contract's `list` items, newest first: by `lastActivityAt` (then by id, so the order is stable),
 * before the 50-item cap, so a busy recent work is never dropped for an idle one. A work id or its text is screened
 * whole and only then cut, so a secret that straddles the cut cannot pass as a prefix, and a repeated work is listed
 * once. Not editable.
 */
export function workList(works: readonly WorkBrief[], account?: string, asOf = new Date().toISOString()) {
  const items: { id: string; text: string; note?: string }[] = []
  const seen = new Set<string>()
  const newest = [...works].sort((left, right) => {
    const at = Date.parse(right.lastActivityAt ?? "") || 0
    const other = Date.parse(left.lastActivityAt ?? "") || 0
    return at === other ? left.workId.localeCompare(right.workId) : at - other
  })
  for (const work of newest) {
    if (items.length >= LIST_CAP) break
    const id = work.workId.replace(CONTROLS, "").slice(0, 128)
    const full = `${work.phase}${work.outcome === null ? "" : `, ${work.outcome}`}${work.done ? ", done" : ""}${work.machine === undefined ? "" : ` on ${work.machine}`}`.replace(CONTROLS, " ").replace(/\s+/g, " ").trim()
    if (id === "" || full === "" || seen.has(id) || secretKinds(id).length > 0 || secretKinds(full).length > 0) continue
    const note = work.saved.replace(CONTROLS, " ").slice(0, 200)
    seen.add(id)
    items.push({ id, text: full.slice(0, 200), ...(note === "" ? {} : { note }) })
  }
  return {
    ...(account === undefined ? {} : { account }),
    data: { items, editable: false as const },
    asOf,
    trust: "untrusted" as const,
  }
}

/** The input, checked: a bad field is refused before anything runs. */
export function statusInput(raw: Record<string, unknown>): StatusInput {
  const view = raw.view ?? "attention"
  if (typeof view !== "string" || !(VIEWS as readonly string[]).includes(view)) throw invalid("view", 'view must be "attention", "all" or "counts".')
  let workIds: string[] | undefined
  if (raw.workIds !== undefined) {
    if (!Array.isArray(raw.workIds) || raw.workIds.length > LIST_MAX_ITEMS || raw.workIds.some((id) => typeof id !== "string" || !WORK_ID.test(id))) {
      throw invalid("workIds", `workIds must be up to ${LIST_MAX_ITEMS} work ids, each a short lowercase id such as "review-api".`)
    }
    workIds = [...new Set(raw.workIds as string[])]
  }
  if (raw.region !== undefined && (typeof raw.region !== "string" || !(REGIONS as readonly string[]).includes(raw.region))) throw invalid("region", `region must be one of ${REGIONS.join(", ")}.`)
  if (raw.since !== undefined && (typeof raw.since !== "number" || !Number.isSafeInteger(raw.since) || raw.since < 0)) throw invalid("since", "since must be a cursor from an earlier answer: a whole number, 0 or more.")
  const limit = raw.limit ?? DEFAULT_LIMIT
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > LIST_MAX_ITEMS) throw invalid("limit", `limit must be a whole number from 1 to ${LIST_MAX_ITEMS}.`)
  const include = raw.include ?? []
  if (!Array.isArray(include) || include.some((part) => !(INCLUDES as readonly unknown[]).includes(part))) throw invalid("include", `include takes ${INCLUDES.map((part) => `"${part}"`).join(", ")}.`)
  return {
    view: view as StatusView,
    // Internal only: the tools RPC's works list asks for newest-activity order, so its cap falls after the sort. A
    // call's input never carries it (the tool's schema has no such key, and nothing reads it from a model call).
    ...(raw.order === "activity" ? { order: "activity" as const } : {}),
    ...(workIds ? { workIds } : {}),
    ...(raw.region !== undefined ? { region: raw.region as Region } : {}),
    ...(raw.since !== undefined ? { since: raw.since as number } : {}),
    limit,
    include: [...new Set(include as StatusInclude[])],
  }
}

/** One open or closed work as status sees it. */
interface Row {
  readonly record: WorkRecord
  readonly phase: Phase
  readonly observed: Observed | undefined
  readonly saved: WorkBrief["saved"]
  readonly stale: boolean
}

/** A concrete call, such as `boxd_harvest({ workId: "a" })`. */
const one = (tool: string, workId: string, extra = "") => `${tool}({ workId: ${JSON.stringify(workId)}${extra} })`
const quoted = (ids: readonly string[]) => ids.map((id) => JSON.stringify(id)).join(", ")

/** Why a work needs a decision, worst first, with its code and its one next call; undefined when it needs none. */
export function attentionOf(row: Row, facts: { readonly now: number; readonly hostVersion: string | null; readonly automation: AutomationState; readonly orphaned: (workId: string) => unknown }): { why: AttentionReason; error?: Code; next: string } | undefined {
  const { record, phase, observed, saved } = row
  if (record.state !== "open") return undefined
  const id = record.workId
  const outcome = outcomeOf(record, observed)
  const code = codeOf(record, observed)
  const done = doneOf(record, observed) !== undefined
  const prompted = record.lastSubmit !== undefined
  const unsaved = prompted && saved !== "fresh"
  const reasons: Array<{ why: AttentionReason; error?: Code; next: string }> = []
  if ((phase === "idle" && outcome === "failed") || code === "SESSION_MISSING") {
    const error = code ?? "RUN_FAILED"
    const next =
      error === "SESSION_MISSING"
        ? `${one("boxd_resume", id)} imports the saved transcript`
        : error === "GUEST_AUTH_FAILED"
          ? `${one("boxd_harvest", id)}, then set or rotate the model credential (a sealed, host-bound boxd env secret) and ${one("boxd_submit", id, ', text: "…"')} again`
          : `${one("boxd_job", id, ", tail: 5")} to read what happened, then ${one("boxd_submit", id, ', text: "…"')}`
    reasons.push({ why: "failed", error, next })
  }
  if (phase === "unreachable") {
    const error = code ?? "GUEST_FAILED"
    const next =
      error === "AGENT_UNREACHABLE"
        ? one("boxd_ensure", id, ', repair: "reboot"')
        : error === "GUEST_UNRESPONSIVE"
          ? one("boxd_exec", id, ', command: ["free", "-m"]')
          : error === "GUEST_SERVER_DOWN" || error === "GUEST_FAILED"
            ? one("boxd_ensure", id)
            : one("boxd_job", id)
    reasons.push({ why: "unreachable", error, next })
  }
  if (phase === "gone" && unsaved) reasons.push({ why: "gone-unsaved", error: "MACHINE_GONE", next: `${one("boxd_resume", id)} rebuilds it from the saved transcript, or ${one("boxd_drop", id)} closes the work` })
  if (phase === "idle" && unsaved) reasons.push(done ? { why: "done-unsaved", next: one("boxd_harvest", id) } : { why: "idle-unsaved", next: one("boxd_harvest", id) })
  if (phase === "asleep" && unsaved) {
    reasons.push({ why: done ? "done-unsaved" : "asleep-unsaved", next: `${one("boxd_resume", id)}, then ${one("boxd_harvest", id)}` })
  }
  if (phase === "creating" || phase === "starting") {
    const since = Date.parse(observed?.since ?? record.pendingCreate?.at ?? record.createdAt)
    if (!Number.isNaN(since) && facts.now - since > STUCK_MS) reasons.push({ why: "stuck", next: one("boxd_ensure", id) })
  }
  const running = phase === "idle" || phase === "ready" || phase === "busy"
  if (facts.orphaned(id) && (phase === "idle" || phase === "ready")) {
    reasons.push({ why: "orphan", next: `${one("boxd_harvest", id)}, then ${one("boxd_sleep", id)}: its coordinator session is gone` })
  }
  if (observed?.guestVersion && facts.hostVersion && observed.guestVersion !== facts.hostVersion && unsaved && phase !== "busy") {
    reasons.push({ why: "version", error: "GUEST_VERSION", next: `${one("boxd_ensure", id)} upgrades it in place, then ${one("boxd_harvest", id)}` })
  }
  if ((phase === "idle" || phase === "ready") && !observed?.needsInput && !facts.automation.startsWith("on")) {
    reasons.push({ why: "idle-running", next: one("boxd_sleep", id) })
  }
  if (observed?.needsInput && running) reasons.push({ why: "needs-input", next: `A person answers the ${observed.needsInput} with boxd connect ${record.machine}` })
  if (record.lease) {
    const left = Date.parse(record.lease.expiresAt) - facts.now
    if (!Number.isNaN(left) && left < LEASE_WARN_MS) reasons.push({ why: "lease-expiring", next: `${one("boxd_harvest", id)} now; boxd deletes the machine when its lease ends` })
  }
  if (!reasons.length) return undefined
  return reasons.sort((a, b) => ATTENTION_ORDER.indexOf(a.why) - ATTENTION_ORDER.indexOf(b.why))[0]
}

/** One line for many works that share a reason and a code: the selector when one fits, else the ids. */
function groupNext(why: AttentionReason, error: Code | undefined, ids: readonly string[]): string {
  const named = ids.length <= GROUP_IDS ? quoted(ids) : `${quoted(ids.slice(0, GROUP_IDS))}, and the other ${ids.length - GROUP_IDS} from boxd_status({ view: "all" })`
  switch (why) {
    case "failed":
      return error === "GUEST_AUTH_FAILED"
        ? `Set or rotate the shared model credential (a sealed, host-bound boxd env secret), then boxd_submit({ works: [{ workId, text }, …] }) for ${named}`
        : `boxd_job({ works: [${named}] }) to read what happened, then boxd_submit again`
    case "idle-unsaved":
      return 'boxd_harvest({ select: "unsaved-finished" })'
    case "done-unsaved":
      return 'boxd_harvest({ select: "unsaved-finished" })'
    case "idle-running":
      return 'boxd_sleep({ select: "idle" })'
    case "orphan":
    case "lease-expiring":
      return `boxd_harvest({ works: [${named}] })`
    case "asleep-unsaved":
    case "gone-unsaved":
      return `boxd_resume({ works: [${named}] }), then boxd_harvest({ works: [the same ids] })`
    case "stuck":
      return `boxd_ensure({ works: [${ids.length <= GROUP_IDS ? ids.map((id) => `{ workId: ${JSON.stringify(id)} }`).join(", ") : `{ workId } for ${named}`}] })`
    case "version":
      return `boxd_ensure for each of ${named}; it upgrades each guest in place`
    case "unreachable":
      return `boxd_job({ works: [${named}] })`
    default:
      return `boxd_status({ view: "all" }) lists ${named}`
  }
}

/** The cost service's part, or a block that says it is not available: status never fails for it. */
async function costParts(services: FleetServices, input: StatusInput, tag: CallTag, listing: Listing | undefined): Promise<{ cost: CostBlock; cleanup: readonly CleanupAction[]; automation: AutomationState; budget?: BudgetState }> {
  const safely = async <T>(fn: () => Promise<T> | T): Promise<{ value: T } | { error: string }> => {
    try {
      return { value: await fn() }
    } catch (error) {
      return { error: reasonOf(error) }
    }
  }
  const [block, cleanup, automation, budget] = await Promise.all([
    safely(() => services.cost.block({ works: input.include.includes("cost"), limit: input.limit }, tag)),
    safely(() => services.cost.cleanup(tag)),
    safely(() => services.cost.automation()),
    services.options.budget ? safely(() => services.cost.budget(tag, listing ? { listing } : undefined)) : Promise.resolve({ value: undefined }),
  ])
  return {
    cost: "value" in block ? block.value : unavailableCost(block.error),
    cleanup: "value" in cleanup ? cleanup.value : [],
    automation: "value" in automation ? automation.value : automationFallback(services),
    ...("value" in budget && budget.value ? { budget: budget.value } : {}),
  }
}

function unavailableCost(reason: string): CostBlock {
  return {
    currency: "unknown",
    perHour: { estimate: 0, running: 0, asleep: 0, basis: "not estimated: the cost service is not available", ratesSource: "public" },
    today: { machines: null, complete: false, unavailable: `The cost service is not available (${reason}).` },
    hours: {
      ledger: { seconds: { existed: 0, running: 0, asleep: 0 }, estimate: { amount: 0, currency: "unknown", ratesSource: "public" } },
      today: { seconds: { existed: 0, running: 0, asleep: 0 }, estimate: { amount: 0, currency: "unknown", ratesSource: "public" } },
      since: { seconds: { existed: 0, running: 0, asleep: 0 }, estimate: { amount: 0, currency: "unknown", ratesSource: "public" } },
    },
  }
}

/** What `access` and `automation` say, when the cost service cannot (design §C.3). */
function automationFallback(services: FleetServices): AutomationState {
  const { automation, access } = services.options
  if (automation === "on") return "on (consent)"
  if (automation === "off") return "off"
  return access === "all" ? "on" : "off (access)"
}

/** One set of machines by state; a destroyed machine is not counted at all, and no state is missing at zero. */
function countsOf(machines: readonly MachineRow[]): MachineCounts {
  const counts: Record<keyof MachineCounts, number> = { running: 0, starting: 0, standby: 0, hibernated: 0, stopped: 0, other: 0 }
  for (const machine of machines) {
    if (machine.status === "destroyed") continue
    counts[machine.status] += 1
  }
  return counts
}

/**
 * The organisation's machines against boxd's limit, by state, from the all-region listing and the limit the status
 * read already takes: every machine boxd counts (any state but `destroyed`, hibernated and stopped included), the
 * split by state, each region's own count and limit, and how many machines this ledger's open works name. A limit that
 * could not be read is null, and every count still shows. The figures are for the whole organisation, whatever
 * `region` the call uses to filter its works.
 */
export function machinesAgainstLimit(
  classified: readonly Classified[],
  limit: MachineLimit | undefined,
): Pick<MachineSummary, "limit" | "inUse" | "free" | "byState" | "works" | "perRegion"> {
  // The classification is the one truth for a work: a record names it, label or no label.
  const counted = classified.filter((item) => item.row.status !== "destroyed")
  const rows = (items: readonly Classified[]) => items.map((item) => item.row)
  const works = (items: readonly Classified[]) => items.filter((item) => item.machineClass === "work").length
  const perRegion = REGIONS.map((region) => {
    const items = counted.filter((item) => item.row.region === region)
    const regionLimit = limit?.regions.find((row) => row.region === region)?.limit ?? null
    const inUse = items.length
    return {
      region,
      limit: regionLimit,
      inUse,
      free: regionLimit === null ? null : Math.max(0, regionLimit - inUse),
      byState: countsOf(rows(items)),
      works: works(items),
    }
  })
  const inUse = counted.length
  const orgLimit = limit?.org ?? null
  return {
    limit: orgLimit,
    inUse,
    free: orgLimit === null ? null : Math.max(0, orgLimit - inUse),
    byState: countsOf(rows(counted)),
    works: works(counted),
    perRegion,
  }
}

/** Image names this plugin builds: `<prefix>-<opencode version>-<size>`. */
function imageOf(name: string, prefix: string): { opencode: string; size: Size } | undefined {
  if (!name.startsWith(`${prefix}-`)) return undefined
  const rest = name.slice(prefix.length + 1)
  const size = SIZES.find((value) => rest.endsWith(`-${value}`))
  if (!size) return undefined
  const opencode = rest.slice(0, -size.length - 1)
  return /^\d+\.\d+\.\d+[\w.-]*$/.test(opencode) ? { opencode, size } : undefined
}

/** Settles within `ms` or answers undefined; the work is stopped through `controller`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)))
  try {
    return await Promise.race([promise, late])
  } finally {
    clearTimeout(timer)
  }
}

/** The `boxd_status` answer (and, with `guestReads: false`, the fleet part of `/boxd-status`). */
export async function fleetStatus(services: FleetServices, input: StatusInput, call: StatusCall): Promise<StatusResult> {
  const now = () => services.clock.now()
  const op = (pool: OpContext["pool"] = "foreground"): OpContext => ({ call: call.tag, ...(call.signal ? { signal: call.signal } : {}), pool })
  const handle: WatchHandle | undefined = watchHandle(services.watch)

  // The ledger first: its records decide which works exist before any boxd call.
  const filter = { ...(input.workIds ? { workIds: input.workIds } : {}), ...(input.region ? { region: input.region } : {}) }
  const open = await services.ledger.list(filter, op())
  const closed = input.include.includes("closed") ? (await services.ledger.list({ ...filter, closed: true }, op())).filter((record) => record.state === "closed") : []
  handle?.kick()

  let listing: Listing | undefined
  let listingError: string | undefined
  try {
    listing = await services.boxd.list({ maxAgeMs: TIMEOUTS.phaseListingMaxAgeMs }, op())
  } catch (error) {
    if (error instanceof BoxdError && error.code === "CANCELLED") throw error
    listingError = reasonOf(error)
  }

  // Guest reads: busy, starting or unknown works only, never an idle one, under the read rule and the call's budget.
  const stale = new Set<string>()
  let relistError: string | undefined
  if (call.guestReads && listing) {
    const at = now().getTime()
    const wanted = open.filter((record) => wantsRead(record, listing!, handle?.observed(record.workId), at, TIMEOUTS.cachedReadMaxAgeMs))
    if (wanted.length && Date.now() - listing.takenAt > TIMEOUTS.readListingMaxAgeMs) {
      // The guest reads need a listing at most 2 s old. When it fails, nothing is read: every work keeps its cached
      // phase, the ones that wanted a read are stale, and the call still answers.
      try {
        listing = await services.boxd.list({ maxAgeMs: TIMEOUTS.readListingMaxAgeMs }, op())
      } catch (error) {
        if (error instanceof BoxdError && error.code === "CANCELLED") throw error
        relistError = reasonOf(error)
        for (const record of wanted) stale.add(record.workId)
      }
    }
    if (wanted.length && relistError === undefined) {
      const budget = new AbortController()
      const signal = call.signal ? AbortSignal.any([call.signal, budget.signal]) : budget.signal
      const readOp: OpContext = { call: call.tag, signal, pool: "background" }
      const fresh = listing
      // A read answers its work's id when it learned something: an answer, or a real guest failure. A read the read
      // rule refused (the machine is not running in a fresh listing) or the budget stopped learned nothing: the work
      // keeps its cached phase, marked stale (design §3.1 step 3), and is never counted as a failure.
      const reads = wanted.map(async (record): Promise<string | undefined> => {
        const previous = handle?.observed(record.workId)
        try {
          const answer = await readGuest(services, record, fresh, {}, readOp)
          handle?.remember(record.workId, observe(answer, previous, now(), STATUS_TEXT_LIMIT))
        } catch (error) {
          if (budget.signal.aborted || call.signal?.aborted || notRead(error)) return undefined
          handle?.remember(record.workId, observeFailure(error, previous, phaseOf(record, fresh, previous), now()))
        }
        return record.workId
      })
      const settled = await within(Promise.all(reads), TIMEOUTS.statusBudget)
      if (!settled) budget.abort()
      const done = new Set((settled ?? (await Promise.all(reads.map((read) => within(read, 0))))).filter((id): id is string => typeof id === "string"))
      for (const record of wanted) if (!done.has(record.workId)) stale.add(record.workId)
      if (call.signal?.aborted) throw boxdError("CANCELLED", "The status call was stopped; nothing was changed.")
    }
  }

  const rows: Row[] = [...open, ...closed].map((record) => {
    const observed = handle?.observed(record.workId)
    return { record, phase: phaseOf(record, listing, observed), observed, saved: services.ledger.saved(record), stale: stale.has(record.workId) || (!listing && record.state === "open") }
  })

  // The cursor, and the works that changed since the caller's.
  let cursor: number
  let cursorExpired = false
  let changed: Set<string> | undefined
  if (input.since !== undefined) {
    const page = await services.ledger.eventsSince(input.since, op())
    cursor = page.cursor
    cursorExpired = page.cursorExpired
    if (!cursorExpired) changed = new Set(page.events.map((event) => event.workId))
  } else {
    cursor = handle ? await handle.cursor(op()) : (await services.ledger.eventsSince(0, op())).cursor
  }

  const tag = call.tag
  const [limits, costs, secrets, snapshots] = await Promise.all([
    services.boxd.machineLimit(op()).catch(() => undefined),
    costParts(services, input, tag, listing),
    input.include.includes("credentials") ? services.boxd.secrets(op()).then((value) => ({ value }), (error: unknown) => ({ error: reasonOf(error) })) : undefined,
    input.include.includes("images") ? services.boxd.snapshots(op()).catch(() => undefined) : undefined,
  ])

  const at = now().getTime()
  const rates = ratesOf(services.cost)
  const costOf = new Map<string, WorkCost>((costs.cost.works ?? []).map((work) => [work.workId, { machine: work.machine, model: work.model }]))
  const withCost = input.include.includes("cost")
  const workCost = (row: Row): WorkCost | undefined => {
    if (!withCost) return undefined
    return costOf.get(row.record.workId) ?? { machine: null, model: row.observed?.modelCost ?? null }
  }

  // Counts over every work the filter names.
  const counts: Partial<Record<Phase, number>> = {}
  for (const row of rows) counts[row.phase] = (counts[row.phase] ?? 0) + 1

  // Attention: worst first, folded by reason and code, at most `limit`.
  const facts = { now: at, hostVersion: services.hostVersion, automation: costs.automation, orphaned: (workId: string) => handle?.orphaned(workId) }
  const visible = (row: Row) => !changed || changed.has(row.record.workId)
  const needs = rows
    .filter(visible)
    .map((row) => ({ row, attention: attentionOf(row, facts) }))
    .filter((entry): entry is { row: Row; attention: NonNullable<ReturnType<typeof attentionOf>> } => entry.attention !== undefined)
    .sort((a, b) => ATTENTION_ORDER.indexOf(a.attention.why) - ATTENTION_ORDER.indexOf(b.attention.why) || a.row.record.workId.localeCompare(b.row.record.workId))
  const byKey = new Map<string, typeof needs>()
  for (const entry of needs) {
    const key = `${entry.attention.why}|${entry.attention.error ?? ""}`
    byKey.set(key, [...(byKey.get(key) ?? []), entry])
  }
  const groups: StatusResult["groups"][number][] = []
  const single: typeof needs = []
  for (const entries of byKey.values()) {
    if (entries.length > FOLD_ABOVE) {
      const first = entries[0]!.attention
      const ids = entries.map((entry) => entry.row.record.workId)
      groups.push({ why: first.why, ...(first.error ? { error: first.error } : {}), count: ids.length, workIds: ids.slice(0, GROUP_IDS), next: groupNext(first.why, first.error, ids) })
    } else {
      single.push(...entries)
    }
  }
  single.sort((a, b) => ATTENTION_ORDER.indexOf(a.attention.why) - ATTENTION_ORDER.indexOf(b.attention.why) || a.row.record.workId.localeCompare(b.row.record.workId))

  const brief = (row: Row): WorkBrief => {
    const cost = workCost(row)
    const hours = withCost ? shownWorkHours(hoursAt(row.record, new Date(at), rates)) : undefined
    const lastActivityAt = row.observed?.lastActivityAt
    const done = row.phase === "idle" || row.phase === "asleep" ? doneOf(row.record, row.observed) : undefined
    return {
      workId: row.record.workId,
      ...(row.record.slot === true ? { machine: row.record.machine } : {}),
      region: row.record.region,
      phase: row.phase,
      outcome: outcomeOf(row.record, row.observed),
      saved: row.saved,
      ...(done ? { done } : {}),
      ...(lastActivityAt ? { lastActivityAt } : {}),
      ...(cost ? { cost } : {}),
      ...(hours ? { hours } : {}),
      ...(row.stale ? { stale: true as const } : {}),
    }
  }
  const item = ({ row, attention }: (typeof needs)[number]): AttentionItem => {
    const lastText = row.observed?.lastText ? excerpt(row.observed.lastText, STATUS_TEXT_LIMIT) : undefined
    return {
      ...brief(row),
      why: attention.why,
      ...(attention.error ? { error: attention.error } : {}),
      ...(lastText && (attention.why === "failed" || attention.why === "idle-unsaved") ? { lastText } : {}),
      next: attention.next,
    }
  }

  let attention: AttentionItem[] | undefined
  let works: WorkBrief[] | undefined
  let more = 0
  if (input.view === "attention") {
    attention = single.slice(0, input.limit).map(item)
    more = single.length - attention.length
  } else if (input.view === "all") {
    const byActivity = (a: { readonly lastActivityAt?: string }, b: { readonly lastActivityAt?: string }) => {
      const at = Date.parse(b.lastActivityAt ?? "") || 0
      const other = Date.parse(a.lastActivityAt ?? "") || 0
      return at === other ? 0 : at - other
    }
    const listed = rows
      .filter(visible)
      .sort((a, b) => (input.order === "activity" ? byActivity(brief(a), brief(b)) || a.record.workId.localeCompare(b.record.workId) : a.record.workId.localeCompare(b.record.workId)))
    works = listed.slice(0, input.limit).map(brief)
    more = listed.length - works.length
  }

  // Every machine, classified by what owns it: a record here, another ledger's label, a `keep` selector, a golden
  // builder, or an orphan. Only a session machine is ever actionable (design §C.3, #83).
  // The listing the call already took is the count: no usage read and no owner's sign-in. The figures are across
  // every region, even when the call filters its works to one.
  const ledgerId = await services.ledger.currentId(op())
  // One classification serves the classes, the orphans and this ledger's share. The limit figures are org-wide, so the
  // call's region filter applies to the summary only.
  const classified = classifyMachines(listing?.machines ?? [], open, ledgerId, services.options.keep)
  const shownMachines = input.region === undefined ? classified : classified.filter((item) => item.row.region === input.region)
  const machines: MachineSummary = {
    ...machineSummary(shownMachines, input.limit),
    ...machinesAgainstLimit(classified, limits),
  }

  // One shared cause across many works: #1's case, 15 works stopped on one expired token.
  const authFailed = rows.filter((row) => row.record.state === "open" && codeOf(row.record, row.observed) === "GUEST_AUTH_FAILED")
  const fleet: StatusResult["fleet"] =
    authFailed.length >= 2
      ? (() => {
          const since = authFailed.map((row) => row.observed?.since ?? row.record.run?.at ?? "").filter(Boolean).sort()[0] ?? now().toISOString()
          return { authFailures: { count: authFailed.length, since, note: `${authFailed.length} works stopped on a refused credential since ${since}; a shared token may have expired.` } }
        })()
      : {}

  const warnings = new Set<WarningCode>()
  if (costs.budget?.state === "reached" && costs.budget.action === "warn") warnings.add("BUDGET_WARN")
  if (costs.budget?.state === "unknown") warnings.add("BUDGET_UNKNOWN")
  for (const row of rows) {
    if (row.record.state !== "open") continue
    for (const warning of row.record.warnings ?? []) warnings.add(warning.code)
    if (row.record.lease && Date.parse(row.record.lease.expiresAt) - at < LEASE_WARN_MS) warnings.add("LEASE_EXPIRING")
  }

  const inUseImages = new Set(open.map((record) => `${record.region}/${record.image.name}`))
  const images = snapshots
    ?.map((snapshot) => ({ snapshot, parsed: imageOf(snapshot.name, services.options.goldenPrefix) }))
    .filter((entry) => entry.parsed !== undefined)
    .map(({ snapshot, parsed }) => ({ region: snapshot.region, name: snapshot.name, opencode: parsed!.opencode, size: parsed!.size, inUse: inUseImages.has(`${snapshot.region}/${snapshot.name}`) }))

  const health = services.runner.health()
  const watchHealth = handle?.health()

  return {
    state: "ok",
    cursor,
    asOf: listing ? new Date(listing.takenAt).toISOString() : now().toISOString(),
    counts,
    region: services.options.region,
    allowedRegions: services.options.regions,
    regions: (limits?.regions ?? [])
      .filter((limit) => !input.region || limit.region === input.region)
      .map((limit) => ({ ...limit, keepFree: services.options.keepFree[limit.region] ?? 0, works: open.filter((record) => record.region === limit.region).length })),
    groups,
    ...(attention ? { attention } : {}),
    ...(works ? { works } : {}),
    more,
    cursorExpired,
    machines,
    fleet,
    ...(secrets
      ? {
          credentials: {
            secrets: "value" in secrets ? secrets.value : [],
            setAt: null,
            missing: `boxd does not report when a secret was set (upstream ask U4)${"error" in secrets ? `; the list could not be read (${secrets.error})` : ""}.`,
          },
        }
      : {}),
    cost: costs.cost,
    cleanup: costs.cleanup,
    automation: costs.automation,
    ...(costs.budget ? { budget: costs.budget } : {}),
    ...(images ? { images } : {}),
    ...(warnings.size ? { warnings: [...warnings].sort() } : {}),
    cli: { signedIn: listingError === undefined, version: null },
    health: {
      loopLagMaxMs: health.loopLagMaxMs,
      children: { now: health.children.now, cap: health.children.cap },
      ...(watchHealth?.notices.length ? { notices: watchHealth.notices } : {}),
      ...(listingError || relistError
        ? { watcher: `The machine listing failed (${listingError ?? relistError}), so no guest was read: each work shows its last known phase, and the ones a read would have refreshed are marked stale. Next: boxd_status again in a later turn.` }
        : watchHealth?.watcher
          ? { watcher: watchHealth.watcher }
          : {}),
    },
  }
}
