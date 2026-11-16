/**
 * The laptop ledger, format 1 (design §2.2): `~/.local/share/opencode-boxd/v1/`, published whole by one rename, with
 * one folder per work. This module is its only reader and writer of work records, stored exports, patches and untracked
 * files, and `index.json`.
 *
 * - **One writer per work, across processes:** `withWork` holds the work's `work.lock` (see `lock.ts`) with a
 *   per-process queue on top, and is re-entrant inside its own call. `withWorks` takes several in sorted id order.
 * - **Copy-on-write:** every file is replaced through a temp file beside it and a rename (`fsx.ts`).
 * - **Cheap reads:** `index.json` caches each record's state, region, phase and `saved`, refreshed only for records whose
 *   `mtimeMs` changed; closed works are not loaded unless asked for.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { mkdir, readdir, readFile, rename, rmdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { boxdError, BoxdError } from "../errors.js"
import { EventLog } from "./events.js"
import { commitFile, type Digest, ensureDir, errnoOf, exists, fsyncDir, isTempName, randomPart, remove, tempBeside, writeJsonAtomic } from "./fsx.js"
import { LockSet } from "./lock.js"
import {
  LEDGER_FORMAT,
  LEDGER_PATHS,
  WORK_FILES,
  type IndexEntry,
  type LedgerIndex,
  type Phase,
  type SavedState,
  type WorkRecord,
} from "./types.js"

/** The work id rule (design §2.1); also the only folder names the ledger reads under `works/`. */
export const WORK_ID = /^[a-z][a-z0-9-]{0,24}$/
/** How long a write waits for another process's work lock before it answers `LEDGER_LOCKED`. */
export const WORK_LOCK_WAIT_MS = 10_000

/**
 * `saved`, computed (design §2.2): `fresh` when the last harvest was complete and no later prompt went through the
 * plugin; `stale` when one exists but is older or partial; `none` otherwise.
 */
export function savedState(record: Pick<WorkRecord, "saved" | "lastSubmit">): SavedState {
  if (!record.saved) return "none"
  if (!record.saved.complete) return "stale"
  if (record.lastSubmit && record.saved.at < record.lastSubmit.at) return "stale"
  return "fresh"
}

/** A git remote without its userinfo, so a token in `https://x-access-token:…@` never reaches the ledger or a result. */
export function withoutUserinfo(remote: string): string {
  return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, "$1")
}

export function assertWorkId(workId: string): void {
  if (!WORK_ID.test(workId)) throw boxdError("NAME_INVALID", `workId "${workId}" is not a short lowercase name: a letter, then up to 24 lowercase letters, digits or hyphens.`, { field: "workId" })
}

const ledgerError = (action: string, error: unknown): BoxdError =>
  error instanceof BoxdError ? error : boxdError("LEDGER_FAILED", `The ledger could not ${action} (${(error instanceof Error ? error.message : String(error)).slice(0, 160)}).`)

interface Cached {
  entry: IndexEntry
  ino: number
  record?: WorkRecord
}

export interface ListOptions {
  /** Closed works too; they are loaded only when asked for. */
  readonly closed?: boolean
}

export interface LedgerOptions {
  readonly now?: () => Date
  readonly lockWaitMs?: number
  /** Rotation size for the event log; tests make it small. */
  readonly eventsRotateBytes?: number
  /** The locks' timing; tests make the heartbeat fast. */
  readonly lock?: { readonly heartbeatMs?: number; readonly staleMs?: number }
}

/** The published ledger. `openLedger` checks the `complete` marker first: a partial ledger is never read. */
export class Ledger {
  /** `~/.local/share/opencode-boxd`. */
  readonly root: string
  /** `<root>/v1`. */
  readonly dir: string
  readonly events: EventLog
  /** Every lock this ledger holds, for `dispose`. */
  readonly locks = new LockSet()
  private readonly lockTiming: { readonly heartbeatMs?: number; readonly staleMs?: number }
  private readonly cache = new Map<string, Cached>()
  private indexLoaded = false
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly held = new AsyncLocalStorage<ReadonlySet<string>>()
  private readonly lockWaitMs: number

  constructor(root: string, options: LedgerOptions = {}) {
    this.root = root
    this.dir = join(root, LEDGER_PATHS.v1)
    this.lockWaitMs = options.lockWaitMs ?? WORK_LOCK_WAIT_MS
    this.lockTiming = options.lock ?? {}
    this.events = new EventLog(this.dir, {
      locks: this.locks,
      ...(options.now ? { now: options.now } : {}),
      ...(options.eventsRotateBytes ? { rotateBytes: options.eventsRotateBytes } : {}),
    })
  }

  // ── Paths ────────────────────────────────────────────────────────────────────────────────────────────────────────

  workDir(workId: string): string {
    assertWorkId(workId)
    return join(this.root, LEDGER_PATHS.works, workId)
  }
  recordPath = (workId: string) => join(this.workDir(workId), WORK_FILES.record)
  exportPath(workId: string, sessionId: string): string {
    if (!/^ses_[A-Za-z0-9_-]{1,80}$/.test(sessionId)) throw boxdError("NAME_INVALID", `Session id "${sessionId}" is not an OpenCode session id.`)
    return join(this.workDir(workId), WORK_FILES.exports, `${sessionId}.json`)
  }
  patchPath = (workId: string) => join(this.workDir(workId), WORK_FILES.patch)
  untrackedDir = (workId: string) => join(this.workDir(workId), WORK_FILES.untracked)

  // ── Locks ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Runs `fn` holding the work's lock: first this process's queue for the id, then the `work.lock` folder, which another
   * OpenCode process may hold for at most `lockWaitMs` before this answers `LEDGER_LOCKED`. Re-entrant: a call already
   * inside this work's lock runs at once.
   */
  async withWork<T>(workId: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    assertWorkId(workId)
    const held = this.held.getStore()
    if (held?.has(workId)) return fn()
    const previous = this.queues.get(workId) ?? Promise.resolve()
    const run = async () => {
      const dir = this.workDir(workId)
      const lock = await this.lockWork(dir, workId, signal)
      if (!lock) throw boxdError("LEDGER_LOCKED", `Another OpenCode process holds work "${workId}"'s lock.`)
      try {
        return await this.held.run(new Set([...(held ?? []), workId]), fn)
      } finally {
        await lock.release()
        // A lock taken for a work that was never written leaves no empty folder behind.
        if (!(await exists(join(dir, WORK_FILES.record)))) await rmdir(dir).catch(() => undefined)
      }
    }
    const next = this.locks.track(previous.then(run, run))
    this.queues.set(
      workId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  /** The work's lock folder; its parent is made first, and made again when another process removed it meanwhile. */
  private async lockWork(dir: string, workId: string, signal?: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      await ensureDir(dir)
      try {
        return await this.locks.acquire(join(dir, WORK_FILES.lock), { purpose: `work ${workId}`, waitMs: this.lockWaitMs, ...this.lockTiming, ...(signal ? { signal } : {}) })
      } catch (error) {
        if (errnoOf(error) !== "ENOENT" || attempt >= 3) throw ledgerError(`lock work "${workId}"`, error)
        if (this.locks.disposed) throw ledgerError(`lock work "${workId}"`, error)
      }
    }
  }

  /** Several works' locks, in sorted id order (design §2.2, L-h), so two opposite calls never wait on each other. */
  async withWorks<T>(workIds: readonly string[], fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const ids = [...new Set(workIds)].sort()
    const step = (index: number): Promise<T> => (index === ids.length ? fn() : this.withWork(ids[index]!, () => step(index + 1), signal))
    return step(0)
  }

  // ── Records ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** One record as it is on disk now; undefined when the ledger has none. */
  async get(workId: string): Promise<WorkRecord | undefined> {
    const path = this.recordPath(workId)
    let info
    try {
      info = await stat(path)
    } catch (error) {
      if (errnoOf(error) === "ENOENT") {
        this.cache.delete(workId)
        return undefined
      }
      throw ledgerError(`read work "${workId}"`, error)
    }
    const cached = this.cache.get(workId)
    if (cached?.record && cached.entry.mtimeMs === info.mtimeMs && cached.ino === info.ino) return cached.record
    return this.load(workId, path, info)
  }

  /**
   * Reads, changes and writes one record under its lock. The recipe gets the record as it is on disk now (undefined for
   * a new work); its result is written copy-on-write, and `undefined` writes nothing. A failing recipe writes nothing.
   */
  async mutate(workId: string, recipe: (current: WorkRecord | undefined) => WorkRecord | undefined | Promise<WorkRecord | undefined>, signal?: AbortSignal): Promise<WorkRecord | undefined> {
    return this.withWork(
      workId,
      async () => {
        const current = await this.get(workId)
        const next = await recipe(current)
        if (next === undefined) return current
        this.check(workId, next)
        if (current && JSON.stringify(current) === JSON.stringify(next)) return current
        await this.write(workId, next)
        return next
      },
      signal,
    )
  }

  /** Writes one whole record under its lock (re-entrant inside `withWork`), copy-on-write. */
  async put(record: WorkRecord, signal?: AbortSignal): Promise<WorkRecord> {
    return (await this.mutate(record.workId, () => record, signal))!
  }

  /** Every open work (closed ones too with `closed: true`), in work-id order. */
  async list(options: ListOptions = {}): Promise<WorkRecord[]> {
    const index = await this.refresh()
    const ids = Object.keys(index.works)
      .filter((id) => options.closed || index.works[id]!.state === "open")
      .sort()
    const records = await Promise.all(ids.map((id) => this.get(id)))
    return records.filter((record): record is WorkRecord => record !== undefined && (options.closed || record.state === "open"))
  }

  /**
   * The index: one entry per work, refreshed only for records whose `mtimeMs` (or inode) changed since the last look,
   * and written back to `index.json` when anything changed. A closed work whose file did not change is never read.
   */
  async refresh(): Promise<LedgerIndex> {
    if (!this.indexLoaded) await this.loadIndex()
    let names: string[]
    try {
      names = await readdir(join(this.root, LEDGER_PATHS.works))
    } catch (error) {
      if (errnoOf(error) !== "ENOENT") throw ledgerError("list the works", error)
      names = []
    }
    let changed = false
    const seen = new Set<string>()
    for (const name of names) {
      if (!WORK_ID.test(name)) continue
      let info
      try {
        info = await stat(join(this.root, LEDGER_PATHS.works, name, WORK_FILES.record))
      } catch (error) {
        if (errnoOf(error) === "ENOENT" || errnoOf(error) === "ENOTDIR") continue
        throw ledgerError(`read work "${name}"`, error)
      }
      seen.add(name)
      const cached = this.cache.get(name)
      // ino is 0 for an entry read back from index.json: the mtime alone decides then.
      if (cached && cached.entry.mtimeMs === info.mtimeMs && (cached.ino === 0 || cached.ino === info.ino)) continue
      await this.load(name, join(this.root, LEDGER_PATHS.works, name, WORK_FILES.record), info)
      changed = true
    }
    for (const id of [...this.cache.keys()]) {
      if (!seen.has(id)) {
        this.cache.delete(id)
        changed = true
      }
    }
    const index = this.snapshot()
    if (changed) await this.saveIndex(index)
    return index
  }

  /** Records the phase the watcher last saw, for the index (design §3.1); a closed work is always `closed`. */
  async setPhase(workId: string, phase: Phase): Promise<void> {
    const cached = this.cache.get(workId)
    if (!cached || cached.entry.phase === phase || cached.entry.state === "closed") return
    cached.entry = { ...cached.entry, phase }
    await this.saveIndex(this.snapshot())
  }

  // ── Files: exports, the patch, untracked files ───────────────────────────────────────────────────────────────────

  /**
   * A temp path beside a ledger file, for `machine cp` to write into. The caller then calls `commit` (verified and
   * renamed over the file) or `discard`. The stored file is untouched until a verified commit (design §3.6, M-a).
   */
  tempFor(target: string): string {
    return tempBeside(target)
  }

  /**
   * Moves a finished temp file over a ledger file under the work's lock: size and sha256 checked against `expect`, then
   * fsynced and renamed. A mismatch deletes the temp file, keeps the stored one byte for byte, and throws
   * `EXPORT_INVALID`.
   */
  async commit(workId: string, temp: string, target: string, expect?: Digest): Promise<Digest> {
    if (!target.startsWith(`${this.workDir(workId)}/`)) throw boxdError("LEDGER_FAILED", `${target} is not inside work "${workId}"'s folder.`)
    return this.withWork(workId, () => commitFile(temp, target, expect))
  }

  async discard(temp: string): Promise<void> {
    await remove(temp)
  }

  /**
   * A new, empty folder to build the next `untracked/` set in: `untracked.<rand>.tmp/` beside it. Fill it, then
   * `commitUntracked`; a crash before that leaves the stored set as it was.
   */
  async stageUntracked(workId: string): Promise<string> {
    const staging = join(this.workDir(workId), `.${WORK_FILES.untracked}.${randomPart()}.tmp`)
    await mkdir(staging, { recursive: true, mode: 0o700 })
    return staging
  }

  /**
   * Swaps a staged `untracked/` set in, under the work's lock: the old folder is renamed aside, the staged one renamed
   * into place, and the old one removed. A crash between the two renames is repaired by `recoverUntracked`, which puts
   * the old set back, so a reader never sees half of two sets.
   */
  async commitUntracked(workId: string, staging: string): Promise<void> {
    await this.withWork(workId, async () => {
      await this.recoverUntracked(workId, staging)
      const dir = this.untrackedDir(workId)
      const aside = join(this.workDir(workId), `.${WORK_FILES.untracked}.old-${randomPart()}`)
      const had = await exists(dir)
      if (had) await rename(dir, aside)
      await rename(staging, dir)
      await fsyncDir(this.workDir(workId))
      if (had) await remove(aside)
    })
  }

  /**
   * Repairs an untracked swap a crash cut short: with no `untracked/` and an old set aside, the old set goes back; an
   * old set left beside a new one is removed; staged sets that were never committed are removed.
   */
  async recoverUntracked(workId: string, keep?: string): Promise<void> {
    await this.withWork(workId, async () => {
      const dir = this.workDir(workId)
      let names: string[]
      try {
        names = await readdir(dir)
      } catch (error) {
        if (errnoOf(error) === "ENOENT") return
        throw error
      }
      const old = names.filter((name) => name.startsWith(`.${WORK_FILES.untracked}.old-`))
      const current = names.includes(WORK_FILES.untracked)
      for (const [index, name] of old.entries()) {
        if (!current && index === 0) await rename(join(dir, name), this.untrackedDir(workId))
        else await remove(join(dir, name))
      }
      for (const name of names) {
        if (name.startsWith(`.${WORK_FILES.untracked}.`) && name.endsWith(".tmp") && join(dir, name) !== keep) await remove(join(dir, name))
      }
    })
  }

  /** Removes temp files a crash left beside a work's files (`exports/` and the work folder). */
  async sweepTemps(workId: string): Promise<void> {
    await this.withWork(workId, async () => {
      for (const dir of [this.workDir(workId), join(this.workDir(workId), WORK_FILES.exports)]) {
        let names: string[] = []
        try {
          names = await readdir(dir)
        } catch {
          continue
        }
        for (const name of names) if (isTempName(name) && !name.startsWith(`.${WORK_FILES.untracked}.`)) await remove(join(dir, name))
      }
    })
  }

  /**
   * On plugin disposal or reload: no new lock is taken (`CANCELLED`), a write in flight gets a short grace to finish
   * (copy-on-write, so a cut one leaves the old file), and then every heartbeat stops and every lock this ledger still
   * holds is released, so another process never waits for a stale takeover.
   */
  async dispose(graceMs?: number): Promise<void> {
    await this.locks.dispose(graceMs)
  }

  // ── Internals ────────────────────────────────────────────────────────────────────────────────────────────────────

  private check(workId: string, record: WorkRecord): void {
    if (record.format !== LEDGER_FORMAT || record.workId !== workId) {
      throw boxdError("LEDGER_FAILED", `A record for work "${workId}" must have format ${LEDGER_FORMAT} and that workId.`)
    }
  }

  private async write(workId: string, record: WorkRecord): Promise<void> {
    const path = this.recordPath(workId)
    try {
      await writeJsonAtomic(path, record)
      await this.load(workId, path, await stat(path), record)
      await this.saveIndex(this.snapshot())
    } catch (error) {
      throw ledgerError(`write work "${workId}"`, error)
    }
  }

  private async load(workId: string, path: string, info: { mtimeMs: number; ino: number }, known?: WorkRecord): Promise<WorkRecord> {
    let record: WorkRecord
    try {
      record = known ?? (JSON.parse(await readFile(path, "utf8")) as WorkRecord)
    } catch (error) {
      throw ledgerError(`read work "${workId}"`, error)
    }
    if (record.format !== LEDGER_FORMAT || record.workId !== workId) throw boxdError("LEDGER_FAILED", `work "${workId}"'s record is not a format ${LEDGER_FORMAT} record for that work.`)
    const previous = this.cache.get(workId)
    const entry: IndexEntry = {
      state: record.state,
      region: record.region,
      phase: record.state === "closed" ? "closed" : (previous?.entry.phase ?? null),
      saved: savedState(record),
      mtimeMs: info.mtimeMs,
    }
    this.cache.set(workId, { entry, ino: info.ino, record })
    return record
  }

  private snapshot(): LedgerIndex {
    const works: Record<string, IndexEntry> = {}
    for (const id of [...this.cache.keys()].sort()) works[id] = this.cache.get(id)!.entry
    return { format: LEDGER_FORMAT, works }
  }

  private async loadIndex(): Promise<void> {
    this.indexLoaded = true
    try {
      const parsed = JSON.parse(await readFile(join(this.root, LEDGER_PATHS.index), "utf8")) as LedgerIndex
      if (parsed.format !== LEDGER_FORMAT || !parsed.works || typeof parsed.works !== "object") return
      for (const [id, entry] of Object.entries(parsed.works)) {
        if (WORK_ID.test(id) && entry && typeof entry.mtimeMs === "number" && !this.cache.has(id)) this.cache.set(id, { entry, ino: 0 })
      }
    } catch {
      // A missing or broken cache is rebuilt from the records.
    }
  }

  private async saveIndex(index: LedgerIndex): Promise<void> {
    // A cache: a failed write costs a rebuild later, never a wrong answer.
    await writeJsonAtomic(join(this.root, LEDGER_PATHS.index), index).catch(() => undefined)
  }
}

/** Opens the published ledger; `LEDGER_FAILED` when `v1/` has no `complete` marker (it is published only whole). */
export async function openLedger(root: string, options: LedgerOptions = {}): Promise<Ledger> {
  if (!(await exists(join(root, LEDGER_PATHS.complete)))) throw boxdError("LEDGER_FAILED", "The v1 ledger has no complete marker, so it is not read.")
  return new Ledger(root, options)
}
