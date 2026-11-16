/**
 * The v0 import (design §6), the one written exception to "no migration code", removed in v0.2.0 together with the two
 * other things that know v0 and live here: the read fallback to a v0 guest's own `phase` action (§3.2, §6.3) and
 * `adopt`, which takes a running v0 guest over at its first change (§6.3).
 *
 * The import is all or nothing and crash-safe (§6.1, H1):
 *
 * 1. It takes `import.lock` (the heartbeat lock of `ledger/lock.ts`); another process that finds it live answers
 *    `LEDGER_IMPORTING`.
 * 2. It deletes every staging folder no live run owns, and builds in its own `v1.importing-<pid>-<rand>/`.
 * 3. One fresh `machine list --region all`; a failure aborts with no `v1/` (`IMPORT_V0_FAILED`, retried after 30 s).
 * 4. One `machine get` per machine found records `machineId`; a failed `get` leaves it null.
 * 5. Each record is mapped (§6.2) with its exports, patch and untracked files **copied, never linked**.
 * 6. A record that cannot be read or mapped is reported, and its id is blocked; its v0 files stay as they are.
 * 7. `complete` is written, the lock's token checked, and the staging folder renamed to `v1/` in one step.
 * 8. `works/README-MOVED-TO-v1` is added beside the v0 records: the only change to the v0 tree.
 *
 * Until step 7 has finished every tool answers `LEDGER_IMPORTING`. A blocked id is imported again, into the published
 * `v1/`, at the next start after its v0 file is fixed or removed.
 */
import { createHash, randomBytes } from "node:crypto"
import { readdir, readFile, rename, stat, writeFile, mkdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { boxdError, BoxdError, WARNINGS, type WarningCode } from "./errors.js"
import { copyFileAtomic, digestFile, ensureDir, errnoOf, exists, fsyncDir, remove, writeFileAtomic, writeJsonAtomic } from "./ledger/fsx.js"
import { LockSet, readNote } from "./ledger/lock.js"
import { readMarks } from "./ledger/marks.js"
import { Ledger, WORK_ID, withoutUserinfo, type LedgerOptions } from "./ledger/store.js"
import {
  LEDGER_FORMAT,
  LEDGER_PATHS,
  WORK_FILES,
  type CompleteMarker,
  type GitState,
  type ImportReport,
  type MovedFile,
  type SavedSession,
  type WorkRecord,
} from "./ledger/types.js"
import {
  GUEST_HELPER_PATH,
  type BoxdPort,
  type ChangeTarget,
  type Expected,
  type LedgerFile,
  type ImportState,
  type ImportV0Port,
  type Listing,
  type MachineId,
  type MachineName,
  type MachineRow,
  type OpContext,
  type PhaseAnswer,
  type ReadTarget,
  type Region,
  type RunOutcome,
  type Size,
} from "./ports.js"
import { excerpt, shortReason } from "./redact.js"
import type { HostServices, Runtime } from "./services.js"

/** What the import needs from the boxd port: one fresh all-region listing, and `get` for each machine's id. */
export type ImportBoxd = Pick<BoxdPort, "list" | "get">

/** The points a run passes, in order; tests stop a child process at each one. */
export type ImportStep = "locked" | "staging" | "listed" | "ids" | "record" | "report" | "marker" | "publish" | "published" | "note"

export interface ImportOptions {
  /** `~/.local/share/opencode-boxd`. */
  readonly root: string
  readonly boxd: ImportBoxd
  readonly now?: () => Date
  /** How long after a failed listing the next call tries again; 30 s. */
  readonly retryMs?: number
  /** The `machine get` calls at once; the runner's own caps apply beneath. */
  readonly getConcurrency?: number
  readonly lock?: { readonly staleMs?: number; readonly heartbeatMs?: number }
  /** The owner of the import lock: its disposal stops a run at its next step and releases the lock. */
  readonly locks?: LockSet
  readonly ledger?: LedgerOptions
  /** Called at each step; `record` once per record written. Tests use it to stop a run at an exact point. */
  readonly onStep?: (step: ImportStep, progress: Progress) => void | Promise<void>
}

export interface Progress {
  readonly done: number
  readonly total: number
}

/** The gate's own view; `createImportV0` answers the port's `ImportState` from it. */
export type GateState =
  | { readonly state: "idle" }
  | { readonly state: "importing"; readonly progress: Progress }
  | { readonly state: "failed"; readonly reason: string; readonly retryAt: number }
  | { readonly state: "ready"; readonly works: number; readonly errors: number; readonly blocked: readonly string[] }

const NOTE_FILE = "README.md"
const NOTE_TEXT = `# Moved to the v1 ledger

opencode-boxd v0.1.0 imported these works into ../v1/ and reads only that ledger now. The files here were not changed.

Going back to opencode-boxd v0.0.x is safe only before v0.1.0 made its first change (a submit, harvest, drop or
reassign). After that, these records still carry their old proof, and v0's drop could accept a proof that a later
prompt made stale, and destroy work that was never harvested.
`

const context = (): OpContext => ({ call: { callId: `import-v0-${randomBytes(4).toString("hex")}`, source: "import-v0" }, pool: "foreground" })

// ── The gate every tool goes through ──────────────────────────────────────────────────────────────────────────────

/**
 * The ledger's front door while a v0 import may be pending. `ledger()` answers the published ledger, or throws
 * `LEDGER_IMPORTING` (with `progress`) while an import runs here or in another process, or `IMPORT_V0_FAILED` while
 * the last listing failed and its 30 s have not passed. Nothing reads a partial ledger.
 */
export class LedgerGate {
  private readonly options: ImportOptions
  private current: GateState = { state: "idle" }
  private running: Promise<GateState> | undefined
  private published: Ledger | undefined
  private blocked = new Set<string>()
  private readonly locks = new LockSet()

  constructor(options: ImportOptions) {
    this.options = options
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))()
  }

  state(): GateState {
    return this.current
  }

  /** Starts the import when no complete `v1/` exists, or reruns blocked ids into one that does; joins a running one. */
  start(): Promise<GateState> {
    if (this.locks.disposed) return Promise.resolve(this.current)
    // After a failure the next try waits its pause: no listing of every region on every call.
    if (this.current.state === "failed" && this.now().getTime() < this.current.retryAt) return Promise.resolve(this.current)
    if (!this.running) {
      this.running = this.locks.track(
        this.attempt().finally(() => {
          this.running = undefined
        }),
      )
    }
    return this.running
  }

  /**
   * On plugin disposal or reload: a running import stops at its next step (its staging folder is discarded by the next
   * run), the import lock's heartbeat stops and the lock is released, and so are the work locks of a blocked-id rerun.
   */
  async dispose(graceMs?: number): Promise<void> {
    await this.locks.dispose(graceMs)
    await this.published?.dispose(graceMs)
  }

  /** The published ledger for a tool call; never a partial one. */
  async ledger(): Promise<Ledger> {
    if (this.published) return this.published
    if (await exists(join(this.options.root, LEDGER_PATHS.complete))) {
      await this.adoptPublished()
      return this.published!
    }
    const now = this.now().getTime()
    if (this.current.state === "failed" && now < this.current.retryAt) {
      throw boxdError("IMPORT_V0_FAILED", `The v0 import could not list the machines: ${this.current.reason}. It tries again from ${new Date(this.current.retryAt).toISOString()}.`)
    }
    void this.start()
    throw boxdError("LEDGER_IMPORTING", undefined, { progress: await this.progress() })
  }

  /** `IMPORT_V0_FAILED` for a work id whose v0 record could not be imported: `ensure` never opens a fresh record over it. */
  assertNotBlocked(workId: string): void {
    if (this.blocked.has(workId)) {
      throw boxdError("IMPORT_V0_FAILED", `Work "${workId}"'s v0 record could not be imported, so this id is blocked; its v0 file is untouched (see import-v0.json).`, { workId })
    }
  }

  private async progress(): Promise<Progress> {
    if (this.current.state === "importing") return this.current.progress
    return (await readNote<Progress>(join(this.options.root, LEDGER_PATHS.importLock), "progress")) ?? { done: 0, total: 0 }
  }

  private async adoptPublished(): Promise<void> {
    const report = await readReport(this.options.root)
    this.blocked = new Set(report?.blocked ?? [])
    this.published ??= new Ledger(this.options.root, this.options.ledger)
    this.current = { state: "ready", works: report?.works ?? 0, errors: report?.blocked.length ?? 0, blocked: [...this.blocked] }
  }

  private async attempt(): Promise<GateState> {
    const root = this.options.root
    // A ledger published by this attempt has just tried every record; blocked ids are tried again at a later start.
    const publishedBefore = await exists(join(root, LEDGER_PATHS.complete))
    if (!publishedBefore) {
      let outcome: RunOutcome0
      try {
        outcome = await runImport({
          ...this.options,
          locks: this.locks,
          onProgress: (progress) => {
            this.current = { state: "importing", progress }
          },
        })
      } catch (error) {
        // A stop at disposal is not a failure; any other error is, with its reason and the same pause as a listing's.
        if (this.locks.disposed) throw error
        outcome = { state: "failed", reason: reasonText(error) }
      }
      if (outcome.state === "failed") {
        this.current = { state: "failed", reason: outcome.reason, retryAt: this.now().getTime() + (this.options.retryMs ?? 30_000) }
        return this.current
      }
      // Another process holds the import lock: its progress note says how far it is.
      if (outcome.state === "busy") {
        this.current = { state: "importing", progress: await this.progress() }
        return this.current
      }
    }
    await this.adoptPublished()
    await writeNoteOnce(root)
    if (publishedBefore && this.blocked.size) {
      try {
        await rerunBlocked({ ...this.options, locks: this.locks }, this.published!)
      } catch (error) {
        // The published ledger stays usable; the blocked ids stay blocked until a later start.
        if (this.locks.disposed) throw error
      }
      await this.adoptPublished()
    }
    return this.current
  }
}

// ── One import run ────────────────────────────────────────────────────────────────────────────────────────────────

export type RunOutcome0 = { readonly state: "published" | "present" | "busy" } | { readonly state: "failed"; readonly reason: string }

/** One full run: steps 1–8 of §6.1. Exported for the crash tests, which run it in a child process. */
export async function runImport(options: ImportOptions & { readonly onProgress?: (progress: Progress) => void }): Promise<RunOutcome0> {
  const { root } = options
  const locks = options.locks ?? new LockSet()
  const step = async (name: ImportStep, progress: Progress) => {
    options.onProgress?.(progress)
    await options.onStep?.(name, progress)
    // A disposed plugin stops here; the next run discards the staging folder and starts over.
    if (locks.disposed) throw locks.signal.reason
  }
  await ensureDir(root)
  const lock = await locks.acquire(join(root, LEDGER_PATHS.importLock), { purpose: "import-v0", waitMs: 0, ...options.lock })
  if (!lock) return { state: "busy" }
  let staging: string | undefined
  try {
    if (await exists(join(root, LEDGER_PATHS.complete))) return { state: "present" }
    await step("locked", { done: 0, total: 0 })

    // 2. Start clean: every staging folder here belongs to a run that no longer holds the lock.
    for (const name of await readdir(root)) if (name.startsWith(LEDGER_PATHS.stagingPrefix)) await remove(join(root, name))
    staging = join(root, `${LEDGER_PATHS.stagingPrefix}${process.pid}-${randomBytes(4).toString("hex")}`)
    await mkdir(staging, { mode: 0o700 })
    await ensureDir(join(staging, "works"))
    const inputs = await readInputs(root)
    const total = inputs.folders.length
    await step("staging", { done: 0, total })

    // 3. Every machine, fresh. With no v0 record there is nothing to locate.
    let listing: Listing | undefined
    if (total) {
      try {
        listing = await options.boxd.list({ maxAgeMs: 0 }, context())
        if (!listing.fresh) throw new Error("the listing was not fresh")
      } catch (error) {
        return { state: "failed", reason: reasonText(error) }
      }
    }
    await step("listed", { done: 0, total })

    // 4. Machine ids.
    const ids = await readIds(options, inputs.folders, listing)
    await step("ids", { done: 0, total })

    // 5–6. Records.
    const results: Array<ImportReport["results"][number]> = []
    let done = 0
    for (const folder of inputs.folders) {
      const mapped = await mapRecord(root, folder, listing, ids)
      if (mapped.ok) {
        // A record whose files cannot be copied blocks only its own id, like one that cannot be read (§6.1 step 6).
        const target = join(staging, "works", folder)
        try {
          await writeWork(target, mapped)
          results.push({ workId: folder, result: "imported" })
        } catch (error) {
          if (locks.disposed) throw error
          await remove(target)
          results.push({ workId: folder, result: "blocked", reason: `its files could not be copied: ${reasonText(error)}` })
        }
      } else {
        results.push({ workId: folder, result: "blocked", reason: mapped.reason })
      }
      done += 1
      await lock.note("progress", { done, total })
      await step("record", { done, total })
    }
    const now = (options.now ?? (() => new Date()))().toISOString()
    const blocked = results.filter((item) => item.result === "blocked").map((item) => item.workId)
    const report: ImportReport = { at: now, works: results.length - blocked.length, results, blocked }
    await writeJsonAtomic(join(staging, "import-v0.json"), report)
    await step("report", { done, total })

    // 7. The marker, the token check, and one rename.
    const marker: CompleteMarker = { at: now, works: report.works, blocked: blocked.length, inputDigest: inputs.digest }
    await writeJsonAtomic(join(staging, "complete"), marker)
    await fsyncDir(staging)
    await step("marker", { done, total })
    if (!(await lock.holds())) return { state: "busy" }
    await step("publish", { done, total })
    try {
      await rename(staging, join(root, LEDGER_PATHS.v1))
    } catch (error) {
      // Another run published first. A v1/ without its marker is never adopted: that is a failure, not a ledger.
      if (["EEXIST", "ENOTEMPTY"].includes(errnoOf(error) ?? "")) {
        if (await exists(join(root, LEDGER_PATHS.complete))) return { state: "present" }
        throw boxdError("LEDGER_FAILED", "A v1/ folder without its complete marker is in the way of the import; move it aside and restart OpenCode.")
      }
      throw error
    }
    staging = undefined
    await fsyncDir(root)
    await step("published", { done, total })
  } catch (error) {
    if (error instanceof BoxdError) throw error
    throw boxdError("LEDGER_FAILED", `The v0 import could not build the v1 ledger (${reasonText(error)}).`)
  } finally {
    if (staging) await remove(staging)
    await lock.release()
  }
  // 8. The note for people.
  await writeNoteOnce(root)
  await options.onStep?.("note", { done: 0, total: 0 })
  return { state: "published" }
}

/**
 * Imports blocked ids again into the published `v1/`, at a start after their v0 files were fixed or removed (§6.1 step
 * 6). It takes the import lock and then each work's lock, writes copy-on-write, and unblocks an id last.
 */
async function rerunBlocked(options: ImportOptions, ledger: Ledger): Promise<void> {
  const root = options.root
  const locks = options.locks ?? new LockSet()
  const lock = await locks.acquire(join(root, LEDGER_PATHS.importLock), { purpose: "import-v0 blocked ids", waitMs: 0, ...options.lock })
  if (!lock) return
  try {
    let report = await readReport(root)
    if (!report?.blocked.length) return
    let listing: Listing | undefined
    for (const workId of report.blocked) {
      if (locks.disposed) return
      const folder = join(root, LEDGER_PATHS.v0Works, workId)
      // An unreadable folder counts as present: mapping it fails again, and the id stays blocked with the reason.
      const present = WORK_ID.test(workId) && (await exists(join(folder, "work.json")).catch(() => true))
      // A v0 record removed since frees its id; a fixed one is imported; one that still fails stays blocked.
      let result: ImportReport["results"][number] = { workId, result: "blocked", reason: "its v0 record was removed, so the id is free" }
      let unblock = !present
      if (present) {
        if (!listing) {
          try {
            listing = await options.boxd.list({ maxAgeMs: 0 }, context())
          } catch {
            return
          }
        }
        const mapped = await mapRecord(root, workId, listing, await readIds(options, [workId], listing))
        if (!mapped.ok) {
          result = { workId, result: "blocked", reason: mapped.reason }
        } else {
          if (!(await lock.holds())) return
          try {
            await writeWorkInto(ledger, workId, mapped)
            result = { workId, result: "imported" }
            unblock = true
          } catch (error) {
            if (locks.disposed) throw error
            result = { workId, result: "blocked", reason: `its files could not be copied: ${reasonText(error)}` }
            await ledger.withWork(workId, async () => {
              if (!(await exists(ledger.recordPath(workId)))) await remove(ledger.workDir(workId))
            })
          }
        }
      }
      const previous = report.results.find((item) => item.workId === workId)
      if (!unblock && JSON.stringify(previous) === JSON.stringify(result)) continue
      report = {
        ...report,
        at: (options.now ?? (() => new Date()))().toISOString(),
        works: report.works + (result.result === "imported" ? 1 : 0),
        results: report.results.map((item) => (item.workId === workId ? result : item)),
        // Unblocked last, after the record and its files are in place.
        blocked: unblock ? report.blocked.filter((id) => id !== workId) : report.blocked,
      }
      await writeJsonAtomic(join(root, LEDGER_PATHS.importReport), report)
    }
  } finally {
    await lock.release()
  }
}

// ── Inputs ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Inputs {
  /** Folders under `works/` that hold a `work.json`, sorted; the note is not one. */
  readonly folders: readonly string[]
  /** sha256 of the sorted list of v0 input files. */
  readonly digest: string
}

async function readInputs(root: string): Promise<Inputs> {
  const works = join(root, LEDGER_PATHS.v0Works)
  let names: string[]
  try {
    names = await readdir(works)
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return { folders: [], digest: createHash("sha256").update("").digest("hex") }
    throw error
  }
  const folders: string[] = []
  const files: string[] = []
  for (const name of names.sort()) {
    if (name === noteName()) continue
    const folder = join(works, name)
    try {
      if (!(await stat(folder)).isDirectory()) continue
      if (!(await exists(join(folder, "work.json")))) continue
      const inside: string[] = []
      for await (const file of walk(folder)) inside.push(relative(works, file))
      folders.push(name)
      files.push(...inside)
    } catch {
      // A folder that cannot be read is still a record to report: mapping it fails, so it blocks only its own id.
      folders.push(name)
      files.push(`${name}/`)
    }
  }
  return { folders, digest: createHash("sha256").update(files.sort().join("\n")).digest("hex") }
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile()) yield path
  }
}

const noteName = () => LEDGER_PATHS.v0Note.split("/").pop()!

/** The listing row for a v0 machine name: one region, or the one labelled `work=<id>` when two regions hold the name. */
function rowFor(listing: Listing | undefined, machine: string, workId: string): MachineRow | undefined {
  const rows = listing?.machines.filter((row) => row.name === machine) ?? []
  if (rows.length <= 1) return rows[0]
  const labelled = rows.filter((row) => row.labels.work === workId)
  return labelled.length === 1 ? labelled[0] : undefined
}

/** `machine get` for each v0 machine the listing shows, under a small cap; a failed `get` is a null id. */
async function readIds(options: ImportOptions, folders: readonly string[], listing: Listing | undefined): Promise<Map<string, MachineId | null>> {
  const ids = new Map<string, MachineId | null>()
  const wanted: Array<{ workId: string; region: Region; name: string }> = []
  for (const workId of folders) {
    const machine = await readMachineName(options.root, workId)
    const row = machine ? rowFor(listing, machine, workId) : undefined
    if (row && machine) wanted.push({ workId, region: row.region, name: machine })
  }
  let next = 0
  const worker = async () => {
    while (next < wanted.length) {
      const item = wanted[next++]!
      try {
        const info = await options.boxd.get(item.region, item.name, context())
        ids.set(item.workId, info.name === item.name ? info.id : null)
      } catch {
        ids.set(item.workId, null)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.getConcurrency ?? 12, wanted.length)) }, worker))
  return ids
}

async function readMachineName(root: string, workId: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(root, LEDGER_PATHS.v0Works, workId, "work.json"), "utf8")) as { machine?: unknown }
    return typeof parsed.machine === "string" ? parsed.machine : undefined
  } catch {
    return undefined
  }
}

// ── Mapping one record (§6.2) ─────────────────────────────────────────────────────────────────────────────────────

interface Mapped {
  readonly ok: true
  readonly record: WorkRecord
  /** v0 file → path relative to the work's v1 folder, copied. */
  readonly copies: ReadonlyArray<{ readonly from: string; readonly to: string }>
  /** Untracked files unpacked from v0's base64 `untracked.json`. */
  readonly untracked: ReadonlyArray<{ readonly path: string; readonly body: Buffer }>
}

type MapResult = Mapped | { readonly ok: false; readonly reason: string }

class Unmappable extends Error {}
const fail = (reason: string): never => {
  throw new Unmappable(reason)
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const str = (value: unknown, field: string): string => (typeof value === "string" ? value : fail(`${field} is not a string`))
const optStr = (value: unknown, field: string): string | undefined => (value === undefined ? undefined : str(value, field))
const iso = (value: string, field: string): string => (Number.isNaN(Date.parse(value)) ? fail(`${field} is not a date`) : value)
const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,80}$/
const OUTCOMES: readonly RunOutcome[] = ["completed", "failed", "aborted"]
const VCPU_SIZE: Readonly<Record<number, Size>> = { 1: "1x4", 2: "2x8", 4: "4x16", 8: "8x32" }

async function mapRecord(root: string, workId: string, listing: Listing | undefined, ids: ReadonlyMap<string, MachineId | null>): Promise<MapResult> {
  const folder = join(root, LEDGER_PATHS.v0Works, workId)
  try {
    if (!WORK_ID.test(workId)) fail("the folder name is not a work id")
    const file = join(folder, "work.json")
    let v0: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
      v0 = isObject(parsed) ? parsed : fail("work.json is not an object")
    } catch (error) {
      if (error instanceof Unmappable) throw error
      return { ok: false, reason: `work.json cannot be read: ${reasonText(error)}` }
    }
    const fileTime = new Date((await stat(file)).mtimeMs).toISOString()
    if (str(v0.workId, "workId") !== workId) fail("workId differs from its folder")
    const machine = str(v0.machine, "machine")
    if (!machine.startsWith("oc-")) fail("machine is not an oc- name")
    const snapshot = str(v0.snapshot, "snapshot")
    const laptopDirectory = str(v0.laptopDirectory, "laptopDirectory")
    const guestDirectory = str(v0.guestDirectory, "guestDirectory")
    const repo = optStr(v0.repo, "repo")
    const model = optStr(v0.model, "model")
    const vcpu = v0.vcpu === undefined ? undefined : (VCPU_SIZE[v0.vcpu as number] ?? fail("vcpu is not 1, 2, 4 or 8"))
    const rootSessionId = optStr(v0.rootSessionId, "rootSessionId")
    if (rootSessionId !== undefined && !SESSION_ID.test(rootSessionId)) fail("rootSessionId is not a session id")
    const lastSubmitAt = v0.lastSubmitAt === undefined ? undefined : iso(str(v0.lastSubmitAt, "lastSubmitAt"), "lastSubmitAt")
    const sleptAt = v0.sleptAt === undefined ? undefined : iso(str(v0.sleptAt, "sleptAt"), "sleptAt")
    if (v0.dropped !== undefined && typeof v0.dropped !== "boolean") fail("dropped is not a boolean")

    const row = rowFor(listing, machine, workId)
    const region = row?.region ?? null
    const machineId = ids.get(workId) ?? null
    const size: Size = vcpu ?? row?.size ?? "2x8"

    // Exports: every stored transcript is copied; the proven ones also give `saved` their marks.
    const exportsDir = join(folder, "exports")
    const exportNames = (await readdir(exportsDir).catch((error: unknown) => (errnoOf(error) === "ENOENT" ? [] : Promise.reject(error)))).filter((name) =>
      /^ses_[A-Za-z0-9_-]{1,80}\.json$/.test(name),
    )
    const copies = exportNames.sort().map((name) => ({ from: join(exportsDir, name), to: join(WORK_FILES.exports, name) }))

    let saved: WorkRecord["saved"]
    if (v0.proof !== undefined) {
      const proof = isObject(v0.proof) ? v0.proof : fail("proof is not an object")
      const at = iso(str(proof.harvestedAt, "proof.harvestedAt"), "proof.harvestedAt")
      const guestVersion = str(proof.guestVersion, "proof.guestVersion")
      if (!Array.isArray(proof.sessions)) fail("proof.sessions is not a list")
      const sessions: SavedSession[] = []
      for (const [index, item] of (proof.sessions as unknown[]).entries()) {
        const entry = isObject(item) ? item : fail(`proof.sessions[${index}] is not an object`)
        const id = str(entry.remoteId, `proof.sessions[${index}].remoteId`)
        if (!SESSION_ID.test(id)) fail(`proof.sessions[${index}].remoteId is not a session id`)
        const importedId = str(entry.importedId, `proof.sessions[${index}].importedId`)
        const parentId = optStr(entry.parentRemoteId, `proof.sessions[${index}].parentRemoteId`) ?? null
        const path = join(exportsDir, `${id}.json`)
        if (!(await exists(path))) fail(`the stored export of ${id} is missing`)
        const digest = await digestFile(path)
        let marks
        try {
          marks = await readMarks(path)
        } catch {
          fail(`the stored export of ${id} is not an OpenCode export`)
        }
        if (marks!.id !== id) fail(`the stored export of ${id} holds session ${marks!.id}`)
        sessions.push({
          id,
          parentId,
          sha256: digest.sha256,
          bytes: digest.bytes,
          lastMessageId: marks!.lastMessageId,
          messages: marks!.messages,
          updated: marks!.updated,
          ...(importedId !== id ? { laptopId: importedId } : {}),
        })
      }
      saved = { at, complete: true, guestVersion, sessions }
    }

    let run: WorkRecord["run"]
    if (v0.lastOutcome !== undefined) {
      const outcome = isObject(v0.lastOutcome) ? v0.lastOutcome : fail("lastOutcome is not an object")
      const state = str(outcome.state, "lastOutcome.state") as RunOutcome
      if (!OUTCOMES.includes(state)) fail("lastOutcome.state is not completed, failed or aborted")
      const error = optStr(outcome.error, "lastOutcome.error")
      run = { outcome: state, ...(error !== undefined ? { error } : {}), at: iso(str(outcome.at, "lastOutcome.at"), "lastOutcome.at") }
    }

    let gitState: GitState | undefined
    if (v0.git !== undefined) {
      const git = isObject(v0.git) ? v0.git : fail("git is not an object")
      const list = (value: unknown, field: string) => (Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : fail(`${field} is not a list of paths`))
      const nullable = (value: unknown, field: string) => (value === null ? null : str(value, field))
      const bool = (value: unknown, field: string) => (typeof value === "boolean" ? value : fail(`${field} is not a boolean`))
      const remote = nullable(git.remote, "git.remote")
      gitState = {
        known: bool(git.known, "git.known"),
        remote: remote === null ? null : withoutUserinfo(remote),
        branch: nullable(git.branch, "git.branch"),
        sha: nullable(git.sha, "git.sha"),
        dirty: bool(git.dirty, "git.dirty"),
        patchStored: bool(git.patchStored, "git.patchStored"),
        untracked: list(git.untracked, "git.untracked"),
        ignored: list(git.ignored, "git.ignored"),
        untrackedStored: bool(git.untrackedStored, "git.untrackedStored"),
      }
    }

    if (await exists(join(folder, "patch.diff"))) copies.push({ from: join(folder, "patch.diff"), to: WORK_FILES.patch })
    const untracked = await readUntracked(join(folder, "untracked.json"))

    const moved = (value: unknown, field: string): MovedFile[] => {
      if (value === undefined) return []
      if (!Array.isArray(value)) fail(`${field} is not a list`)
      return (value as unknown[]).map((item, index) => {
        const entry = isObject(item) ? item : fail(`${field}[${index}] is not an object`)
        const bytes = typeof entry.bytes === "number" ? entry.bytes : fail(`${field}[${index}].bytes is not a number`)
        const laptopPath = optStr(entry.laptopPath, `${field}[${index}].laptopPath`)
        return {
          path: str(entry.path, `${field}[${index}].path`),
          bytes,
          sha256: str(entry.sha256, `${field}[${index}].sha256`),
          at: iso(str(entry.at, `${field}[${index}].at`), `${field}[${index}].at`),
          ...(laptopPath !== undefined ? { laptopPath } : {}),
        }
      })
    }
    const filesIn = moved(v0.uploads, "uploads")
    const filesOut = moved(v0.downloads, "downloads")

    const warnings = v0.warnings === undefined ? [] : Array.isArray(v0.warnings) ? (v0.warnings as unknown[]) : fail("warnings is not a list")
    const carried = warnings.map((item, index) => {
      const entry = isObject(item) ? item : fail(`warnings[${index}] is not an object`)
      const code = str(entry.code, `warnings[${index}].code`)
      if (!Object.hasOwn(WARNINGS, code)) fail(`warnings[${index}].code ${code} is not a warning`)
      return { code: code as WarningCode, at: iso(str(entry.at, `warnings[${index}].at`), `warnings[${index}].at`) }
    })

    let pendingCreate: WorkRecord["pendingCreate"]
    if (v0.pendingCreate !== undefined) {
      const pending = isObject(v0.pendingCreate) ? v0.pendingCreate : fail("pendingCreate is not an object")
      pendingCreate = { at: iso(str(pending.at, "pendingCreate.at"), "pendingCreate.at"), image: str(pending.snapshot, "pendingCreate.snapshot") }
    }

    // v0 kept no creation time: the earliest moment the record names, or its file's own time.
    const times = [pendingCreate?.at, lastSubmitAt, saved?.at, sleptAt, run?.at, ...filesIn.map((item) => item.at), ...filesOut.map((item) => item.at), fileTime].filter(
      (value): value is string => value !== undefined,
    )
    const createdAt = new Date(Math.min(...times.map((value) => Date.parse(value)))).toISOString()
    const closed = v0.dropped === true

    const record: WorkRecord = {
      format: LEDGER_FORMAT,
      workId,
      state: closed ? "closed" : "open",
      ...(closed ? { closed: { at: fileTime, how: "dropped" as const } } : {}),
      region,
      machine: machine as MachineName,
      machineId,
      size,
      image: { name: snapshot, opencode: null },
      laptopDirectory,
      guestDirectory,
      ...(repo !== undefined ? { repo: { url: withoutUserinfo(repo) } } : {}),
      ...(model !== undefined ? { model } : {}),
      createdAt,
      ...(rootSessionId !== undefined ? { session: { rootId: rootSessionId } } : {}),
      ...(lastSubmitAt !== undefined ? { lastSubmit: { at: lastSubmitAt, delivery: "steer" as const } } : {}),
      ...(saved ? { saved } : {}),
      ...(run ? { run } : {}),
      ...(gitState ? { gitState } : {}),
      ...(filesIn.length || filesOut.length ? { files: { in: filesIn, out: filesOut } } : {}),
      ...(sleptAt !== undefined ? { slept: { at: sleptAt, by: "boxd_sleep" as const } } : {}),
      ...(pendingCreate ? { pendingCreate } : {}),
      ...(carried.length ? { warnings: carried } : {}),
      guestHelper: "v0",
      importedFrom: "v0",
      ...(saved?.sessions.length ? { laptopCopy: "unverified" as const } : {}),
    }
    return { ok: true, record, copies, untracked }
  } catch (error) {
    if (error instanceof Unmappable) return { ok: false, reason: error.message }
    return { ok: false, reason: reasonText(error) }
  }
}

/** v0's `untracked.json`: a map of work-tree path to base64 content. Each path must stay inside the work tree. */
async function readUntracked(path: string): Promise<Array<{ path: string; body: Buffer }>> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return []
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return fail("untracked.json is not JSON")
  }
  if (!isObject(parsed)) fail("untracked.json is not a map of paths")
  return Object.entries(parsed as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, body]) => {
      if (!file || file.startsWith("/") || file.includes("\\") || file.includes("\0") || /(^|\/)\.\.?(\/|$)/.test(file) || file.endsWith("/")) {
        fail(`untracked.json names a path outside the work tree`)
      }
      if (typeof body !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(body)) fail(`untracked.json holds a body that is not base64`)
      return { path: file, body: Buffer.from(body as string, "base64") }
    })
}

/** Writes a mapped work into a fresh staging folder: files first, the record last, every file atomic. */
async function writeWork(dir: string, mapped: Mapped): Promise<void> {
  await ensureDir(dir)
  for (const copy of mapped.copies) await copyFileAtomic(copy.from, join(dir, copy.to))
  for (const file of mapped.untracked) await writeFileAtomic(join(dir, WORK_FILES.untracked, file.path), file.body)
  await writeJsonAtomic(join(dir, WORK_FILES.record), mapped.record)
}

/**
 * The blocked-id rerun: into the published ledger, under the work's lock, every file copy-on-write and fenced on that
 * lock, the untracked set verified and swapped in whole, and the record last.
 */
async function writeWorkInto(ledger: Ledger, workId: string, mapped: Mapped): Promise<void> {
  await ledger.withWork(workId, async () => {
    await ledger.sweepTemps(workId)
    await ledger.recoverUntracked(workId)
    for (const copy of mapped.copies) await ledger.copyIn(workId, copy.from, copy.to as LedgerFile)
    if (mapped.untracked.length) {
      const staged = await ledger.stageFolder(workId)
      const expected: Record<string, Expected> = {}
      try {
        for (const file of mapped.untracked) {
          await writeFileAtomic(join(staged.path, file.path), file.body)
          expected[file.path] = { bytes: file.body.byteLength, sha256: createHash("sha256").update(file.body).digest("hex") }
        }
      } catch (error) {
        await ledger.discard(staged)
        throw error
      }
      await ledger.commitFolder(staged, expected)
    }
    await ledger.put(mapped.record)
  })
}

// ── The report and the note ───────────────────────────────────────────────────────────────────────────────────────

export async function readReport(root: string): Promise<ImportReport | null> {
  try {
    const parsed = JSON.parse(await readFile(join(root, LEDGER_PATHS.importReport), "utf8")) as ImportReport
    return Array.isArray(parsed.blocked) && Array.isArray(parsed.results) ? parsed : null
  } catch {
    return null
  }
}

/**
 * `works/README-MOVED-TO-v1`, beside the v0 records: the only change to the v0 tree. It is a folder holding a README,
 * not a bare file, because v0's own ledger reads `works/<name>/work.json` for every entry, and a file there would make
 * every v0.0.x release fail on that read (ENOTDIR), so going back to v0.0.6 would break. A folder without `work.json`
 * is skipped by every v0 release.
 */
async function writeNoteOnce(root: string): Promise<void> {
  const works = join(root, LEDGER_PATHS.v0Works)
  if (!(await exists(works))) return
  const note = join(root, LEDGER_PATHS.v0Note)
  if (await exists(join(note, NOTE_FILE))) return
  await mkdir(note, { recursive: true, mode: 0o700 })
  await writeFile(join(note, NOTE_FILE), NOTE_TEXT, { mode: 0o600, flag: "wx" }).catch((error: unknown) => {
    if (errnoOf(error) !== "EEXIST") throw error
  })
}

const reasonText = (error: unknown) => shortReason(error instanceof Error ? error.message : String(error)) ?? "no reason given"

// ── The v0 guest: the read fallback and `adopt` (§3.2, §6.3) ──────────────────────────────────────────────────────

/** Where every v0 release kept its helper on the guest. A reboot clears it with the rest of `/tmp`. */
export const V0_HELPER_PATH = "/tmp/opencode-boxd/guest.py"

const V0_OUTCOMES: Readonly<Record<string, RunOutcome>> = { succeeded: "completed", failed: "failed", interrupted: "aborted" }
const LAST_TEXT_LIMIT = 300

/**
 * A read of an imported work whose guest has only the v0 helper: v0's own `phase` action, read-only (§3.2, M2). The
 * runner's read rule applies to the target; nothing is copied to the machine and the ledger is not written. A machine
 * whose `/tmp` a reboot cleared answers `GUEST_FAILED`, whose next step is `boxd_ensure`, a change that may upload.
 */
export async function v0Phase(boxd: Pick<BoxdPort, "exec">, target: ReadTarget, input: { readonly sessionId: string; readonly tail?: number }, opContext: OpContext): Promise<PhaseAnswer> {
  if (!SESSION_ID.test(input.sessionId)) throw boxdError("NAME_INVALID", `Session id "${input.sessionId}" is not an OpenCode session id.`)
  const tail = input.tail === undefined ? 0 : Math.max(0, Math.min(20, Math.trunc(input.tail)))
  const request = JSON.stringify({ action: "phase", sessionID: input.sessionId, ...(tail ? { tail } : {}) })
  const result = await boxd.exec(target, `python3 ${V0_HELPER_PATH}`, { timeoutSeconds: 10, json: false, stdin: request }, opContext)
  return parseV0Phase(result.stdout, result.stderr, result.code)
}

/** v0's `phase` answer in v1's `PhaseAnswer` shape; the guest's words are redacted and cut. */
export function parseV0Phase(stdout: string, stderr: string, code: number): PhaseAnswer {
  const line = stdout
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item.startsWith("{"))
    .pop()
  let parsed: Record<string, unknown> | undefined
  try {
    parsed = line ? (JSON.parse(line) as Record<string, unknown>) : undefined
  } catch {
    parsed = undefined
  }
  if (!parsed) {
    const gone = /can't open file|No such file or directory/i.test(stderr)
    throw boxdError(
      "GUEST_FAILED",
      gone ? "The machine has no opencode-boxd helper: a reboot cleared the v0 helper from /tmp." : `The v0 helper's phase gave no answer (${shortReason(stderr) ?? `exit ${code}`}).`,
    )
  }
  if (parsed.ok === false || code !== 0) {
    const reason = [parsed.error, parsed.detail].filter((part): part is string => typeof part === "string" && part !== "").join(": ")
    throw boxdError("GUEST_FAILED", `The v0 helper's phase failed (${shortReason(reason) ?? "no reason given"}).`)
  }
  const phase = parsed.phase === "busy" || parsed.phase === "idle" ? parsed.phase : "missing"
  const outcome = typeof parsed.outcome === "string" ? (V0_OUTCOMES[parsed.outcome] ?? null) : null
  const failure = isObject(parsed.error) ? parsed.error : undefined
  const error = failure ? shortReason(`${String(failure.type ?? "error")}: ${String(failure.message ?? "").split("\n")[0]}`) : undefined
  const at = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : undefined)
  const lastText = typeof parsed.lastText === "string" ? excerpt(parsed.lastText, LAST_TEXT_LIMIT) : undefined
  const tail = Array.isArray(parsed.tail)
    ? parsed.tail
        .filter(isObject)
        .map((item) => ({ ...(at(item.at) ? { at: at(item.at)! } : {}), text: excerpt(String(item.text ?? ""), LAST_TEXT_LIMIT) ?? "" }))
        .filter((item) => item.text !== "")
    : undefined
  const pending = typeof parsed.pending === "number" ? parsed.pending : 0
  const lastActivityAt = at(parsed.activityAt)
  return {
    phase,
    outcome,
    ...(error && outcome === "failed" ? { error } : {}),
    ...(lastActivityAt ? { lastActivityAt } : {}),
    ...(lastText ? { lastText } : {}),
    // v0 admitted every prompt with OpenCode's default delivery, which is steer (F5).
    waiting: { steer: pending, queue: 0 },
    guestVersion: null,
    ...(tail ? { tail } : {}),
  }
}

/** The v1 helper's home on the guest, where `adopt` puts the v0 server's password. */
const GUEST_HOME = GUEST_HELPER_PATH.slice(0, GUEST_HELPER_PATH.lastIndexOf("/"))
/** One shell line: copy the v0 password into the v1 home once, 0600, through a temp file and a rename. */
export const ADOPT_COMMAND =
  `mkdir -p ${GUEST_HOME} && chmod 700 ${GUEST_HOME} && ` +
  `if [ ! -e ${GUEST_HOME}/password ] && [ -f /tmp/opencode-boxd/password ]; then ` +
  `(umask 077 && cp /tmp/opencode-boxd/password ${GUEST_HOME}/password.adopt && mv ${GUEST_HOME}/password.adopt ${GUEST_HOME}/password); fi && ` +
  `echo opencode-boxd-adopted`

/**
 * Takes a running v0 guest over at its first change (§6.3), under the machine lock the caller holds: one plain
 * `machine exec` copies `/tmp/opencode-boxd/password` to the v1 home (0600) when the v1 home has none. The running
 * server and its session are untouched; the caller then records `guestHelper: "v1"`. A read never calls this (M2).
 */
export async function adoptV0(boxd: Pick<BoxdPort, "exec">, target: ChangeTarget, opContext: OpContext): Promise<void> {
  const result = await boxd.exec(target, ADOPT_COMMAND, { timeoutSeconds: 30, json: false }, opContext)
  if (result.code !== 0 || !result.stdout.includes("opencode-boxd-adopted")) {
    throw boxdError("GUEST_FAILED", `Taking over the v0 guest failed (${shortReason(result.stderr) ?? `exit ${result.code}`}).`)
  }
}

// ── The port (design §9.1): what \`src/plugin.ts\` builds once, before the ledger ─────────────────────────────────

/**
 * The import port. It starts the import (or the retry of blocked ids) at once, at plugin start; every later \`run\` joins
 * the one in flight. Its processes carry the import's own call tag, never a tool call's.
 */
export function createImportV0(core: HostServices & Runtime): ImportV0Port {
  const gate = new LedgerGate({ root: core.ledgerRoot, boxd: core.boxd, now: () => core.clock.now() })
  const state = (): ImportState => {
    const current = gate.state()
    switch (current.state) {
      case "ready":
        return { state: "complete", works: current.works, blocked: current.blocked }
      case "failed":
        return { state: "failed", reason: current.reason, retryAt: new Date(current.retryAt).toISOString() }
      case "importing":
        return { state: "importing", done: current.progress.done, total: current.progress.total }
      case "idle":
        return { state: "importing", done: 0, total: 0 }
    }
  }
  const run = async (): Promise<ImportState> => {
    try {
      await gate.start()
      const current = gate.state()
      core.report("import", current.state === "failed" ? `IMPORT_V0_FAILED: ${current.reason}` : undefined)
    } catch (error) {
      // A stop at plugin disposal is not a problem to show; the next start runs the import again.
      if (!(error instanceof BoxdError && error.code === "CANCELLED")) core.report("import", reasonText(error))
    }
    return state()
  }
  void run()
  return {
    state,
    run: () => run(),
    readPhase: (target, input, opContext) => v0Phase(core.boxd, target, input, opContext),
    adopt: (target, opContext) => adoptV0(core.boxd, target, opContext),
    dispose: () => gate.dispose(),
  }
}
