/**
 * Package C2's runs: `boxd_submit`, `boxd_harvest`, `boxd_sleep`, `boxd_drop`, `boxd_exec` and `boxd_read` (design
 * §3.3, §3.5–§3.7, §3.9, §3.12), the selectors of §C.4, and the in-process `FleetActions` package E uses. Package C2
 * owns this file and `src/fleet/{submit,harvest,sleep,drop,exec,read,sessions-common}.ts`.
 *
 * Every run takes the call's signal (F2): a stopped call kills its children, an item that never started answers
 * `CANCELLED` with `started: false`, and one stopped mid-change answers `CANCELLED` with `uncertain: true`.
 */
import type { Phase, SavedState, WorkRecord } from "../ledger/types.js"
import type { MachineRow, OpContext, RunOutcome } from "../ports.js"
import type { DropResult, HarvestResult, ListResult, SelectMatch, SleepResult } from "../results.js"
import type { ActionContext, FleetActions, FleetServices, Run, SelectorValues, Selectors, ToolRuns } from "../services.js"
import type { CallContext } from "../tools.js"
import { checkDrop, dropWork } from "./drop.js"
import { checkExec, execWork } from "./exec.js"
import { checkHarvest, harvestWork } from "./harvest.js"
import { checkRead, readWork } from "./read.js"
import { assertWorkIdInput, listItems, opOf, runList, stopped, type ItemContext, type Services } from "./sessions-common.js"
import { sleepWork, type SleepItem } from "./sleep.js"
import { checkSubmit, submitWork } from "./submit.js"

type SessionRuns = Pick<ToolRuns, "boxd_submit" | "boxd_harvest" | "boxd_sleep" | "boxd_drop" | "boxd_exec" | "boxd_read">
type SelectTool = keyof SelectorValues

export function sessionRuns(services: FleetServices): { readonly runs: SessionRuns; readonly selectors: Selectors; readonly actions: FleetActions } {
  /** A single-form call: its run, with a stop read as `CANCELLED` (`uncertain` when it changes something). */
  const single = async <T>(call: CallContext, changing: boolean, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (error) {
      throw stopped(error, call.signal, changing)
    }
  }
  const toolContext = (tool: `boxd_${string}`, call: CallContext): ItemContext => ({ op: opOf(tool, call), by: "tool", call })

  /**
   * The list tools: `works`, a single `workId`, or a `select` the registry resolved (and asserted) into `call.matched`;
   * with `dryRun`, the match alone.
   */
  function listTool<I extends { readonly workId: string }, T extends { readonly state: string }>(
    tool: SelectTool | "boxd_submit",
    shorthand: boolean,
    check: (input: Record<string, unknown>) => I,
    act: (item: I, context: ItemContext) => Promise<T>,
  ): Run<T> {
    return async (input, call) => {
      const context = toolContext(tool, call)
      if (input.select !== undefined && tool !== "boxd_submit") {
        // The registry resolved the select and asserted exactly these ids; a run never resolves a second match.
        const ids = call.matched
        if (!ids) throw new Error(`${tool} ran a select without the ids the registry matched and asserted.`)
        if (input.dryRun === true) return matches(ids, input.select as ListResult<T>["select"], seen.take(call.id) ?? (await factsOf(services, context.op)))
        const items = ids.map((workId) => check({ workId }))
        return { ...(await runList(items, call.signal, (item) => act(item, context))), select: input.select as ListResult<T>["select"] }
      }
      if (input.works !== undefined) {
        const items = listItems(input.works, shorthand, check)
        return runList(items, call.signal, (item) => act(item, context))
      }
      const item = check(input)
      return single(call, true, () => act(item, context))
    }
  }

  const sleepCheck = (input: Record<string, unknown>): SleepItem => ({ workId: assertWorkIdInput(input.workId) })

  const runs: SessionRuns = {
    boxd_submit: listTool("boxd_submit", false, checkSubmit, (item, context) => submitWork(services, item, context)),
    boxd_harvest: listTool("boxd_harvest", true, checkHarvest, (item, context) => harvestWork(services, item, context)),
    boxd_sleep: listTool("boxd_sleep", true, sleepCheck, (item, context) => sleepWork(services, item, context)),
    boxd_drop: listTool("boxd_drop", true, checkDrop, (item, context) => dropWork(services, item, context)),
    boxd_exec: async (input, call) => {
      const item = checkExec(input)
      return single(call, true, () => execWork(services, item, toolContext("boxd_exec", call)))
    },
    boxd_read: async (input, call) => {
      const item = checkRead(input)
      return single(call, false, () => readWork(services, item, opOf("boxd_read", call)))
    },
  }

  /** The facts a select call matched on, kept for its `dryRun` answer, so both come from one listing (L-4). */
  const seen = recentFacts()
  const selectTool =
    <K extends SelectTool>(tool: K) =>
    async (select: SelectorValues[K], call: CallContext) => {
      const facts = await factsOf(services, opOf(tool, call))
      seen.keep(call.id, facts)
      return match(tool, select, facts)
    }
  const selectors: Selectors = { boxd_sleep: selectTool("boxd_sleep"), boxd_harvest: selectTool("boxd_harvest"), boxd_drop: selectTool("boxd_drop") }

  /** Package E's in-process actions: pre-authorised by its caller, through the same code as the tools. */
  const actionContext = (context: ActionContext): ItemContext => ({ op: { call: context.call, ...(context.signal ? { signal: context.signal } : {}) }, by: context.by })
  const actions: FleetActions = {
    match: async (tool, select, context) => match(tool, select, await factsOf(services, actionContext(context).op)),
    harvest: (workIds, context): Promise<ListResult<HarvestResult>> =>
      runList(workIds.map((workId) => checkHarvest({ workId })), context.signal, (item) => harvestWork(services, item, actionContext(context))),
    sleep: (workIds, context): Promise<ListResult<SleepResult>> =>
      runList(workIds.map((workId) => sleepCheck({ workId })), context.signal, (item) => sleepWork(services, item, actionContext(context))),
    drop: (workIds, context): Promise<ListResult<DropResult>> =>
      runList(workIds.map((workId) => checkDrop({ workId })), context.signal, (item) => dropWork(services, item, actionContext(context))),
  }

  return { runs, selectors, actions }
}

// ── Selectors (design §C.4) ───────────────────────────────────────────────────────────────────────────────────────

/** What a selector reads about one open work: its phase, last outcome, saved state, and whether a person must answer. */
interface Facts {
  readonly record: WorkRecord
  readonly row: MachineRow | undefined
  readonly phase: Phase
  readonly outcome: RunOutcome | null
  readonly saved: SavedState
  readonly needsInput: boolean
}

/**
 * Every open work's facts, from a fresh all-region listing, the ledger and the watcher's last look (no guest read). A
 * work the watcher has not seen is idle when the record holds a run newer than its last prompt (a harvest read it from
 * the guest); otherwise the index's phase (its last event) decides, and with no event the record does.
 */
async function factsOf(services: Services, op: OpContext): Promise<Facts[]> {
  const [records, listing, indexed] = await Promise.all([services.ledger.list({}, op), services.boxd.list({ maxAgeMs: 0 }, op), services.ledger.phases({}, op)])
  const seen = new Map(services.watch.snapshot().works.map((work) => [work.workId, work]))
  const live: readonly Phase[] = ["busy", "idle", "ready", "unreachable"]
  return records.map((record) => {
    const row = listing.machines.find((machine) => machine.name === record.machine && machine.region === record.region)
    const watched = seen.get(record.workId)
    const phase: Phase = !row
      ? "gone"
      : row.status === "hibernated" || row.status === "standby" || row.status === "stopped"
        ? "asleep"
        : row.status !== "running"
          ? "starting"
          : watched && live.includes(watched.phase)
            ? watched.phase
            : ledgerPhase(record) === "idle"
              ? "idle"
              : (live.find((phase) => phase === indexed.get(record.workId)?.phase) ?? ledgerPhase(record))
    return {
      record,
      row,
      phase,
      outcome: watched?.outcome ?? record.run?.outcome ?? null,
      saved: services.ledger.saved(record),
      needsInput: Boolean(watched?.needsInput),
    }
  })
}

function ledgerPhase(record: WorkRecord): Phase {
  if (!record.session?.rootId) return "ready"
  if (record.run && (!record.lastSubmit || record.run.at >= record.lastSubmit.at)) return "idle"
  return "busy"
}

/** Each selector's row of the table in design §C.4. */
const MATCHERS: { readonly [K in SelectTool]: (select: SelectorValues[K], facts: Facts) => boolean } = {
  boxd_sleep: (select, facts) =>
    select === "idle" ? facts.row?.status === "running" && (facts.phase === "idle" || facts.phase === "ready") && !facts.needsInput : facts.row?.status === "running" && facts.phase === "idle" && facts.outcome !== null,
  boxd_harvest: (_select, facts) => (facts.phase === "idle" || facts.phase === "asleep") && facts.outcome !== null && facts.saved !== "fresh",
  boxd_drop: (_select, facts) => (facts.phase === "idle" || facts.phase === "asleep") && facts.saved === "fresh" && facts.outcome === "completed",
}

/** The ids a selector matches in these facts, in work-id order. */
function match<K extends SelectTool>(tool: K, select: SelectorValues[K], facts: readonly Facts[]): readonly string[] {
  const matcher = MATCHERS[tool] as (select: SelectorValues[K], facts: Facts) => boolean
  return facts.filter((item) => matcher(select, item)).map((item) => item.record.workId)
}

/** The last few select calls' facts, by call id, each taken once; a call that never asks for them ages out. */
function recentFacts() {
  const kept = new Map<string, readonly Facts[]>()
  return {
    keep(callId: string, facts: readonly Facts[]) {
      kept.set(callId, facts)
      while (kept.size > 16) kept.delete(kept.keys().next().value as string)
    },
    take(callId: string): readonly Facts[] | undefined {
      const facts = kept.get(callId)
      kept.delete(callId)
      return facts
    },
  }
}

/** `dryRun`: the matched works and what was read about each, from the facts the match used, with nothing changed. */
function matches<T extends { readonly state: string }>(ids: readonly string[], select: ListResult<T>["select"], from: readonly Facts[]): ListResult<T> {
  const facts = new Map(from.map((item) => [item.record.workId, item]))
  const results: SelectMatch[] = ids.flatMap((workId) => {
    const item = facts.get(workId)
    if (!item) return []
    return [{ state: "matched" as const, workId, machine: item.record.machine, region: item.record.region, phase: item.phase, saved: item.saved, outcome: item.outcome }]
  })
  return { state: "done", counts: results.length ? { matched: results.length } : {}, results, ...(select ? { select } : {}), dryRun: true }
}

