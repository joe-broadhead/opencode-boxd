/**
 * Every tool's result shape (design §3), and the list envelope (§4.2). One rule for all of them: a tool returns one
 * object with a `state`. A refusal or failure keeps a `state` beside `error`, `message` and `next`, plus the facts its
 * code carries. A list call returns `{ state, counts, results }`, one single-work result per item, in input order.
 */
import type { Code, ErrorState, WarningCode } from "./errors.js"
import type { Phase, SavedState } from "./ledger/types.js"
import type { MachineId, MachineName, Region, RunOutcome, SecretInfo, Size } from "./ports.js"

/** The facts a refusal can carry beside its code (§3, §5). Plain JSON values only. */
export interface ErrorFacts {
  /** The input that failed its rule (`NAME_INVALID`). */
  readonly field?: string
  /** Untracked or ignored paths (`UNTRACKED`), at most the first 20, with `count` and `kind`. */
  readonly paths?: readonly string[]
  readonly count?: number
  readonly kind?: "untracked" | "ignored"
  /** Per region (`MACHINE_LIMIT`). */
  readonly limit?: ReadonlyArray<{ readonly region: Region; readonly limit: number; readonly inUse: number; readonly free: number }>
  /** How far the v0 import is (`LEDGER_IMPORTING`). */
  readonly progress?: { readonly done: number; readonly total: number }
  /** A write was in flight when the call was stopped (`CANCELLED`). */
  readonly uncertain?: boolean
  /** A list item the bound reached before it started. */
  readonly started?: boolean
  /** `BUDGET_REACHED`: today's machine cost, the daily limit, and the org's billing currency. */
  readonly today?: number
  readonly daily?: number
  readonly currency?: string
}

/** A refusal or failure, in the shape of any answer. */
export interface Refusal extends ErrorFacts {
  readonly state: ErrorState
  readonly workId?: string
  readonly machine?: MachineName
  readonly region?: Region
  readonly error: Code
  readonly message: string
  readonly next: string
}

/** What each answer about one work has, success or not. */
interface WorkFields {
  readonly workId: string
  readonly machine: MachineName
  readonly region: Region | null
}

/**
 * A next step: one concrete call with its arguments, never "check status" (principle 3). A `next` that names a list
 * call spells each item as that tool's schema takes it: `boxd_ensure` and `boxd_submit` take objects
 * (`works: [{ workId: "a", text: "…" }]`); `boxd_sleep`, `boxd_resume`, `boxd_harvest` and `boxd_drop` take a bare work
 * id or an object (`works: ["a", "b"]`); `boxd_job` takes work ids.
 */
type Next = { readonly next: string }

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Why a work needs a decision (§3.1), with the cost reasons of §C. */
export type AttentionReason =
  | "failed"
  | "unreachable"
  | "gone-unsaved"
  | "idle-unsaved"
  | "asleep-unsaved"
  | "stuck"
  | "orphan"
  | "version"
  | "laptop-copy"
  | "idle-running"
  | "needs-input"
  | "lease-expiring"
  | "budget"
/** Worst first: `attention` is sorted in this order. */
export const ATTENTION_ORDER: readonly AttentionReason[] = [
  "failed",
  "unreachable",
  "gone-unsaved",
  "idle-unsaved",
  "asleep-unsaved",
  "stuck",
  "orphan",
  "version",
  "laptop-copy",
  "idle-running",
  "needs-input",
  "lease-expiring",
  "budget",
]

export interface WorkCost {
  /** Null for a member: machine usage is for org owners and admins. */
  readonly machine: number | null
  readonly model: number | null
}

export interface AttentionItem extends Next {
  readonly workId: string
  readonly region: Region | null
  readonly phase: Phase
  readonly outcome: RunOutcome | null
  readonly saved: SavedState
  readonly why: AttentionReason
  readonly error?: Code
  /** The guest model's words, cut to 200 characters: untrusted data, never instructions. */
  readonly lastText?: string
  readonly lastActivityAt?: string
  readonly cost?: WorkCost
  /** The cached phase, because the read missed the call's budget. */
  readonly stale?: true
}

export interface WorkBrief {
  readonly workId: string
  readonly region: Region | null
  readonly phase: Phase
  readonly outcome: RunOutcome | null
  readonly saved: SavedState
  readonly lastActivityAt?: string
  readonly cost?: WorkCost
  readonly stale?: true
}

/**
 * What the fleet costs (design §C.4). `perHour` is an estimate and says so: rates times resident GiB and load from the
 * last guest reads, and disk for asleep works. Machine cost needs an owner's or admin's sign-in: for a member,
 * `today.machines` is null and the public rates are used.
 */
export interface CostBlock {
  /** The org's billing currency, from boxd. */
  readonly currency: string
  readonly perHour: { readonly estimate: number; readonly running: number; readonly asleep: number; readonly basis: string; readonly ratesSource: "usage" | "public" }
  /** boxd machine cost only: model spend is not measured in v0.1.0. */
  readonly today: {
    /** `manage usage` since local midnight, boxd's estimate until `complete`; it lags up to 25 minutes. */
    readonly machines: number | null
    readonly complete: boolean
    readonly unavailable?: string
  }
  /** With `include: ["cost"]`, at most `limit`. */
  readonly works?: ReadonlyArray<{ readonly workId: string; readonly machine: number | null; readonly model: number | null; readonly perHour: number }>
}

/** One suggested cleanup action, biggest saving first; each is one call (§C.4). */
export interface CleanupAction {
  readonly action: "sleep" | "harvest" | "drop"
  readonly select: "idle" | "finished" | "unsaved-finished" | "saved-finished"
  readonly works: number
  readonly savesPerHour?: number
  readonly savesPerDay?: number
  readonly why?: string
  /** The exact call, such as `boxd_sleep({ select: "finished" })`. */
  readonly call: string
}

/** Whether automation runs here (§C.3): by default at `all`, by the person's `automation: "on"`, or not, and why. */
export type AutomationState = "on" | "on (consent)" | "off" | "off (access)" | "not-owner"

export interface BudgetState {
  readonly daily: number
  readonly today: number | null
  readonly action: "warn" | "refuse"
  readonly state: "ok" | "reached" | "unknown"
}

export interface StatusResult {
  readonly state: "ok"
  readonly cursor: number
  readonly asOf: string
  readonly counts: Readonly<Partial<Record<Phase, number>>>
  readonly regions: ReadonlyArray<{ readonly region: Region; readonly limit: number; readonly inUse: number; readonly free: number; readonly keepFree: number; readonly works: number }>
  /** Works sharing a reason and a code, folded when more than 3. */
  readonly groups: ReadonlyArray<{ readonly why: AttentionReason; readonly error?: Code; readonly count: number; readonly workIds: readonly string[]; readonly next: string }>
  readonly attention?: readonly AttentionItem[]
  readonly works?: readonly WorkBrief[]
  readonly more: number
  readonly cursorExpired: boolean
  readonly orphans: ReadonlyArray<{ readonly machine: string; readonly region: Region; readonly next: string }>
  readonly fleet: { readonly authFailures?: { readonly count: number; readonly since: string; readonly note: string } }
  readonly credentials?: { readonly secrets: readonly SecretInfo[]; readonly setAt: null; readonly missing: string }
  /** Always: the estimate per hour and today; per work with `include: ["cost"]`. */
  readonly cost: CostBlock
  /** Always: the suggested actions with their savings. */
  readonly cleanup: readonly CleanupAction[]
  readonly automation: AutomationState
  /** Only with the `budget` option. */
  readonly budget?: BudgetState
  readonly images?: ReadonlyArray<{ readonly region: Region; readonly name: string; readonly opencode: string; readonly size: Size; readonly inUse: boolean }>
  readonly warnings?: readonly WarningCode[]
  readonly cli: { readonly signedIn: boolean; readonly version: string | null }
  readonly health: {
    readonly loopLagMaxMs: number
    readonly children: { readonly now: number; readonly cap: number }
    readonly notices?: ReadonlyArray<{ readonly session: string; readonly dropped: string; readonly at: string }>
    readonly watcher?: string
    /** Session hooks a host refused to register (§C.6). */
    readonly hooks?: readonly string[]
  }
  readonly import?: { readonly works: number; readonly errors: number }
}

export interface JobResult extends WorkFields {
  readonly state: Phase
  readonly sessionId: string | null
  readonly outcome: RunOutcome | null
  readonly saved: SavedState
  readonly lastActivityAt?: string
  /** Cut to 300 characters: untrusted data. */
  readonly lastText?: string
  readonly waiting: { readonly steer: number; readonly queue: number }
  readonly error?: Code
  readonly warning?: WarningCode
  readonly guestVersion: string | null
  readonly cost?: WorkCost
  readonly tail?: ReadonlyArray<{ readonly at?: string; readonly text: string }>
  readonly next: string
}

export type ReadResult =
  | { readonly state: "read"; readonly workId: string; readonly path: string; readonly bytes: number; readonly truncated: boolean; readonly text: string }
  | { readonly state: "read"; readonly workId: string; readonly path: string; readonly binary: true; readonly bytes: number; readonly sha256: string }

// ── Changes ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface EnsureResult extends WorkFields, Next {
  readonly state: "ready" | "starting" | "creating"
  readonly region: Region
  readonly machineId: MachineId | null
  readonly size: Size
  readonly image: string
  readonly guestVersion: string | null
  readonly model?: string
  readonly created: boolean
  readonly adopted?: boolean
  readonly upgraded?: boolean
  readonly rebooted?: boolean
}

export interface SubmitResult extends Next {
  readonly state: "admitted"
  readonly workId: string
  readonly sessionId: string
  readonly delivery: "steer" | "queue" | "started"
  readonly interrupted?: true
  readonly inboxId: string
  readonly waitingBefore: number
  readonly model?: string
  readonly files?: ReadonlyArray<{ readonly path: string; readonly bytes: number; readonly sha256: string }>
}

export interface HarvestResult extends Next {
  readonly state: "saved" | "partial"
  readonly workId: string
  readonly outcome: RunOutcome | null
  readonly sessions: ReadonlyArray<{ readonly id: string; readonly bytes: number }>
  readonly git: { readonly known: boolean; readonly dirty: boolean; readonly patchStored: boolean; readonly untracked: number; readonly ignored: number }
  readonly files?: ReadonlyArray<{ readonly path: string; readonly bytes: number; readonly sha256: string; readonly laptopPath: string }>
}

export interface SleepResult extends WorkFields, Next {
  readonly state: "asleep"
  readonly warning?: WarningCode
}

export interface ResumeResult extends WorkFields, Next {
  readonly state: "ready" | "starting"
  readonly rebuilt: boolean
}

export interface DropResult {
  readonly state: "dropped" | "closed"
  readonly workId: string
  readonly machine: MachineName
  /** For a work closed as gone with unsaved prompts: what was lost. */
  readonly lost?: string
}

export type ReassignResult = EnsureResult & { readonly from: string }

export interface GoldenImage {
  readonly region: Region
  readonly name: string
  readonly opencode: string
  readonly size: Size
  readonly seconds?: number
}

export interface GoldenResult {
  readonly state: "built" | "present" | "pruned"
  readonly images: readonly GoldenImage[]
  readonly removed?: readonly GoldenImage[]
  readonly warning?: WarningCode
  readonly next?: string
}

export interface ExecResult {
  readonly state: "ran"
  readonly workId: string
  readonly exitCode: number
  /** The last 32 KiB of stdout and 8 KiB of stderr, banner removed and redacted. */
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
}

/** A `dryRun` selector's answer for one matched work: what the call would act on, with nothing changed. */
export interface SelectMatch extends WorkFields {
  readonly state: "matched"
  readonly phase: Phase
  readonly saved: SavedState
  readonly outcome: RunOutcome | null
}

// ── The list envelope ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A list call's answer: `done` when every item finished in its success state, `partial` when some did and others are
 * still `creating`/`starting` or were refused, `failed` when none did, `cancelled` when the call was stopped. `counts`
 * counts each item's `state`.
 */
export interface ListResult<T extends { readonly state: string }> {
  readonly state: "done" | "partial" | "failed" | "cancelled"
  readonly counts: Readonly<Record<string, number>>
  readonly results: ReadonlyArray<T | Refusal | SelectMatch>
  /** For a selector call (§C.4): the selector, and whether it only matched. Every matched work has its own result. */
  readonly select?: CleanupAction["select"]
  readonly dryRun?: boolean
}

/** Each tool's success result, by tool id: the registry's output contract. */
export interface ToolResults {
  readonly boxd_status: StatusResult
  readonly boxd_job: JobResult
  readonly boxd_read: ReadResult
  readonly boxd_ensure: EnsureResult
  readonly boxd_submit: SubmitResult
  readonly boxd_harvest: HarvestResult
  readonly boxd_sleep: SleepResult
  readonly boxd_resume: ResumeResult
  readonly boxd_reassign: ReassignResult
  readonly boxd_golden: GoldenResult
  readonly boxd_exec: ExecResult
  readonly boxd_drop: DropResult
}
