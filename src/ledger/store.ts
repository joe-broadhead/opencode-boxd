/**
 * The laptop ledger, format 1 (design §2.2): `~/.local/share/boxd-plugin/v1/`, published whole by one rename, with
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
import { lstat, mkdir, open, readdir, readFile, rename, rmdir, stat } from "node:fs/promises"
import { basename, dirname, join, resolve, sep } from "node:path"
import { boxdError, BoxdError } from "../errors.js"
import { EventLog } from "./events.js"
import type { Expected, LedgerFile, StagedFile, StagedFolder } from "../ports.js"
import { commitFile, copyFileAtomic, type Digest, digestFile, ensureDir, errnoOf, exists, FILE_MODE, fsyncDir, randomPart, remove, writeJsonAtomic } from "./fsx.js"
import { alive, LockSet, type LockHandle } from "./lock.js"
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

/** The laptop ledger. Every record is written copy-on-write under its work lock. */
export class Ledger {
  /** `~/.local/share/boxd-plugin`. */
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
  /** The work locks this async call holds, by work id: what `fence` checks before every rename. */
  private readonly held = new AsyncLocalStorage<ReadonlyMap<string, LockHandle>>()
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
        return await this.held.run(new Map([...(held ?? new Map<string, LockHandle>()), [workId, lock]]), fn)
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

  // ── The fence ────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Checked right before every rename that makes a write visible (record, export, patch, untracked set): this call
   * still holds the work's lock. A lock taken over by another process (a heartbeat that stalled past the stale bound)
   * answers `LEDGER_LOCKED`, and one released by `dispose` answers `CANCELLED`; the temp file is then deleted and the
   * other writer's file stands. The check reads the lock's owner file just before the rename; a takeover needs the
   * holder's heartbeat to be stale first, so the gap left is that one read.
   */
  async fence(workId: string): Promise<void> {
    const lock = this.held.getStore()?.get(workId)
    if (lock && !lock.lost && (await lock.holds())) return
    if (this.locks.disposed) throw boxdError("CANCELLED", `The plugin stopped before work "${workId}"'s write landed, so it was dropped; the stored file is unchanged.`)
    if (!lock) throw boxdError("LEDGER_FAILED", `A write to work "${workId}" ran without that work's lock.`)
    throw boxdError("LEDGER_LOCKED", `This process's lock on work "${workId}" was taken over, so its write was dropped; the other process's change stands.`)
  }

  // ── Staged writes: exports, the patch, untracked/ ────────────────────────────────────────────────────────────────

  /** A fresh, empty temp file `<final>.<rand>.tmp` beside `final` in the work's folder, for the caller to fill. */
  async stageFile(workId: string, final: LedgerFile): Promise<StagedFile> {
    const target = this.ledgerFile(workId, final)
    await ensureDir(dirname(target))
    const path = `${target}.${stageId()}.tmp`
    await (await open(path, "wx", FILE_MODE)).close()
    return { workId, final, path }
  }

  /**
   * Puts a staged file in place under the work's lock: its size and streamed sha256 must equal `expected`; it is then
   * fsynced, fenced and renamed over `final`. Otherwise the temp file is deleted, `final` stays byte for byte, and
   * `EXPORT_INVALID` (or the fence's code) is thrown.
   */
  async commitStaged(staged: StagedFile, expected: Expected): Promise<Digest> {
    const target = this.ledgerFile(staged.workId, staged.final)
    this.assertStagedBeside(staged.path, target, false)
    return this.withWork(staged.workId, () => commitFile(staged.path, target, expected, "EXPORT_INVALID", () => this.fence(staged.workId)))
  }

  /** A fresh, empty temp folder `untracked.<rand>.tmp/` beside `untracked/`, for the caller to fill. */
  async stageFolder(workId: string): Promise<StagedFolder> {
    const path = join(this.workDir(workId), `${WORK_FILES.untracked}.${stageId()}.tmp`)
    await mkdir(path, { recursive: true, mode: 0o700 })
    return { workId, final: "untracked", path }
  }

  /**
   * Swaps a staged `untracked/` set in, under the work's lock (design §3.6 step 5). The staged folder must hold exactly
   * the files `expected` names (relative paths, no `..`, no symlinks), each with its size and sha256; every file and
   * folder is fsynced. Then, fenced: the old folder is renamed aside, the staged one renamed into place, and the old one
   * removed. On any difference the staged folder is deleted, `untracked/` stays as it was, and `EXPORT_INVALID` is
   * thrown. A crash between the two renames is repaired by `recoverUntracked`.
   */
  async commitFolder(staged: StagedFolder, expected: Readonly<Record<string, Expected>>): Promise<void> {
    const dir = this.untrackedDir(staged.workId)
    this.assertStagedBeside(staged.path, dir, true)
    try {
      await verifyFolder(staged.path, expected)
    } catch (error) {
      await remove(staged.path)
      throw error
    }
    await this.withWork(staged.workId, async () => {
      await this.recoverUntracked(staged.workId)
      const aside = join(this.workDir(staged.workId), `${WORK_FILES.untracked}.old-${randomPart()}`)
      const had = await exists(dir)
      try {
        await this.fence(staged.workId)
      } catch (error) {
        await remove(staged.path)
        throw error
      }
      if (had) await rename(dir, aside)
      try {
        await this.fence(staged.workId)
      } catch (error) {
        if (had) await rename(aside, dir)
        await remove(staged.path)
        throw error
      }
      await rename(staged.path, dir)
      await fsyncDir(this.workDir(staged.workId))
      if (had) await remove(aside)
    })
  }

  /** Deletes a staged file or folder that will not be committed. Never throws. */
  async discard(staged: StagedFile | StagedFolder): Promise<void> {
    try {
      const target = staged.final === "untracked" ? this.untrackedDir(staged.workId) : this.ledgerFile(staged.workId, staged.final)
      this.assertStagedBeside(staged.path, target, staged.final === "untracked")
      await remove(staged.path)
    } catch {
      // a path that is not a staged one is left alone
    }
  }

  /** Copies a file into the work's folder, copy-on-write and fenced. */
  async copyIn(workId: string, source: string, relative: LedgerFile): Promise<Digest> {
    const target = this.ledgerFile(workId, relative)
    return this.withWork(workId, () => copyFileAtomic(source, target, () => this.fence(workId)))
  }

  /**
   * Repairs an untracked swap a crash cut short: with no `untracked/` and an old set aside, the old set goes back; an
   * old set left beside a new one is removed. A staged set is removed only when it is abandoned (its process is gone,
   * or it is a day old): another harvest of the same work may be filling its own set right now, and a commit never
   * touches any staged set but its own.
   */
  async recoverUntracked(workId: string): Promise<void> {
    await this.withWork(workId, async () => {
      const dir = this.workDir(workId)
      let names: string[]
      try {
        names = await readdir(dir)
      } catch (error) {
        if (errnoOf(error) === "ENOENT") return
        throw error
      }
      const old = names.filter((name) => name.startsWith(`${WORK_FILES.untracked}.old-`))
      const current = names.includes(WORK_FILES.untracked)
      for (const [index, name] of old.entries()) {
        if (!current && index === 0) {
          await this.fence(workId)
          await rename(join(dir, name), this.untrackedDir(workId))
        } else await remove(join(dir, name))
      }
      for (const name of names) {
        if (name.startsWith(`${WORK_FILES.untracked}.`) && name.endsWith(".tmp") && (await abandoned(join(dir, name)))) await remove(join(dir, name))
      }
    })
  }

  /** Removes abandoned temp files (their process is gone, or a day old) from a work's folder and `exports/`. */
  async sweepTemps(workId: string): Promise<void> {
    await this.withWork(workId, async () => {
      for (const dir of [this.workDir(workId), join(this.workDir(workId), WORK_FILES.exports)]) {
        let names: string[] = []
        try {
          names = await readdir(dir)
        } catch {
          continue
        }
        for (const name of names) if (name.endsWith(".tmp") && (await abandoned(join(dir, name)))) await remove(join(dir, name))
      }
    })
  }

  /** The absolute path of a ledger file a harvest replaces; anything else is refused. */
  private ledgerFile(workId: string, final: LedgerFile): string {
    if (final !== WORK_FILES.patch && !/^exports\/ses_[A-Za-z0-9_-]{1,80}\.json$/.test(final)) {
      throw boxdError("LEDGER_FAILED", `"${final}" is not a ledger file a harvest writes.`)
    }
    return join(this.workDir(workId), final)
  }

  /** A staged path must be the one the ledger handed out: `<final>.<pid>-<rand>.tmp` in the same folder, resolved. */
  private assertStagedBeside(path: string, final: string, folder: boolean): void {
    const resolved = resolve(path)
    const ok = dirname(resolved) === dirname(final) && new RegExp(`^${escape(basename(final))}\\.[0-9]+-[0-9a-f]{12}\\.tmp$`).test(basename(resolved))
    if (!ok || resolved.includes(`${sep}..${sep}`)) throw boxdError("LEDGER_FAILED", `${path} is not a ${folder ? "folder" : "file"} the ledger staged for ${basename(final)}.`)
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
      await writeJsonAtomic(path, record, () => this.fence(workId))
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

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const WORK_PATH = (path: string) => !(!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || /(^|\/)\.\.?(\/|$)/.test(path) || path.endsWith("/"))

/** A staged untracked set holds exactly the expected files, each with its size and digest; every entry is fsynced. */
async function verifyFolder(root: string, expected: Readonly<Record<string, Expected>>): Promise<void> {
  const found: string[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      const info = await lstat(path)
      if (info.isDirectory()) await walk(path, rel)
      else if (info.isFile()) found.push(rel)
      else throw boxdError("EXPORT_INVALID", `The staged untracked set holds ${rel}, which is not a plain file.`)
    }
    await fsyncDir(dir)
  }
  await walk(root, "")
  const wanted = Object.keys(expected).sort()
  for (const path of wanted) if (!WORK_PATH(path)) throw boxdError("EXPORT_INVALID", `The untracked set names ${path}, which is not a path inside the work tree.`)
  if (JSON.stringify(found.sort()) !== JSON.stringify(wanted)) {
    throw boxdError("EXPORT_INVALID", `The staged untracked set holds ${found.length} files, not the ${wanted.length} the guest reported.`)
  }
  for (const path of wanted) {
    const actual = await digestFile(join(root, path))
    const want = expected[path]!
    if (actual.bytes !== want.bytes || actual.sha256 !== want.sha256) throw boxdError("EXPORT_INVALID", `The staged untracked file ${path} differs from what the guest reported.`)
    const handle = await open(join(root, path), "r")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

/** Each stage's own id: this process's pid, so a crash's leftovers can be told from a live stage, and a random part. */
const stageId = () => `${process.pid}-${randomPart()}`

/** How old a temp file or staged set from another host's process must be before a sweep removes it. */
const ABANDONED_AFTER_MS = 24 * 60 * 60_000

/**
 * A temp file or staged set no live stage owns: its pid (from `stageId` or `tempBeside`) is a process that no longer
 * exists on this host, or it is older than a day. One of this process's own is never abandoned.
 */
async function abandoned(path: string): Promise<boolean> {
  const pid = /\.([0-9]+)[.-][0-9a-f]{12}\.tmp$/.exec(basename(path))?.[1]
  if (pid !== undefined) {
    if (Number(pid) === process.pid) return false
    if (!alive(Number(pid))) return true
  }
  try {
    return Date.now() - (await lstat(path)).mtimeMs > ABANDONED_AFTER_MS
  } catch {
    return false
  }
}
