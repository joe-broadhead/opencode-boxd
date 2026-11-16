/**
 * The laptop ledger, format 1 (design §2.2): the record of every work, the event log and the index. Types and fixed
 * names only; the store, the cross-process locks, the index refresh, `events.jsonl` and the v0 import are package B's
 * (`src/ledger/*`, `src/import-v0.ts`).
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
import type { Delivery, MachineId, MachineName, Region, RunOutcome, Size, WorkEvent } from "../ports.js"
import type { WarningCode } from "../errors.js"

export const LEDGER_FORMAT = 1

/** The paths under `~/.local/share/opencode-boxd/`, relative to it. */
export const LEDGER_PATHS = {
  /** The published v1 ledger: present only once complete (published by one rename). */
  v1: "v1",
  works: "v1/works",
  events: "v1/events.jsonl",
  index: "v1/index.json",
  importReport: "v1/import-v0.json",
  /** The import's marker, present in every published `v1/`. */
  complete: "v1/complete",
  /** An import run's own staging folder: `v1.importing-<pid>-<rand>/`. */
  stagingPrefix: "v1.importing-",
  importLock: "import.lock",
  /** The automation owner's lock (design §C.3): only its holder auto-harvests, auto-sleeps and renews leases. */
  automationLock: "automation.lock",
  /** The v0 ledger, read by the import and never changed, apart from the note below. */
  v0Works: "works",
  /**
   * The note for people: a **folder** `works/README-MOVED-TO-v1/` holding only `README.md`. A folder, not a file:
   * v0.0.6's `list()` reads `works/<entry>/work.json` for every entry, so a file there fails with ENOTDIR and breaks
   * every v0 tool after a rollback, while a folder with no `work.json` is skipped. Never put a `work.json` in it.
   */
  v0Note: "works/README-MOVED-TO-v1",
  v0NoteFile: "works/README-MOVED-TO-v1/README.md",
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

export interface WorkRecord {
  readonly format: typeof LEDGER_FORMAT
  readonly workId: string
  readonly state: "open" | "closed"
  readonly closed?: { readonly at: string; readonly how: "dropped" | "gone" | "reassigned"; readonly to?: string }
  /** Null only for an imported work whose machine was found in no region (design §6.1 step 5). */
  readonly region: Region | null
  readonly machine: MachineName
  /** Every change acts on it (design §4.1); null until a `get` answered for an imported work. */
  readonly machineId: MachineId | null
  readonly size: Size
  /** `opencode` is null for an imported v0 snapshot. */
  readonly image: { readonly name: string; readonly opencode: string | null }
  readonly laptopDirectory: string
  readonly guestDirectory: string
  readonly repo?: { readonly url: string; readonly ref?: string }
  /** The guest's git identity, never a token. */
  readonly git?: { readonly name: string; readonly email: string }
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
  readonly gitState?: GitState
  readonly files?: { readonly in: readonly MovedFile[]; readonly out: readonly MovedFile[] }
  readonly slept?: { readonly at: string; readonly by: SleptBy }
  /** Set before the create; cleared once the machine and its id are recorded. */
  readonly pendingCreate?: { readonly at: string; readonly image: string }
  /** Set by `boxd_reassign` before the rename; the next `ensure` for either id finishes it. */
  readonly pendingRename?: { readonly from: string; readonly machineId: MachineId; readonly at: string }
  readonly reboots?: ReadonlyArray<{ readonly at: string; readonly why: "agent-silent" | "repair" }>
  /** When a plugin call last touched the work: automation's `orphanHours` counts from it (§C.3). */
  readonly touchedAt?: string
  /** The `leaseDays` delete-after timer, when the option set one: renewed at most once per 6 hours (§C.2). */
  readonly lease?: { readonly days: number; readonly renewedAt: string; readonly expiresAt: string }
  readonly warnings?: readonly WorkWarning[]
  /** "v0" until a v1 helper adopted an imported work (§6.3). */
  readonly guestHelper: "v1" | "v0"
  readonly importedFrom?: "v0"
  /** An imported work whose laptop transcript may be older than the stored export (F1); its next harvest fixes it. */
  readonly laptopCopy?: "unverified"
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

/** `import-v0.json`: each v0 record's result, and the blocked ids. */
export interface ImportReport {
  readonly at: string
  readonly works: number
  readonly results: ReadonlyArray<{ readonly workId: string; readonly result: "imported" | "blocked"; readonly reason?: string }>
  readonly blocked: readonly string[]
}

/** The `complete` marker's body. */
export interface CompleteMarker {
  readonly at: string
  readonly works: number
  readonly blocked: number
  /** sha256 of the sorted list of v0 input files. */
  readonly inputDigest: string
}
