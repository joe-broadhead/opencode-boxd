/**
 * What every run, hook and loop depends on, declared once (design §9.1). `src/plugin.ts` builds these services once,
 * in a fixed order, from one entry module per package; a package fills its own entry module and never edits
 * `src/tools.ts`, `src/plugin.ts` or this file.
 *
 * | Package | Entry module | Provides |
 * |---|---|---|
 * | A. Runtime | `src/exec/runtime.ts` | `createRuntime`: runner, boxd port, guest port, laptop port |
 * | B. Ledger and import | `src/import-v0.ts`, `src/ledger/index.ts` | `createImportV0`, `createLedger` |
 * | D. Fleet view | `src/watch.ts`, `src/fleet/view.ts` | `createWatch`; `viewRuns` (status, job) |
 * | E. Cost and cleanup | `src/cost/index.ts`; `src/automation.ts`, `src/hooks.ts`, `src/cleanup.ts` | `createCost`; automation, hooks, `/boxd-cleanup` |
 * | C1. Machines | `src/fleet/machines.ts` | `machineRuns` (ensure, resume, reassign, golden) |
 * | C2. Sessions | `src/fleet/sessions.ts` | `sessionRuns` (submit, harvest, sleep, drop, exec, read), the selectors, `FleetActions` |
 *
 * Order: runtime → import → ledger → watch → cost → C1, C2, D runs → E's automation, hooks and command (which use C2's
 * `FleetActions`). Each later stage sees only what the stages before it built.
 *
 * The shared contract files change only on the integration branch, never in a package's PR: `src/services.ts`,
 * `src/ports.ts`, `src/results.ts`, `src/errors.ts`, `src/tools.ts`, `src/permissions.ts`, `src/options.ts` and
 * `src/plugin.ts`. A package that needs a contract change asks for it there. Every other file names its owner in its
 * header or in the table above.
 */
import type { Plugin } from "@opencode/plugin"
import type { Options } from "./options.js"
import type { BoxdPort, CallTag, FleetWatch, GuestPort, ImportV0Port, LaptopPort, LedgerPort, Runner } from "./ports.js"
import type {
  AutomationState,
  BudgetState,
  CleanupAction,
  CostBlock,
  DropResult,
  HarvestResult,
  ListResult,
  NotImplemented,
  Refusal,
  SleepResult,
  ToolResults,
} from "./results.js"
import type { CallContext } from "./tools.js"

export interface Clock {
  now(): Date
}

/** The host's session API the plugin uses: the root walk for notices, notices themselves, and the idle check's read. */
export type SessionAccess = Pick<Plugin.Context["session"], "get" | "synthetic" | "context">

/** Package A's entry: `createRuntime`. */
export interface Runtime {
  readonly runner: Runner
  readonly boxd: BoxdPort
  readonly guest: GuestPort
  readonly laptop: LaptopPort
}

/** Built from the host and the options alone. */
export interface HostServices {
  readonly options: Options
  /** This laptop's OpenCode: a golden image, and a guest that moves a transcript, must match it. */
  readonly hostVersion: string | null
  readonly projectDirectory: string
  /** The ledger's root, `~/.local/share/opencode-boxd` unless a test says otherwise. */
  readonly ledgerRoot: string
  readonly boxdBin: string
  readonly clock: Clock
  readonly sessions: SessionAccess
  /** Records a problem for status under its area (one per area; undefined clears it). Never throws. */
  readonly report: (area: string, problem: string | undefined) => void
}

/** Packages A and B: every port. */
export interface CoreServices extends HostServices, Runtime {
  readonly ledger: LedgerPort
  readonly importV0: ImportV0Port
}

/** What C1, C2 and D's runs get: the core, the watcher (D) and cost (E). */
export interface FleetServices extends CoreServices {
  readonly watch: FleetWatch
  readonly cost: CostPort
}

/** What E's automation, hooks and command get: the fleet services, and C2's in-process actions. */
export interface CostServices extends FleetServices {
  readonly actions: FleetActions
}

/** Something a stage started that the plugin stops when it is disposed. */
export type Dispose = () => Promise<void>

// ── Runs ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ToolId = keyof ToolResults

/** One tool's run: its success result, a refusal, a list envelope, or the scaffold's answer while it is not built. */
export type Run<T extends { readonly state: string }> = (input: Record<string, unknown>, call: CallContext) => Promise<T | Refusal | ListResult<T> | NotImplemented>

export type ToolRuns = { readonly [K in ToolId]: Run<ToolResults[K]> }

/** The selectors of design §C.4, per tool. */
export interface SelectorValues {
  readonly boxd_sleep: "idle" | "finished"
  readonly boxd_harvest: "unsaved-finished"
  readonly boxd_drop: "saved-finished"
}
export type Selector = SelectorValues[keyof SelectorValues]

/**
 * Resolves a `select` to work ids at call time, against a fresh listing and the ledger. A read: it changes nothing.
 * The registry asserts the tool's action with exactly these ids, and the run acts on exactly `call.matched`.
 */
export type Selectors = { readonly [K in keyof SelectorValues]: (select: SelectorValues[K], call: CallContext) => Promise<readonly string[]> }

// ── C2's actions for E (design §C.3, §C.5) ────────────────────────────────────────────────────────────────────────

/** Who runs an action outside a tool call: the automation loop, or `/boxd-cleanup` after the person confirmed. */
export interface ActionContext {
  readonly by: "automation" | "cleanup-command"
  readonly call: CallTag
  readonly signal?: AbortSignal
}

/**
 * C2's harvest, sleep and drop, in-process, through the same code as the tools, for package E. Pre-authorised: the
 * caller has its consent already (automation by `access` or `automation: "on"`; `/boxd-cleanup` by the person's prompt),
 * so nothing here asserts. Automation never calls `drop`; only `/boxd-cleanup` does, and drop's whole guard still runs
 * per work.
 */
export interface FleetActions {
  match<K extends keyof SelectorValues>(tool: K, select: SelectorValues[K], context: ActionContext): Promise<readonly string[]>
  harvest(workIds: readonly string[], context: ActionContext): Promise<ListResult<HarvestResult>>
  sleep(workIds: readonly string[], context: ActionContext): Promise<ListResult<SleepResult>>
  drop(workIds: readonly string[], context: ActionContext): Promise<ListResult<DropResult>>
}

// ── E's cost service for C1, C2 and D (design §C.4, §C.5) ─────────────────────────────────────────────────────────

export interface CostPort {
  /** The `cost` block of `boxd_status`; per-work figures only when asked (`include: ["cost"]`). */
  block(options: { readonly works: boolean; readonly limit: number }, context: CallTag): Promise<CostBlock>
  /** The `cleanup` block: suggested actions, biggest saving first. */
  cleanup(context: CallTag): Promise<readonly CleanupAction[]>
  automation(): AutomationState
  /** Only with the `budget` option. */
  budget(context: CallTag): Promise<BudgetState | undefined>
  /**
   * For a call that would make a machine run (ensure, resume, a submit to a hibernated work, exec with `wake`): throws
   * `BUDGET_REACHED` when `budget.action` is `refuse` and the budget is reached; never for a member, who cannot measure it.
   */
  assertBudget(context: CallTag): Promise<void>
}

// ── The scaffold ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A port whose package has not built it yet: any member throws, naming it. Goes with the last stub. */
export function notBuilt<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_target, member) => {
      if (member === "then") return undefined
      return () => {
        throw new Error(`${name}.${String(member)} is not built yet on this branch.`)
      }
    },
  })
}

/** A run whose package has not built it yet: a typed answer, never a throw. Goes with the last stub. */
export function notBuiltRun<T extends { readonly state: string }>(owner: string): Run<T> {
  return async (): Promise<NotImplemented> => ({
    state: "failed",
    error: "NOT_IMPLEMENTED",
    message: `This tool is not built yet on this branch (package ${owner}).`,
    next: "Use a released version of the plugin.",
  })
}
