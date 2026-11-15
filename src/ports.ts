/**
 * The ports every package codes against (design §4.1, §3, §9.1): the runner that owns every child process, the boxd
 * CLI port with regions, and the guest port with the v1 helper's actions. Interfaces and constants only: the runner
 * lives in `src/exec/runner.ts`, the CLI port in `src/boxd/*` and the guest port in `src/guest/*` (package A).
 *
 * The rules these types carry, so no package re-decides them:
 *
 * - **Every child goes through the runner,** in a pool with a cap, with an explicit timeout, the call's signal and an
 *   output cap. Nothing else in the plugin spawns a process.
 * - **Acting by id.** Every change to a work's machine first resolves `oc-<id>` with `machine get` under the machine
 *   lock, refuses `NOT_OURS` unless it has the recorded `machineId`, and then acts on the id (`ChangeTarget`).
 * - **The read rule.** A read-side guest exec runs only for a machine that a listing at most
 *   `TIMEOUTS.readListingMaxAgeMs` old shows `running`, never copies a file to the guest, and never writes the ledger
 *   (`ReadTarget`). The runner enforces it, so status, job, read and the watcher share it.
 * - **Lock order.** Work locks first, in sorted work-id order (only `boxd_reassign` takes two), then machine locks,
 *   keyed by `machineId`; a slot is taken for one child at a time and given back before any wait. A slot is never held
 *   while waiting for a lock, a golden build, a poll interval or another pool.
 */

import type { Phase, SavedState } from "./ledger/types.js"

// ── Vocabulary ────────────────────────────────────────────────────────────────────────────────────────────────────

/** boxd's regions. Each has its own machine limit, snapshots and golden images. */
export const REGIONS = ["fra", "nyc"] as const
export type Region = (typeof REGIONS)[number]

/** boxd's machine sizes in its own spelling, vCPU × GiB. */
export const SIZES = ["1x4", "2x8", "4x16", "8x32"] as const
export type Size = (typeof SIZES)[number]

/** A size's vCPUs, for the one place boxd takes `--vcpu`: a stock golden builder. */
export const SIZE_VCPU: Readonly<Record<Size, number>> = { "1x4": 1, "2x8": 2, "4x16": 4, "8x32": 8 }

declare const machineIdBrand: unique symbol
/**
 * boxd's machine id (`vm_…`), from `machine new --json` or `machine get --json`. Branded, so a name can never be passed
 * where an id is required: a change acts only on an id the ledger recorded or a `get` just returned.
 */
export type MachineId = string & { readonly [machineIdBrand]: true }

/** The machine name a work owns: `oc-<workId>`. */
export type MachineName = `oc-${string}`

/** The labels the plugin sets on a work's machine; adoption needs `owner` (v1) or v0's `role` with `work`. */
export const WORK_LABELS = { role: "session", owner: "opencode-boxd" } as const
/** The label a golden builder carries; restores inherit it under the work's own `role=session`. */
export const BUILDER_LABELS = { role: "golden-builder" } as const

export type MachineStatus = "running" | "starting" | "standby" | "hibernated" | "stopped" | "destroyed" | "other"

/** One machine as `machine list --region all --json` shows it. The listing has no `id` until boxd adds it (U14). */
export interface MachineRow {
  readonly name: string
  readonly region: Region
  /** Present only once boxd's listing carries it (U14); until then a read compares nothing. */
  readonly id: MachineId | null
  readonly status: MachineStatus
  readonly size: Size | null
  readonly labels: Readonly<Record<string, string>>
  readonly sharing: "private" | "shared" | "unknown"
  /** Not in boxd's listing yet (U14); `machine get` has it. */
  readonly isolated: boolean | null
}

/** One machine as `machine get --json` shows it: always with its id. */
export interface MachineInfo extends Omit<MachineRow, "id" | "isolated"> {
  readonly id: MachineId
  readonly isolated: boolean
}

/** A listing and when it was taken. Phases may reuse one up to 10 s old; a guest read needs one at most 2 s old. */
export interface Listing {
  /** `Date.now()` when the listing's process ended. */
  readonly takenAt: number
  /** True only for a listing taken in this call with no cache: the "gone" rule and the v0 import need one. */
  readonly fresh: boolean
  readonly machines: readonly MachineRow[]
}

/** Machine-limit headroom per region, from `manage machine-limit --json`; cached for 60 s. */
export interface RegionLimit {
  readonly region: Region
  readonly limit: number
  readonly inUse: number
  readonly free: number
}

export interface SnapshotRow {
  readonly region: Region
  readonly name: string
  readonly storage: "local" | "archiving" | "archived" | "unarchiving" | "other"
  readonly status: string
}

/** A sealed variable as boxd lists it: never its value, which boxd does not return. */
export interface SecretInfo {
  readonly name: string
  /** Which machines it reaches: `private`, `shared`, `all`, or an unattached scope. */
  readonly scope: string
  /** The hosts it may be sent to; empty when it is not bound to any. */
  readonly hosts: readonly string[]
}

/** The org's rates, in its billing currency (design §C.1): active vCPU, resident RAM, written disk, per hour. */
export interface Rates {
  readonly currency: string
  readonly vcpuHour: number
  readonly ramGiBHour: number
  readonly diskGiBHour: number
  /** `usage`: from `manage usage`'s rates; `public`: boxd's published rates, for a member who cannot read usage. */
  readonly source: "usage" | "public"
}

/** Machine cost from `manage usage --json`; owners and admins only. */
export type Usage =
  | {
      readonly available: true
      readonly currency: string
      readonly total: number
      readonly estimated: boolean
      /** False until boxd marks the period complete, up to 25 minutes later. */
      readonly complete: boolean
      readonly asOf: string
      readonly rates: Rates
      readonly machines: ReadonlyArray<{ readonly machineId: MachineId; readonly cost: number }>
    }
  | { readonly available: false; readonly reason: string }

/**
 * How the stderr table (`src/boxd/errors-table.ts`) reads a failed CLI call. Only an exact pattern pinned by a fixture
 * makes `missing`; a not-found answer that names another region is `elsewhere`; anything else is `unknown`, which is
 * `BOXD_FAILED` and is never read as missing (F4). Even `missing` is a fact about one region at one moment: "gone"
 * belongs to drop's two-check rule.
 */
export type BoxdFailureKind = "missing" | "elsewhere" | "limit" | "agent-silent" | "quota" | "auth" | "size-on-restore" | "unknown"

// ── The runner ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The pools. `foreground` (tool calls) and `background` (the watcher, status guest reads) share the 12 slots, the
 * background at most 4 of them; `exec` (`boxd_exec`) and `import` (the laptop's `opencode session delete/import`) stand
 * apart with caps of their own. At most 18 children exist at once.
 */
export type Pool = "foreground" | "background" | "exec" | "import"

/** The caps: constants measured in live check L12, never options. */
export const CAPS = { shared: 12, background: 4, exec: 4, import: 2 } as const

/** A list form's active items at once; waiting items hold no item slot (design §4.2). */
export const LIST_ITEM_CONCURRENCY = 8
/** The most items a list form takes. */
export const LIST_MAX_ITEMS = 300
/** A list `ensure` above this many items defaults to `wait: "created"`. */
export const LIST_WAIT_CREATED_ABOVE = 50
/** The shared poll loop's interval for waiting items and a `ready` wait. */
export const POLL_INTERVAL_MS = 3_000
/**
 * `B`: the longest any tool call waits before it answers its real state (`creating`, `starting`) or `cancelled`
 * with `started: false`. Set from the host's measured limit less 30 s (§7.2); 4 minutes until then.
 */
export const CALL_BOUND_MS = 4 * 60_000

/** Every bound the runner applies, explicit; on a timeout the child gets SIGTERM, then SIGKILL after `killGraceMs`. */
export const TIMEOUTS = {
  cliRead: 15_000,
  helperRead: 10_000,
  helperChange: 30_000,
  setup: 30_000,
  /** `setup`'s clone runs detached on the guest with this bound of its own. */
  clone: 300_000,
  upgrade: 180_000,
  create: 60_000,
  resize: 90_000,
  reboot: 90_000,
  cp: 120_000,
  laptopImport: 120_000,
  goldenStep: 300_000,
  /** `ensure` waits this long for the guest's OpenCode by default. */
  ensureReady: 90_000,
  /** `submit` waits this long for a starting guest. */
  submitStarting: 45_000,
  /** A status guest read: `machine exec --timeout 8`, and a laptop kill at 10 s. */
  statusRead: 8_000,
  statusReadKill: 10_000,
  /** A status call's total budget for guest reads; a work that misses it keeps its cached phase, marked stale. */
  statusBudget: 20_000,
  killGraceMs: 2_000,
  /** A guest read needs a listing at most this old that shows the machine `running`. */
  readListingMaxAgeMs: 2_000,
  /** Phases may reuse a shared listing this old. */
  phaseListingMaxAgeMs: 10_000,
  /** The watcher and status skip a guest read when the cached read is younger than this. */
  cachedReadMaxAgeMs: 60_000,
  machineLimitCacheMs: 60_000,
  snapshotsCacheMs: 5 * 60_000,
} as const

/** stdout beyond this kills the child: transcripts and files go to disk with `machine cp`, never through stdout. */
export const OUTPUT_CAP_BYTES = 8 * 1024 * 1024

/**
 * The environment variable the runner sets on every child it starts, holding the call's id. The spawn-count harness's
 * fake CLI reads it to count spawns per call (`test/support/spawn-count.ts`); the real CLI ignores it.
 */
export const CALL_TAG_ENV = "OPENCODE_BOXD_CALL"

/** Which call a child belongs to: a tool call's id, or a named background job. */
export interface CallTag {
  readonly callId: string
  readonly source: `boxd_${string}` | "watcher" | "import-v0" | "status-command"
}

/** What every port operation takes: the call it belongs to, its signal, and the pool it runs in. */
export interface OpContext {
  readonly call: CallTag
  readonly signal?: AbortSignal
  /** `foreground` unless said otherwise. */
  readonly pool?: Pool
}

/** One child process. The runner adds the call tag to its environment and applies every bound. */
export interface SpawnRequest extends OpContext {
  readonly bin: string
  readonly args: readonly string[]
  readonly timeoutMs: number
  readonly stdin?: string | Uint8Array
  /** Defaults to `OUTPUT_CAP_BYTES`. */
  readonly stdoutCap?: number
}

export interface SpawnResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly ms: number
}

/** A machine lock's key: the machine id, or, for a create before boxd gave one, the region and the intended name. */
export type MachineLockKey = { readonly id: MachineId } | { readonly create: { readonly region: Region; readonly name: MachineName } }

/** What the runner reports for status's `health` row. */
export interface RunnerHealth {
  readonly children: { readonly now: number; readonly peak: number; readonly cap: number }
  readonly pools: Readonly<Record<Pool, { readonly running: number; readonly queued: number; readonly cap: number }>>
  /** The largest event-loop delay seen in the last 5 minutes while any call ran (design §4.3). */
  readonly loopLagMaxMs: number
}

export interface Runner {
  /**
   * Runs one child in its pool. A queued request honours its signal while it waits; an abort kills the child and drops
   * its queued successors. On a timeout: SIGTERM, then SIGKILL after `TIMEOUTS.killGraceMs`, and `TIMEOUT`.
   */
  spawn(request: SpawnRequest): Promise<SpawnResult>
  /**
   * Holds one machine's lock across `fn`. Taken after any work lock; never while a slot is held. Every machine change
   * and every mutating helper action runs inside one.
   */
  withMachineLock<T>(key: MachineLockKey, context: OpContext, fn: () => Promise<T>): Promise<T>
  /** One flight per key: a second caller shares the first one's answer (reads, the CLI flavour check, golden builds). */
  singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T>
  /**
   * The read rule: throws `MACHINE_ASLEEP` for a machine the listing does not show `running`, and refuses a listing
   * older than `TIMEOUTS.readListingMaxAgeMs`, so a read never wakes a hibernated machine (one 2 s race stays: U15).
   */
  assertReadable(target: ReadTarget): void
  health(): RunnerHealth
  /** Stops every pool: queued requests are dropped and running children killed. */
  dispose(): Promise<void>
}

// ── Targets ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Which helper a machine has: v1 at `GUEST_HELPER_PATH`, or only v0's at `/tmp/opencode-boxd/guest.py` (design §6.3). */
export type GuestHelper = "v1" | "v0"

/** A read's target: by name (L-g), with the listing that proves it is running. Reads take no machine lock. */
export interface ReadTarget {
  readonly region: Region
  readonly name: MachineName
  readonly listing: Listing
  /** When the listing carries ids (U14), a read compares this and answers `NOT_OURS` on a difference. */
  readonly machineId: MachineId | null
  readonly helper: GuestHelper
}

/**
 * A change's target: the name resolved to the recorded id by a `machine get` in this call, under the machine lock.
 * Only `checkOwned` makes one, so no change can act on whatever now holds the name.
 */
export interface ChangeTarget {
  readonly region: Region
  readonly name: MachineName
  readonly machineId: MachineId
  /** Proof the check ran: when the `get` answered. */
  readonly checkedAt: number
}

// ── The boxd CLI port ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A work machine's create: from its golden image, labelled, with the cost bounds of design §C.2 set in the same call
 * (F7), at every `access` level: auto-suspend off, auto-hibernate from `autoHibernateMinutes`, `idle.ignore-outbound`
 * off, and `--delete-after` only with `leaseDays`.
 */
export interface CreateWork {
  readonly kind: "work"
  readonly region: Region
  readonly name: MachineName
  readonly workId: string
  readonly image: string
  /** Always 0: standby bills resident RAM too, so it saves almost nothing (§C.1). */
  readonly autoSuspendSeconds: 0
  /** `autoHibernateMinutes` × 60; 7200 by default. */
  readonly autoHibernateSeconds: number
  /** `--delete-after <N>d`, only when the option `leaseDays` is set. */
  readonly leaseDays?: number
}

/** A golden builder's create: stock with a size, or a base snapshot resized after the restore; always `delete-after`. */
export interface CreateBuilder {
  readonly kind: "builder"
  readonly region: Region
  readonly name: `oc-gb-${string}`
  readonly size: Size
  readonly base: "stock" | { readonly snapshot: string }
  /** The safety net: `--delete-after 2h`. */
  readonly deleteAfter: string
}

export interface BoxdPort {
  /** Refuses the in-VM CLI with `BOXD_MISSING`; one flight per binary (F9). */
  assertLaptopCli(context: OpContext): Promise<void>
  /** One call for every machine in every region. `maxAgeMs: 0` takes a fresh one; concurrent readers share a flight. */
  list(options: { readonly maxAgeMs: number }, context: OpContext): Promise<Listing>
  /** `machine get <name or id> --region R --json`. A failure throws with `details.kind`, a `BoxdFailureKind`. */
  get(region: Region, nameOrId: string, context: OpContext): Promise<MachineInfo>
  /**
   * Resolves `oc-<id>` in its region to the recorded id: the check before every change (design §4.1). Throws `NOT_OURS`
   * when the name now has another id, and a classified failure when the name is not found.
   */
  checkOwned(region: Region, name: MachineName, machineId: MachineId, context: OpContext): Promise<ChangeTarget>
  create(input: CreateWork | CreateBuilder, context: OpContext): Promise<MachineInfo>
  wake(target: ChangeTarget, context: OpContext): Promise<void>
  hibernate(target: ChangeTarget, context: OpContext): Promise<void>
  remove(target: ChangeTarget, context: OpContext): Promise<void>
  resize(target: ChangeTarget, size: Size, context: OpContext): Promise<void>
  reboot(target: ChangeTarget, context: OpContext): Promise<void>
  rename(target: ChangeTarget, to: MachineName, context: OpContext): Promise<void>
  setLabels(target: ChangeTarget, labels: Readonly<Record<string, string>>, context: OpContext): Promise<void>
  /** `machine config set <id> delete-after <N>d`: a `leaseDays` renewal, at most once per 6 hours per work (§C.2). */
  renewLease(target: ChangeTarget, days: number, context: OpContext): Promise<void>
  /**
   * `machine exec` with `--timeout`, so boxd kills the remote side too. `json: false` keeps stdout and stderr apart
   * (`boxd_exec`). For a read, the target is a `ReadTarget` and the runner applies the read rule first.
   */
  exec(
    target: ReadTarget | ChangeTarget,
    command: string,
    options: { readonly timeoutSeconds: number; readonly json: boolean; readonly stdin?: string },
    context: OpContext,
  ): Promise<SpawnResult>
  /** `machine cp` to the guest: changes only (a read never uploads). */
  copyTo(target: ChangeTarget, localPath: string, guestPath: string, context: OpContext): Promise<void>
  /** `machine cp` from the guest straight to a laptop file, so the bytes never pass through the server. */
  copyFrom(target: ReadTarget | ChangeTarget, guestPath: string, localPath: string, context: OpContext): Promise<void>
  machineLimit(context: OpContext): Promise<readonly RegionLimit[]>
  usage(since: string, context: OpContext): Promise<Usage>
  /** `snapshots list --region all --json`, cached for 5 minutes. */
  snapshots(context: OpContext): Promise<readonly SnapshotRow[]>
  saveSnapshot(builder: ChangeTarget, name: string, context: OpContext): Promise<void>
  removeSnapshot(region: Region, name: string, context: OpContext): Promise<void>
  secrets(context: OpContext): Promise<readonly SecretInfo[]>
}

// ── The guest port: the v1 helper's actions ───────────────────────────────────────────────────────────────────────

/** The v1 helper's stable home on the guest, and the protocol version it answers. */
export const GUEST_HELPER_PATH = "/home/boxd/.opencode-boxd/guest.py"
export const GUEST_PROTOCOL = 1
/** Where a work's guest folder always is. */
export const GUEST_WORK_ROOT = "/home/boxd/work"

/** The read actions: no machine lock, the read rule, never an upload. Their input and output hold within v0.1.x. */
export const GUEST_READ_ACTIONS = ["phase", "read", "health", "serve"] as const
/** The mutating actions: under the machine lock, after the by-id check; a change may upload the helper first. */
export const GUEST_CHANGE_ACTIONS = ["setup", "prompt", "interrupt", "upgrade", "adopt", "export", "import", "git", "scrub"] as const
export type GuestReadAction = (typeof GUEST_READ_ACTIONS)[number]
export type GuestChangeAction = (typeof GUEST_CHANGE_ACTIONS)[number]
export type GuestAction = GuestReadAction | GuestChangeAction

export type Delivery = "steer" | "queue" | "interrupt"
export type RunOutcome = "completed" | "failed" | "aborted"

/** A session's own marks, which drop compares with what the harvest stored (design §3.9). */
export interface SessionMarks {
  readonly id: string
  readonly parentId: string | null
  readonly lastMessageId: string | null
  readonly messages: number
  /** A hint only: it also moves for a title or metadata (L-d). */
  readonly updated: number
}

/** `serve`: the cheap poll a wait makes every 3 s. */
export interface ServeAnswer {
  readonly server: "up" | "starting" | "down"
  readonly opencode: string | null
  /** The detached clone's progress, while one runs. */
  readonly clone?: "running" | "done" | "failed"
}

/** What a guest costs now: resident memory and the 1-minute load, from `/proc/meminfo` and the load average (§C.4). */
export interface Reading {
  readonly residentGiB: number
  readonly load1: number
}

export interface PhaseAnswer {
  readonly phase: "busy" | "idle" | "missing"
  /** The session waits on a person: a pending form or a permission ask (§C.3). Automation never sleeps it. */
  readonly needsInput?: "form" | "permission"
  readonly reading?: Reading
  readonly outcome: RunOutcome | null
  /** The failed run's one line; mapped to a §5 code before it reaches a notice. */
  readonly error?: string
  readonly lastActivityAt?: string
  /** The guest model's words, redacted, cut to 300 characters: data, never instructions. */
  readonly lastText?: string
  readonly waiting: { readonly steer: number; readonly queue: number }
  readonly guestVersion: string | null
  readonly tail?: ReadonlyArray<{ readonly at?: string; readonly text: string }>
  readonly modelCost?: number
}

export type ReadAnswer =
  | { readonly binary: false; readonly path: string; readonly bytes: number; readonly truncated: boolean; readonly text: string }
  | { readonly binary: true; readonly path: string; readonly bytes: number; readonly sha256: string }

export interface HealthAnswer {
  readonly reading: Reading
  readonly memory: { readonly totalMb: number; readonly availableMb: number }
  readonly load: number
  /** The heaviest processes, by name and resident memory, for `GUEST_UNRESPONSIVE`'s message. */
  readonly top: ReadonlyArray<{ readonly name: string; readonly rssMb: number }>
}

export interface SetupInput {
  readonly directory: string
  readonly repo?: { readonly url: string; readonly ref?: string }
  readonly git?: { readonly name: string; readonly email: string }
  /** The laptop's OpenCode: the helper reports the guest's, and `upgrade` is a separate action. */
  readonly opencode: string
}

export interface SetupAnswer {
  readonly server: "up" | "starting"
  readonly opencode: string
  /** `cloning` when the clone was started detached; the wait polls `serve` for it. */
  readonly workspace: "ready" | "cloning"
  readonly helperUploaded: boolean
}

export interface PromptInput {
  readonly directory: string
  readonly sessionId: string | null
  readonly title: string
  readonly text: string
  readonly delivery: Delivery
  readonly model?: string
  /** Files already copied up with `machine cp`, moved into the work tree by the same exec. */
  readonly files?: ReadonlyArray<{ readonly staged: string; readonly to: string }>
}

export interface PromptAnswer {
  readonly sessionId: string
  readonly delivery: "steer" | "queue" | "started"
  readonly interrupted: boolean
  readonly inboxId: string
  readonly waitingBefore: number
  readonly model?: string
}

/** `export`: each session of the tree written to `~/.opencode-boxd/exports/<id>.json` on the guest, and its marks. */
export interface ExportAnswer {
  readonly sessions: ReadonlyArray<SessionMarks & { readonly file: string; readonly bytes: number; readonly sha256: string }>
  readonly guestVersion: string
}

/** `git`: the tree's state, with the patch and the untracked files written on the guest, and the session marks. */
export interface GitAnswer {
  readonly known: boolean
  readonly remote: string | null
  readonly branch: string | null
  readonly sha: string | null
  readonly dirty: boolean
  readonly patch?: { readonly file: string; readonly bytes: number; readonly sha256: string }
  readonly untracked: ReadonlyArray<{ readonly path: string; readonly bytes: number; readonly sha256: string }>
  readonly ignored: ReadonlyArray<{ readonly path: string; readonly bytes: number; readonly sha256: string }>
  /** For a drop: every session under the root, with its marks (M3). */
  readonly sessions?: readonly SessionMarks[]
}

/** `scrub`: what the golden build removed, step by step (design §2.3). */
export interface ScrubAnswer {
  readonly removed: readonly string[]
  /** A refusal: the base's OpenCode database holds a session, or it has an `auth.json`. */
  readonly refused?: "has-session" | "has-credential"
}

export interface GuestPort {
  // Reads: the read rule, the helper already on the machine (v0's `phase` for a v0 guest), no upload, no ledger write.
  serve(target: ReadTarget, context: OpContext): Promise<ServeAnswer>
  phase(target: ReadTarget, input: { readonly sessionId: string; readonly tail?: number }, context: OpContext): Promise<PhaseAnswer>
  read(
    target: ReadTarget,
    input: { readonly directory: string; readonly path?: string; readonly log?: "server"; readonly tail?: number; readonly maxBytes: number },
    context: OpContext,
  ): Promise<ReadAnswer>
  health(target: ReadTarget, context: OpContext): Promise<HealthAnswer>

  // Changes: under the machine lock, after the by-id check. A change uploads the v1 helper when it is missing or older.
  setup(target: ChangeTarget, input: SetupInput, context: OpContext): Promise<SetupAnswer>
  prompt(target: ChangeTarget, input: PromptInput, context: OpContext): Promise<PromptAnswer>
  interrupt(target: ChangeTarget, input: { readonly sessionId: string }, context: OpContext): Promise<void>
  upgrade(target: ChangeTarget, input: { readonly version: string }, context: OpContext): Promise<{ readonly opencode: string }>
  /** Takes over a v0 guest: copies `/tmp/opencode-boxd/password` to the v1 home once; the running server is untouched. */
  adopt(target: ChangeTarget, context: OpContext): Promise<void>
  export(target: ChangeTarget, input: { readonly rootId: string }, context: OpContext): Promise<ExportAnswer>
  /** Imports stored exports copied up with `machine cp`, parents first (`boxd_resume`). */
  import(target: ChangeTarget, input: { readonly directory: string; readonly files: readonly string[] }, context: OpContext): Promise<{ readonly rootId: string }>
  git(target: ChangeTarget, input: { readonly directory: string; readonly rootId?: string }, context: OpContext): Promise<GitAnswer>
  /** The golden build's last step on the builder (design §2.3). */
  scrub(target: ChangeTarget, context: OpContext): Promise<ScrubAnswer>
}

/** The laptop's own OpenCode, which harvest imports into: delete, then import (F1). Runs in the import pool. */
export interface LaptopPort {
  /** `opencode session delete <id> --standalone`; exit 1 with the not-found words means absent, not a failure. */
  deleteSession(id: string, context: OpContext): Promise<"deleted" | "absent">
  importSession(file: string, directory: string, context: OpContext): Promise<{ readonly id: string }>
}

// ── The watcher's event stream (design §9.1, round 4 L-5): package D emits it, package E consumes it ───────────────

/** One phase change the watcher saw, also appended to `events.jsonl` with the same `seq`. */
export interface WorkEvent {
  readonly seq: number
  readonly at: string
  readonly workId: string
  readonly from: Phase
  readonly to: Phase
  readonly outcome?: RunOutcome | null
  /** A §5 code only (L-f). */
  readonly code?: string
  readonly needsInput?: "form" | "permission"
  readonly reading?: Reading
}

/** One open work as the watcher last saw it: what the cost estimate and automation read, with no CLI call. */
export interface WorkSnapshot {
  readonly workId: string
  readonly region: Region | null
  readonly machineId: MachineId | null
  readonly size: Size
  readonly phase: Phase
  readonly outcome: RunOutcome | null
  readonly saved: SavedState
  readonly needsInput?: "form" | "permission"
  /** The last guest reading; idle works keep theirs. */
  readonly reading?: Reading & { readonly at: string }
  /** When the work last went idle or ready, for `autoSleepMinutes`. */
  readonly idleSince?: string
  /** When a plugin call last touched the work, for `orphanHours`. */
  readonly touchedAt?: string
  /** The root coordinator session its notices go to. */
  readonly notify?: string
}

export interface FleetSnapshot {
  /** When the listing behind it was taken. */
  readonly asOf: string
  readonly works: readonly WorkSnapshot[]
}

/** The watcher's face to other packages: its events, and the fleet as it last saw it. */
export interface FleetWatch {
  /** Calls `listener` for every phase change, in `seq` order; returns the unsubscribe. */
  subscribe(listener: (event: WorkEvent) => void): () => void
  snapshot(): FleetSnapshot
}
