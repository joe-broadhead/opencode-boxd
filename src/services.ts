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
import type { Plugin, Rpc } from "@opencode/plugin"
import { COMMAND_STEM, PLUGIN_ID } from "./constants.js"
import type { Phase, SavedState } from "./ledger/types.js"
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
  /**
   * On plugin disposal or reload: `runner.dispose()` (every in-flight child aborted, queued ones dropped) and any timer
   * or cache the ports hold. Called last, after every stage that spawns through it.
   */
  dispose(): Promise<void>
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
  /**
   * The laptop's `opencode` binary, for the laptop port's session delete and import: resolved once from the server's
   * PATH when the plugin starts (an absolute path when found there), or the test seam's. Nothing else defaults to PATH.
   */
  readonly opencodeBin: string
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

// ── E's cleanup view for D's TUI (design §C.5) ──────────────────────────────────────────────────────────────────

/**
 * What `/boxd-cleanup` and its TUI view show: what costs money now, and the cleanup actions with their savings. Package E
 * builds it (`CleanupViewProvider`, in `src/cleanup.ts`); package D's `src/tui.ts` renders it through
 * `CleanupViewRpc`, and its buttons run `command`, which confirms each action with the host's permission prompt. The
 * view itself approves nothing.
 */
export interface CleanupView {
  /** `unavailable` while the cost or the fleet cannot be read; `note` says why. */
  readonly state: "ok" | "unavailable"
  readonly currency: string | null
  /** The fleet's estimate per hour; null when it cannot be estimated. */
  readonly perHour: number | null
  /** Each running work: its cost per hour, idle time and `saved`, costliest first. */
  readonly works: ReadonlyArray<{
    readonly workId: string
    readonly phase: Phase
    readonly saved: SavedState
    readonly perHour: number | null
    readonly idleMinutes: number | null
  }>
  readonly actions: readonly CleanupAction[]
  readonly automation: AutomationState
  /**
   * How the command confirms each action at this `access`: the tool's own action (`ask-changes`), `boxd_cleanup`
   * (`all`), or not at all, reporting only (`read-only`).
   */
  readonly confirm: "tool-action" | "cleanup-action" | "report-only"
  /** The command the view's buttons run: `/boxd-cleanup`. */
  readonly command: string
  readonly note?: string
}

export interface CleanupViewProvider {
  view(context: CallTag): Promise<CleanupView>
}

export const CLEANUP_COMMAND = `${COMMAND_STEM}-cleanup`

const nullableNumber = { type: ["number", "null"] }

/** The one read-only RPC the TUI calls for the view. Registered by `src/plugin.ts` with E's provider. */
export const CleanupViewRpc = {
  id: `${PLUGIN_ID}.cleanup`,
  methods: {
    view: {
      input: { type: "object" },
      output: {
        type: "object",
        required: ["state", "currency", "perHour", "works", "actions", "automation", "confirm", "command"],
        properties: {
          state: { enum: ["ok", "unavailable"] },
          currency: { type: ["string", "null"] },
          perHour: nullableNumber,
          works: {
            type: "array",
            items: {
              type: "object",
              required: ["workId", "phase", "saved", "perHour", "idleMinutes"],
              properties: { workId: { type: "string" }, phase: { type: "string" }, saved: { enum: ["fresh", "stale", "none"] }, perHour: nullableNumber, idleMinutes: nullableNumber },
            },
          },
          actions: { type: "array", items: { type: "object" } },
          automation: { type: "string" },
          confirm: { enum: ["tool-action", "cleanup-action", "report-only"] },
          command: { type: "string" },
          note: { type: "string" },
        },
      },
      errors: { unavailable: { type: "object", required: ["nextStep"], properties: { nextStep: { type: "string" } } } },
    },
  },
  events: {},
} satisfies Rpc.PortableDefinition

export function registerCleanupView(rpc: Pick<Plugin.Context["rpc"], "register">, provider: CleanupViewProvider) {
  return rpc.register(CleanupViewRpc, {
    view: (_input, { error }) =>
      provider.view({ callId: `cleanup-view-${Date.now()}`, source: "cleanup-command" }).catch((cause: unknown) =>
        error("unavailable", `STATUS_UNAVAILABLE: Could not read boxd's cleanup view (${cause instanceof Error ? cause.message : String(cause)}).`, {
          nextStep: "Restart OpenCode, then run /boxd-cleanup again.",
        }),
      ),
  })
}

// ── The scaffold ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A port whose package has not built it yet: any member throws, naming it, except `dispose`, which does nothing. */
export function notBuilt<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get: (_target, member) => {
      if (member === "then") return undefined
      if (member === "dispose") return async () => {}
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
