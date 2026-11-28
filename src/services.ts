/**
 * What every run and loop depends on, declared once. `src/index.ts` builds these services once, in a fixed order, from
 * the provider and the ledger; a handler receives the runs and never builds a service.
 *
 * | Layer | Module | Provides |
 * |---|---|---|
 * | Provider | `src/provider/` | `createProvider`: the runner, the boxd CLI and guest helper, the local `opencode` binary |
 * | Ledger | `src/ledger/` | `createLedger`: records, events and staged files |
 * | Watch | `src/watch.ts`, `src/fleet/view.ts` | `createWatch`; the status, job and events reads |
 * | Cost | `src/cost/` | `createCost`: rates, today's usage and the cleanup suggestions |
 * | Machines | `src/fleet/machines.ts` | ensure, resume, reassign and golden |
 * | Sessions | `src/fleet/sessions.ts` | submit, harvest, sleep, drop, exec and read, the selectors and the in-process actions |
 * | Handlers | `src/handlers/` | the register handler table |
 *
 * Order: provider → ledger → watch → cost → machines, sessions → handlers. Each later stage sees only what the stages
 * before it built.
 */
import type { Plugin } from "@opencode/plugin"
import type { Phase, SavedState } from "./ledger/types.js"
import type { Options } from "./options.js"
import type { BoxdPort, CallTag, FleetWatch, GuestPort, LaptopPort, LedgerPort, Runner } from "./ports.js"
import type { AutomationState, BudgetState, CleanupAction, CostBlock, HarvestResult, ListResult, Refusal, SleepResult, ToolResults } from "./results.js"
import type { CallContext } from "./call.js"

export interface Clock {
  now(): Date
}

/** The host's session API the plugin uses: the root walk for notices, and synthetic notices. */
export type SessionAccess = Pick<Plugin.Context["session"], "get" | "synthetic" | "context">

/** The provider's entry: the runner and the three ports. */
export interface Provider {
  readonly runner: Runner
  readonly boxd: BoxdPort
  readonly guest: GuestPort
  readonly laptop: LaptopPort
  /** On disposal or reload: every in-flight child aborted, queued ones dropped, and the ports' caches closed. */
  dispose(): Promise<void>
}

/** Built from the host and the options alone. */
export interface HostServices {
  readonly options: Options
  /** This machine's OpenCode: a golden image, and a guest that moves a transcript, must match it. */
  readonly hostVersion: string | null
  readonly projectDirectory: string
  /** The ledger's root, `~/.local/share/boxd-plugin` unless a test says otherwise. */
  readonly ledgerRoot: string
  readonly clock: Clock
  readonly sessions: SessionAccess
  /** Records a problem for status under its area (one per area; undefined clears it). Never throws. */
  readonly report: (area: string, problem: string | undefined) => void
}

/** The host, the provider and the ledger: what the watcher and cost need. */
export interface CoreServices extends HostServices, Provider {
  readonly ledger: LedgerPort
}

/** What the fleet reads and writes get: the core, the watcher and cost. */
export interface FleetServices extends CoreServices {
  readonly watch: FleetWatch
  readonly cost: CostPort
}

/** What the automation loop gets: the fleet services and the sessions' in-process actions. */
export interface CostServices extends FleetServices {
  readonly actions: FleetActions
}

/** Something a stage started that the plugin stops when it is disposed. */
export type Dispose = () => Promise<void>

/** How long the plugin's cleanup waits for one stage to stop before it moves on to the next. */
export const DISPOSE_BOUND_MS = 5_000

/**
 * Runs each stop in order, each bounded by `boundMs`. A stop that throws or does not finish in time is reported and
 * left behind, and the stops after it still run, so one stuck stage never keeps the runner or a lock alive.
 */
export async function stopAll(stops: readonly Dispose[], report: (problem: string) => void, boundMs = DISPOSE_BOUND_MS): Promise<void> {
  for (const [index, stop] of stops.entries()) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), boundMs)))
    try {
      const outcome = await Promise.race([stop().then(() => "done" as const), late])
      if (outcome === "late") report(`Stop ${index + 1} of ${stops.length} did not finish within ${boundMs} ms; the plugin moved on.`)
    } catch (error) {
      report(`Stop ${index + 1} of ${stops.length} failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }
}

// ── Runs ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ToolId = keyof ToolResults

/** One method's run: its success result, a refusal, or a list envelope. */
export type Run<T extends { readonly state: string }> = (input: Record<string, unknown>, call: CallContext) => Promise<T | Refusal | ListResult<T>>

export type ToolRuns = { readonly [K in ToolId]: Run<ToolResults[K]> }

/** The selectors of §C.4, per method. */
export interface SelectorValues {
  readonly boxd_sleep: "idle" | "finished"
  readonly boxd_harvest: "unsaved-finished"
  readonly boxd_drop: "saved-finished"
}
export type Selector = SelectorValues[keyof SelectorValues]

/**
 * Resolves a `select` to work ids at call time, against a fresh listing and the ledger. A read: it changes nothing.
 * The method acts on exactly the matched ids its handler received.
 */
export type Selectors = { readonly [K in keyof SelectorValues]: (select: SelectorValues[K], call: CallContext) => Promise<readonly string[]> }

// ── The sessions' actions for the automation ────────────────────────────────────────────────────────────────────

/** Who runs an action outside a method call: the automation loop. */
export interface ActionContext {
  readonly by: "automation"
  readonly call: CallTag
  readonly signal?: AbortSignal
}

/**
 * The sessions' harvest and sleep, in-process, through the same code as the methods, for the automation. The caller
 * has its consent already (the `automation` option or `access`), so nothing here asserts. The automation never drops.
 */
export interface FleetActions {
  match<K extends keyof SelectorValues>(tool: K, select: SelectorValues[K], context: ActionContext): Promise<readonly string[]>
  harvest(workIds: readonly string[], context: ActionContext): Promise<ListResult<HarvestResult>>
  sleep(workIds: readonly string[], context: ActionContext): Promise<ListResult<SleepResult>>
}

// ── The cost service ────────────────────────────────────────────────────────────────────────────────────────────

export interface CostPort {
  /** The `cost` block of the status report; per-work figures only when asked. */
  block(options: { readonly works: boolean; readonly limit: number }, context: CallTag): Promise<CostBlock>
  /** The `cleanup` block: suggested actions, biggest saving first. */
  cleanup(context: CallTag): Promise<readonly CleanupAction[]>
  automation(): AutomationState
  /** Only with the `budget` option. */
  budget(context: CallTag): Promise<BudgetState | undefined>
  /**
   * For a call that would make a machine run (ensure, resume, a submit to a hibernated work, exec with `wake`): throws
   * `BUDGET_REACHED` when `budget.action` is `refuse` and either cap is reached. Machine-hours are from the ledger, so
   * they refuse for a member too; an unmeasurable money cap alone acts as warn.
   */
  assertBudget(context: CallTag): Promise<void>
}

// A phase and a saved state are part of the status report's vocabulary; re-exported so a handler needs one import.
export type { Phase, SavedState }
