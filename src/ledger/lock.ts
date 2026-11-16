/**
 * The cross-process lock (design §2.2, §6.1): a folder made with an atomic `mkdir`, holding `owner.json` with a random
 * token, the pid, the host and the time of the last heartbeat. The holder rewrites it every `LOCK_HEARTBEAT_MS`; a lock
 * whose heartbeat is older than `LOCK_STALE_MS`, or whose holder is a process on this host that no longer exists, is
 * stale and may be taken over. The same lock serves a work's `work.lock`, the import's `import.lock`, the event log and
 * the automation owner's `automation.lock`.
 *
 * Taking over is itself race-free: the stale folder is renamed aside (only one process can rename it), its owner is
 * read back, and a folder that turns out to be someone's fresh lock is put back. A holder checks its token before any
 * step that must not run twice (`holds`), and its heartbeat notices a takeover (`lost`).
 */
import { hostname } from "node:os"
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises"
import { join } from "node:path"
import { boxdError } from "../errors.js"
import { LOCK_HEARTBEAT_MS, LOCK_STALE_MS } from "./types.js"
import { errnoOf, FILE_MODE, randomPart, remove } from "./fsx.js"

export interface LockOwner {
  readonly token: string
  readonly pid: number
  readonly host: string
  /** `Date.now()` at the last heartbeat. */
  readonly at: number
  readonly purpose: string
}

export interface LockOptions {
  /** What the lock is for, recorded in `owner.json`. */
  readonly purpose: string
  /** How long to keep trying while a live owner holds it; 0 tries once. */
  readonly waitMs?: number
  readonly pollMs?: number
  readonly staleMs?: number
  readonly heartbeatMs?: number
  readonly now?: () => number
  readonly signal?: AbortSignal
  /** Called once the handle is released, by its holder or by `LockSet.dispose`. */
  readonly onRelease?: () => void
}

export interface LockHandle {
  readonly path: string
  readonly token: string
  /** True once a heartbeat found another token in the folder: this holder must stop. */
  readonly lost: boolean
  /** Reads the folder now: true only while it still holds this holder's token. */
  holds(): Promise<boolean>
  /** Writes a small JSON note beside the owner, such as the import's progress; only while this holder holds it. */
  note(name: string, value: unknown): Promise<void>
  /** Gives the lock up if it still holds this token; a lock already taken over is left to its new owner. */
  release(): Promise<void>
}

const OWNER = "owner.json"
const host = hostname()

/**
 * Writes a file inside a lock folder through a temp file and a rename, never making the folder: a heartbeat that runs
 * after its lock was released or taken over must not bring the folder back.
 */
async function writeInLock(path: string, name: string, value: unknown): Promise<void> {
  const target = join(path, name)
  const temp = join(path, `.${name}.${process.pid}.${randomPart()}.tmp`)
  const handle = await open(temp, "wx", FILE_MODE)
  try {
    await handle.writeFile(JSON.stringify(value))
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, target)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

/**
 * The lock's owner, with `at` from its own heartbeat file (`beat-<token>`) when that is newer. A heartbeat writes only
 * its own token's file, so a late heartbeat from a holder that lost the lock never touches its successor's state.
 */
export async function readOwner(path: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(join(path, OWNER), "utf8")) as Partial<LockOwner>
    if (typeof parsed.token !== "string" || typeof parsed.pid !== "number" || typeof parsed.at !== "number") return null
    let at = parsed.at
    try {
      const beat = JSON.parse(await readFile(join(path, beatName(parsed.token)), "utf8")) as { at?: unknown }
      if (typeof beat.at === "number" && beat.at > at) at = beat.at
    } catch {
      // no heartbeat yet: the owner's own time stands
    }
    return { token: parsed.token, pid: parsed.pid, host: String(parsed.host ?? ""), at, purpose: String(parsed.purpose ?? "") }
  } catch {
    return null
  }
}

const beatName = (token: string) => `beat-${token}.json`

/**
 * After a lock folder was renamed aside, checks it was the one expected (by token) and puts it back when it was not:
 * between a read and a rename another process may have made its own lock there. When a third process has already made
 * a new folder at the path, the moved one is removed, and its owner's next check sees `lost`.
 */
async function removeAsideIfMine(path: string, aside: string, token: string | null): Promise<void> {
  const moved = await readOwner(aside)
  if ((moved?.token ?? null) !== token) {
    try {
      await rename(aside, path)
      return
    } catch {
      // fall through: remove it
    }
  }
  await remove(aside)
}

/** Reads a note a holder wrote with `LockHandle.note`; null when there is none or the lock is gone. */
export async function readNote<T>(path: string, name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(join(path, `${name}.json`), "utf8")) as T
  } catch {
    return null
  }
}

/** Whether a process with this pid exists on this host. */
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errnoOf(error) === "EPERM"
  }
}

/**
 * Whether the lock folder at `path` is stale: its heartbeat is older than `staleMs`, or its holder was a process on this
 * host that is gone. A folder with no readable owner (a holder that died between its `mkdir` and its first write) is
 * judged by the folder's own age.
 */
async function staleness(path: string, owner: LockOwner | null, now: number, staleMs: number): Promise<"live" | "stale" | "gone"> {
  if (owner) {
    if (now - owner.at > staleMs) return "stale"
    if (owner.host === host && owner.pid !== process.pid && !alive(owner.pid)) return "stale"
    return "live"
  }
  try {
    const info = await stat(path)
    return now - info.mtimeMs > staleMs ? "stale" : "live"
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return "gone"
    throw error
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })

/** Moves a stale lock aside and removes it; a folder that turns out to be a fresh lock is put back for its owner. */
async function takeOver(path: string, seen: LockOwner | null): Promise<void> {
  const aside = `${path}.stale-${randomPart()}`
  try {
    await rename(path, aside)
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return
    throw error
  }
  await removeAsideIfMine(path, aside, seen?.token ?? null)
}

/**
 * Takes the lock at `path`, or answers null when a live owner still holds it after `waitMs`. Stale locks are taken over.
 * The holder's heartbeat runs until `release`.
 */
export async function acquireLock(path: string, options: LockOptions): Promise<LockHandle | null> {
  const now = options.now ?? Date.now
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  const heartbeatMs = options.heartbeatMs ?? LOCK_HEARTBEAT_MS
  const deadline = now() + (options.waitMs ?? 0)
  const pollMs = options.pollMs ?? 50
  const token = `${randomPart()}${randomPart()}`
  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason
    try {
      await mkdir(path, { mode: 0o700 })
      const owner: LockOwner = { token, pid: process.pid, host, at: now(), purpose: options.purpose }
      await writeInLock(path, OWNER, owner)
      return handle(path, owner, heartbeatMs, now, options.onRelease)
    } catch (error) {
      if (errnoOf(error) !== "EEXIST") throw error
    }
    const seen = await readOwner(path)
    const state = await staleness(path, seen, now(), staleMs)
    if (state === "stale") {
      await takeOver(path, seen)
      continue
    }
    if (state === "gone") continue
    if (now() >= deadline) return null
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())), options.signal)
  }
}

function handle(path: string, owner: LockOwner, heartbeatMs: number, now: () => number, onRelease?: () => void): LockHandle {
  let lost = false
  let released = false
  let beating: Promise<void> = Promise.resolve()
  const holds = async () => !released && (await readOwner(path))?.token === owner.token
  const beat = async () => {
    if (released || lost) return
    if (!(await holds())) {
      lost = true
      return
    }
    if (released) return
    // Only this token's own file: never the owner file, which a successor may have written meanwhile.
    await writeInLock(path, beatName(owner.token), { at: now() }).catch(() => undefined)
  }
  const timer = setInterval(() => {
    beating = beating.then(beat)
  }, heartbeatMs)
  timer.unref?.()
  return {
    path,
    token: owner.token,
    get lost() {
      return lost
    },
    holds,
    async note(name, value) {
      if (await holds()) await writeInLock(path, `${name}.json`, value).catch(() => undefined)
    },
    async release() {
      if (released) return
      clearInterval(timer)
      // A heartbeat already under way finishes first, so it can never write into the folder after it is gone.
      await beating
      const mine = await holds()
      released = true
      onRelease?.()
      if (!mine) return
      // Renamed aside first, so another process's `mkdir` never meets a half-removed folder.
      const aside = `${path}.released-${randomPart()}`
      try {
        await rename(path, aside)
      } catch (error) {
        if (errnoOf(error) === "ENOENT") return
        throw error
      }
      // A takeover may have landed between the check and the rename: a successor's folder goes back untouched.
      await removeAsideIfMine(path, aside, owner.token)
    },
  }
}

/**
 * The locks one owner (a ledger, an import) holds, for its disposal: `dispose` refuses new locks with `CANCELLED`,
 * aborts the ones still waiting, gives the holders `graceMs` to finish, then stops every heartbeat and releases every
 * lock still held, so no other process has to wait for a stale takeover.
 */
export class LockSet {
  private readonly held = new Set<LockHandle>()
  private readonly controller = new AbortController()
  private readonly busy = new Set<Promise<unknown>>()

  get signal(): AbortSignal {
    return this.controller.signal
  }
  get disposed(): boolean {
    return this.controller.signal.aborted
  }
  /** How many locks are held now. */
  get size(): number {
    return this.held.size
  }

  async acquire(path: string, options: LockOptions): Promise<LockHandle | null> {
    this.assertOpen()
    const signal = options.signal ? AbortSignal.any([options.signal, this.signal]) : this.signal
    let entry: LockHandle | undefined
    const lock = await acquireLock(path, { ...options, signal, onRelease: () => entry && this.held.delete(entry) })
    if (!lock) return null
    entry = lock
    this.held.add(lock)
    if (this.disposed) {
      await lock.release()
      this.assertOpen()
    }
    return lock
  }

  /** Runs `fn` as work that `dispose` waits for, up to its grace. */
  track<T>(work: Promise<T>): Promise<T> {
    this.busy.add(work)
    void work.then(
      () => this.busy.delete(work),
      () => this.busy.delete(work),
    )
    return work
  }

  async dispose(graceMs = 2_000): Promise<void> {
    if (!this.disposed) this.controller.abort(stopping())
    let timer: ReturnType<typeof setTimeout> | undefined
    const grace = new Promise<void>((resolve) => (timer = setTimeout(resolve, graceMs)))
    await Promise.race([Promise.allSettled([...this.busy]), grace])
    clearTimeout(timer)
    await Promise.allSettled([...this.held].map((lock) => lock.release()))
    this.held.clear()
  }

  private assertOpen(): void {
    if (this.disposed) throw stopping()
  }
}

const stopping = () => boxdError("CANCELLED", "The plugin is stopping, so the ledger takes no new lock.")
