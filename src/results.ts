/**
 * Every tool's result shape (design §3), and the list envelope (§4.2). One rule for all of them: a tool returns one
 * object with a `state`. A refusal or failure keeps a `state` beside `error`, `message` and `next`, plus the facts its
 * code carries. A list call returns `{ state, counts, results }`, one single-work result per item, in input order.
 */
import type { Code, ErrorState, WarningCode } from "./errors.js"
import type { Phase, SavedState } from "./ledger/types.js"
import type { RegionChoice } from "./options.js"
import type { DoneReport, MachineId, MachineName, MachineStatus, Region, RunOutcome, SecretInfo, Size } from "./ports.js"

/** The facts a refusal can carry beside its code (§3, §5). Plain JSON values only. */
export interface ErrorFacts {
  /** The input that failed its rule (`NAME_INVALID`). */
  readonly field?: string
  /** Untracked or ignored paths (`UNTRACKED`), at most the first 20, with `count` and `kind`. */
  readonly paths?: readonly string[]
  readonly count?: number
  readonly kind?: "untracked" | "ignored"
  /** Commits a local ref or HEAD holds that no remote ref contains (`UNPUSHED`), at most the first 20. */
  readonly commits?: readonly string[]
  /** `UNPUSHED_UNKNOWN`: the guest could not tell, and a drop must refuse. */
  readonly unknown?: boolean
  /** Per region (`MACHINE_LIMIT`). */
  readonly limit?: ReadonlyArray<{ readonly region: Region; readonly limit: number; readonly inUse: number; readonly free: number }>
  /** The regions the option `regions` allows, when a placement was refused (`REGION_NOT_ALLOWED`). */
  readonly allowed?: readonly Region[]
  /** A write was in flight when the call was stopped (`CANCELLED`). */
  readonly uncertain?: boolean
  /** A list item the bound reached before it started. */
  readonly started?: boolean
  /** `BUDGET_REACHED`: today's machine cost, the daily limit, and the org's billing currency. */
  readonly today?: number
  readonly daily?: number
  readonly currency?: string
  /** `BUDGET_REACHED`: today's running hours and the ledger's cap. */
  readonly machineHours?: { readonly today: number; readonly cap: number }
  /** `BUDGET_REACHED` for a machine cap: which cap, the count and the cap. */
  readonly scope?: "machines" | "orgMachines"
  readonly inUse?: number
  readonly cap?: number
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
  | "done-unsaved"
  | "stuck"
  | "orphan"
  | "version"
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
  "done-unsaved",
  "stuck",
  "orphan",
  "version",
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

/** Machine-hours from the ledger alone: time the machine existed, and time it ran. */
export interface WorkHours {
  /** Every phase but gone and closed, in hours to two decimals. */
  readonly existed: number
  /** The running phases of `cost/rates.ts`, in hours to two decimals. */
  readonly running: number
}

/** The cost block's machine-hour sums, all from the ledger and needing no owner's sign-in. */
export interface CostHours {
  /** Every work this ledger records. */
  readonly ledger: WorkHours
  /** Since local midnight, for the works this ledger knows. */
  readonly today: WorkHours
  /** Works created since the oldest open work was created; zero when no work is open. */
  readonly since: WorkHours
}

export interface AttentionItem extends Next {
  readonly workId: string
  /** The shared machine a slot work is on; absent for a work with a machine of its own. */
  readonly machine?: MachineName
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
  /** With `include: ["cost"]`: the machine-hours its ledger counted, no owner's sign-in needed. */
  readonly hours?: WorkHours
  /** The cached phase, because the read missed the call's budget. */
  readonly stale?: true
}

export interface WorkBrief {
  readonly workId: string
  /** The shared machine a slot work is on; absent for a work with a machine of its own. */
  readonly machine?: MachineName
  readonly region: Region | null
  readonly phase: Phase
  readonly outcome: RunOutcome | null
  readonly saved: SavedState
  readonly lastActivityAt?: string
  /** The guest's done report: it declared the whole task finished. */
  readonly done?: DoneReport
  readonly cost?: WorkCost
  /** With `include: ["cost"]`: the machine-hours its ledger counted, no owner's sign-in needed. */
  readonly hours?: WorkHours
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
  /** boxd machine cost only: model spend is not measured. */
  readonly today: {
    /** `manage usage` since local midnight, boxd's estimate until `complete`; it lags up to 25 minutes. */
    readonly machines: number | null
    readonly complete: boolean
    readonly unavailable?: string
  }
  /** Machine-hours from the ledger alone: this ledger, today, and since the oldest open work. */
  readonly hours: CostHours
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

/** One orphan as `boxd_ensure({ select: "orphans" })` answers it: adopted with a record, or skipped with why. */
export interface OrphanResult {
  readonly state: "adopted" | "skipped"
  readonly machine: string
  readonly region: Region
  readonly machineId: MachineId | null
  readonly workId?: string
  readonly why: string
  readonly error?: Code
  readonly next?: string
}

export interface BudgetMachineCount {
  readonly inUse: number
  readonly limit: number
}

export interface BudgetState {
  /** The money cap, only with `budget.daily`. */
  readonly daily?: number
  /** Today's machine cost, or null when unreadable or when no money cap is set. */
  readonly today: number | null
  /** Today's running hours against the cap, only with `budget.machineHours`. */
  readonly machineHours?: { readonly today: number; readonly cap: number }
  /** `budget.machines` and this ledger's machine count; absent when `budget.machines` is not set. */
  readonly machines?: BudgetMachineCount
  /** `budget.orgMachines` and the organisation's machine count; absent when `budget.orgMachines` is not set. */
  readonly orgMachines?: BudgetMachineCount
  readonly action: "warn" | "refuse"
  /** `reached` when any configured cap is at its value, `unknown` when a configured cap cannot be measured. */
  readonly state: "ok" | "reached" | "unknown"
}

/** How status accounts for one machine in the organisation. */
export type MachineClass = "work" | "other-ledger" | "kept" | "golden" | "orphan"

/** Why a machine is an orphan: no `ledger` label, this ledger's label with no record, or the plugin's legacy labels only. */
export type OrphanReason = "no-ledger" | "no-record" | "legacy-labels"

/** One orphan as status lists it, with whether any rule may act on it and its one next step. */
export interface OrphanMachine {
  readonly machine: string
  readonly region: Region
  readonly status: MachineStatus
  readonly why: OrphanReason
  readonly actionable: boolean
  readonly next: string
}

/** Every machine state boxd counts, with the states no machine is in at zero; `other` is any state not named. */
export interface MachineCounts {
  readonly running: number
  readonly starting: number
  readonly standby: number
  readonly hibernated: number
  readonly stopped: number
  readonly other: number
}

/** One region's machines against its own limit. */
export interface RegionMachines {
  readonly region: Region
  /** The region's own limit, or null when boxd did not state one for it. */
  readonly limit: number | null
  /** Every machine boxd counts, in any state but `destroyed`. */
  readonly inUse: number
  /** The room left against the limit, or null when the limit is unknown. */
  readonly free: number | null
  readonly byState: MachineCounts
  /** How many of the region's machines this ledger's open works name. */
  readonly works: number
}

/**
 * Every machine's class counted, with the orphans listed and capped, and the organisation's machines against boxd's
 * limit, by state: hibernated and stopped machines still count.
 */
export interface MachineSummary {
  readonly counts: Readonly<Record<MachineClass, number>>
  readonly orphans: readonly OrphanMachine[]
  readonly more: number
  /** The organisation's limit, or null when it could not be read. */
  readonly limit: number | null
  /** Every machine boxd counts, in any state but `destroyed`, across every region. */
  readonly inUse: number
  /** The room left against the limit, or null when the limit is unknown. */
  readonly free: number | null
  readonly byState: MachineCounts
  /** How many of the machines this ledger's open works name. */
  readonly works: number
  /** The same figures for each region. */
  readonly perRegion: readonly RegionMachines[]
}

export interface StatusResult {
  readonly state: "ok"
  readonly cursor: number
  readonly asOf: string
  readonly counts: Readonly<Partial<Record<Phase, number>>>
  /** The default for a new work: `auto`, or the region the option `region` names. */
  readonly region: RegionChoice
  /** The option `regions`: a new work or golden image is placed only in these. */
  readonly allowedRegions: readonly Region[]
  readonly regions: ReadonlyArray<{ readonly region: Region; readonly limit: number; readonly inUse: number; readonly free: number; readonly keepFree: number; readonly works: number }>
  /** Works sharing a reason and a code, folded when more than 3. */
  readonly groups: ReadonlyArray<{ readonly why: AttentionReason; readonly error?: Code; readonly count: number; readonly workIds: readonly string[]; readonly next: string }>
  readonly attention?: readonly AttentionItem[]
  readonly works?: readonly WorkBrief[]
  readonly more: number
  readonly cursorExpired: boolean
  /** Every machine in the organisation: classified, with the orphans listed and capped, and against boxd's limit. */
  readonly machines: MachineSummary
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
  }
}

export interface JobResult extends WorkFields {
  readonly state: Phase
  readonly sessionId: string | null
  readonly outcome: RunOutcome | null
  readonly saved: SavedState
  /** True when the guest declared the whole task finished; `summary` and `prs` say what it finished with. */
  readonly done: boolean
  /** With `done`: the guest's short summary, cut and redacted. */
  readonly summary?: string
  /** With `done`: the pull requests it named, `owner/repo#n` or a URL, at most 20. */
  readonly prs?: readonly string[]
  readonly lastActivityAt?: string
  /** Cut to 300 characters, or with `full` the whole message up to 64,000 with its line breaks: untrusted data. */
  readonly lastText?: string
  readonly waiting: { readonly steer: number; readonly queue: number }
  readonly error?: Code
  readonly warning?: WarningCode
  readonly guestVersion: string | null
  readonly cost?: WorkCost
  /** The machine-hours its ledger counted, always: no owner's sign-in is needed. */
  readonly hours: WorkHours
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
  /** True when the machine was created from the repository's warm image, false for the version's image and a clone. */
  readonly warm: boolean
  /** With `ready`: seconds from the work's first ensure to its first `ready`; later calls answer the same. */
  readonly readySeconds?: number
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
  /** `unpushed` is null when the guest could not tell: never shown as 0. */
  readonly git: { readonly known: boolean; readonly dirty: boolean; readonly patchStored: boolean; readonly untracked: number; readonly ignored: number; readonly unpushed: number | null }
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
  /** The repository URL, for a warm image. */
  readonly repo?: string
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
  readonly select?: CleanupAction["select"] | "orphans"
  readonly dryRun?: boolean
}

/** Each tool's success result, by tool id: the registry's output contract. */
export interface ToolResults {
  readonly boxd_job: JobResult
  readonly boxd_read: ReadResult
  /** A single or list ensure answers works; `select: "orphans"` answers orphans. */
  readonly boxd_ensure: EnsureResult | OrphanResult
  readonly boxd_submit: SubmitResult
  readonly boxd_harvest: HarvestResult
  readonly boxd_sleep: SleepResult
  readonly boxd_resume: ResumeResult
  readonly boxd_reassign: ReassignResult
  readonly boxd_golden: GoldenResult
  readonly boxd_exec: ExecResult
  readonly boxd_drop: DropResult
}
