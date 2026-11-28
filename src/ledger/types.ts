/**
 * The laptop ledger, format 1 (design §2.2): the record of every work, the event log and the index. Types and fixed
 * names only; the store, the cross-process locks, the index refresh and `events.jsonl` are package B's (`src/ledger/*`).
 *
 * Rules every writer keeps:
 *
 * - **One writer per work, across processes:** a lock folder (`work.lock`, made with an atomic `mkdir`, holding the pid
 *   and the time, stale after 60 s without a heartbeat) for every write, with the per-process queue on top. Lock order:
 *   work locks in sorted id order, then machine locks keyed by `machineId`.
 * - **Copy-on-write, never in place:** every ledger file, exports and patches included, is written as a unique temp file
 *   in the same folder, verified where it has a digest, fsynced, and renamed over the old one. The one exception is the
 *   append-only `events.jsonl`, which is appended to, never rewritten, verified or hard-linked.
 * - **Reads are cheap:** the index is refreshed only for records whose `mtimeMs` changed, and closed works are not loaded
 *   unless asked for.
 * - **Remotes** are stored without their userinfo.
 * - The folder is 0700 and its files 0600.
 */
import type { Delivery, DoneReport, MachineId, MachineName, Rates, Reading, Region, RunOutcome, Size, WorkEvent, WorkLabels } from "../ports.js"
import type { WarningCode } from "../errors.js"

export const LEDGER_FORMAT = 1

/** The paths under `~/.local/share/boxd-plugin/`, relative to it. */
export const LEDGER_PATHS = {
  v1: "v1",
  works: "v1/works",
  events: "v1/events.jsonl",
  index: "v1/index.json",
  /** The automation owner's lock (design §C.3): only its holder auto-harvests, auto-sleeps and renews leases. */
  automationLock: "automation.lock",
  /** One process copies the ledger to its registry at a time. */
  registryLock: "registry.lock",
  /** The ledger's own id, made once; every work's machine carries it as its `ledger` label. */
  id: "ledger-id",
} as const

/** A work's files, relative to `v1/works/<workId>/`. */
export const WORK_FILES = {
  record: "work.json",
  lock: "work.lock",
  exports: "exports",
  patch: "patch.diff",
  untracked: "untracked",
} as const

/** The event log keeps at least this much (one rotated file); a `since` older than its oldest event is `cursorExpired`. */
export const EVENTS_ROTATE_BYTES = 5 * 1024 * 1024
/** A lock whose heartbeat is older than this is stale and may be taken over. */
export const LOCK_STALE_MS = 60_000
export const LOCK_HEARTBEAT_MS = 10_000

/** What a work is doing now: one vocabulary for every tool (design §2.1). */
export type Phase = "creating" | "starting" | "ready" | "busy" | "idle" | "asleep" | "gone" | "unreachable" | "closed"
export const PHASES: readonly Phase[] = ["creating", "starting", "ready", "busy", "idle", "asleep", "gone", "unreachable", "closed"]

/** Phases whose machine runs and bills RAM; `asleep` bills disk only; `gone` and `closed` bill nothing. */
export const RUNNING_PHASES: ReadonlySet<Phase> = new Set(["creating", "starting", "ready", "busy", "idle", "unreachable"])

/**
 * Whether this laptop holds the work, computed, never stored: `fresh` when `saved.complete && saved.at >=
 * lastSubmit.at`; `stale` when `saved` exists but is older or partial; `none` otherwise.
 */
export type SavedState = "fresh" | "stale" | "none"

/** Who put a machine to sleep, when the plugin knows: a tool call, or the plugin's own automation (§C.3). */
export type SleptBy = "boxd_sleep" | "automation"

export interface SavedSession {
  readonly id: string
  readonly parentId: string | null
  readonly sha256: string
  readonly bytes: number
  /** The guest's own marks at the harvest: drop compares the id and the count; `updated` is a hint (L-d). */
  readonly lastMessageId: string | null
  readonly messages: number
  readonly updated: number
  /** The laptop's id, only when it differs from the guest's (no tested host does this). */
  readonly laptopId?: string
}

export interface Saved {
  readonly at: string
  /** False for a partial harvest: a copy, not a reason to drop. */
  readonly complete: boolean
  readonly guestVersion: string
  readonly sessions: readonly SavedSession[]
}

export interface MovedFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly at: string
  /** Where the laptop holds a file that came back. */
  readonly laptopPath?: string
}

export interface GitState {
  readonly known: boolean
  /** Without userinfo. */
  readonly remote: string | null
  readonly branch: string | null
  readonly sha: string | null
  readonly dirty: boolean
  readonly patchStored: boolean
  readonly untracked: readonly string[]
  readonly ignored: readonly string[]
  readonly untrackedStored: boolean
}

export interface WorkWarning {
  readonly code: WarningCode
  readonly at: string
}

/**
 * The machine time and money the ledger has counted for one work, counted to `at`. The watcher adds the interval since
 * the last change whenever a phase changes: `existedSeconds` for every phase but `gone` and `closed`,
 * `runningSeconds` for the running phases (`RUNNING_PHASES`), and `asleepSeconds` for `asleep`. The `today*` counters
 * cover `day`, the local day. Each interval is priced at the rates current at that change, and `cost` is in `currency`;
 * a change of currency starts the money counters again. `reading` and `share` price and split the interval after `at`.
 */
export interface MeteredHours {
  readonly existedSeconds: number
  readonly runningSeconds: number
  readonly asleepSeconds: number
  readonly todayExistedSeconds: number
  readonly todayRunningSeconds: number
  readonly todayAsleepSeconds: number
  /** The estimate for the whole work, in `currency`, at each interval's rates. */
  readonly cost: number
  /** The part of `cost` since local midnight. */
  readonly todayCost: number
  /** The currency `cost` is in; a later interval in another currency starts `cost` again in that one. */
  readonly currency: string
  /** Whose rates the estimate used: the organisation's, or boxd's public ones. */
  readonly ratesSource: Rates["source"]
  /** The last guest reading, which prices the interval after `at`. */
  readonly reading?: Reading
  /** The share of its machine the interval after `at` is charged: one divided by the open works on it; 1 for its own machine. */
  readonly share?: number
  /** `YYYY-MM-DD` in this machine's local day, which the `today*` counters cover. */
  readonly day: string
  /** The phase the counters are counted to. */
  readonly phase: Phase
  /** When the counters were last counted. */
  readonly at: string
}

export interface WorkRecord {
  readonly format: typeof LEDGER_FORMAT
  readonly workId: string
  readonly state: "open" | "closed"
  readonly closed?: { readonly at: string; readonly how: "dropped" | "gone" | "reassigned"; readonly to?: string }
  /** Null until a machine is recorded for the work. */
  readonly region: Region | null
  readonly machine: MachineName
  /** Every change acts on it (design §4.1); null until a `get` answers. */
  readonly machineId: MachineId | null
  /** True when the work holds a slot on a shared machine, which many open works record. */
  readonly slot?: true
  readonly size: Size
  /** `opencode` is null until a read has learned the guest's version. */
  readonly image: { readonly name: string; readonly opencode: string | null }
  /** The machine was created from the repository's warm image, not the version's golden image. */
  readonly warm?: boolean
  /** Made by a plugin version that measures `readySeconds`: an older record's first ready is not known. */
  readonly tracked?: boolean
  /** When the work first reached `ready`: `readySeconds` counts from `createdAt`. */
  readonly readyAt?: string
  readonly laptopDirectory: string
  readonly guestDirectory: string
  readonly repo?: { readonly url: string; readonly ref?: string }
  /** The guest's git identity, never a token. */
  readonly git?: { readonly name: string; readonly email: string }
  /** The variable names the work declares, never their values: the guest's OpenCode gets these and nothing else. */
  readonly env?: readonly string[]
  /** What the work is: product, role, feature and task. On its own machine it also carries them as `work.*` labels. */
  readonly labels?: WorkLabels
  readonly model?: string
  readonly title?: string
  readonly createdAt: string
  readonly session?: {
    readonly rootId?: string
    /** The root coordinator session that started or last drove the work: the target of its notices (§3.13). */
    readonly notify?: string
  }
  readonly lastSubmit?: { readonly at: string; readonly delivery: Delivery; readonly by?: string }
  readonly saved?: Saved
  readonly run?: { readonly outcome: RunOutcome; readonly error?: string; readonly at: string }
  /** The guest's done report, kept across sleep and harvest; a new submit clears it. */
  readonly done?: DoneReport
  readonly gitState?: GitState
  readonly files?: { readonly in: readonly MovedFile[]; readonly out: readonly MovedFile[] }
  readonly slept?: { readonly at: string; readonly by: SleptBy }
  /** Set before the create; cleared once the machine and its id are recorded. */
  readonly pendingCreate?: { readonly at: string; readonly image: string }
  /** Set by `boxd_reassign` before the rename; the next `ensure` for either id finishes it. */
  readonly pendingRename?: { readonly from: string; readonly machineId: MachineId; readonly at: string }
  /** Set when `boxd_ensure({ select: "orphans" })` adopted a machine that no record owned. */
  readonly adopted?: { readonly at: string; readonly from: "orphan" }
  readonly reboots?: ReadonlyArray<{ readonly at: string; readonly why: "agent-silent" | "repair" }>
  /** The machine time and its cost the watcher has counted for this work; absent until its first phase change. */
  readonly hours?: MeteredHours
  /** When a plugin call last touched the work: automation's `orphanHours` counts from it (§C.3). */
  readonly touchedAt?: string
  /** The `leaseDays` delete-after timer, when the option set one: renewed at most once per 6 hours (§C.2). */
  readonly lease?: { readonly days: number; readonly renewedAt: string; readonly expiresAt: string }
  readonly warnings?: readonly WorkWarning[]
}

/** One line of `index.json`: a cache, rebuilt from `work.json` when its `mtimeMs` changed. */
export interface IndexEntry {
  readonly state: WorkRecord["state"]
  readonly region: Region | null
  readonly phase: Phase | null
  readonly saved: SavedState
  readonly mtimeMs: number
}

export interface LedgerIndex {
  readonly format: typeof LEDGER_FORMAT
  readonly works: Readonly<Record<string, IndexEntry>>
}

/** One line of `events.jsonl`: exactly one `WorkEvent` (`src/ports.ts`), the one event shape, as JSON. */
export type EventLine = WorkEvent

/** The `complete` marker's body. */
export interface CompleteMarker {
  readonly at: string
  readonly works: number
  readonly blocked: number
  /** sha256 of the sorted list of input files. */
  readonly inputDigest: string
}
