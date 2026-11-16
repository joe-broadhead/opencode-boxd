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
import { mkdir, readFile, rename, stat } from "node:fs/promises"
import { join } from "node:path"
import { LOCK_HEARTBEAT_MS, LOCK_STALE_MS } from "./types.js"
import { errnoOf, randomPart, remove, writeJsonAtomic } from "./fsx.js"

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

export async function readOwner(path: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(join(path, OWNER), "utf8")) as Partial<LockOwner>
    if (typeof parsed.token !== "string" || typeof parsed.pid !== "number" || typeof parsed.at !== "number") return null
    return { token: parsed.token, pid: parsed.pid, host: String(parsed.host ?? ""), at: parsed.at, purpose: String(parsed.purpose ?? "") }
  } catch {
    return null
  }
}

/** Reads a note a holder wrote with `LockHandle.note`; null when there is none or the lock is gone. */
export async function readNote<T>(path: string, name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(join(path, `${name}.json`), "utf8")) as T
  } catch {
    return null
  }
}

const alive = (pid: number) => {
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
  const moved = await readOwner(aside)
  if ((moved?.token ?? null) !== (seen?.token ?? null)) {
    // Between our read and our rename another process took it over and wrote its own token: give it back. When a third
    // process has already made a new folder there, the one we hold is dropped, and its owner's heartbeat sees `lost`.
    try {
      await rename(aside, path)
      return
    } catch {
      // fall through: remove it
    }
  }
  await remove(aside)
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
      await writeJsonAtomic(join(path, OWNER), owner)
      return handle(path, owner, heartbeatMs, now)
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

function handle(path: string, owner: LockOwner, heartbeatMs: number, now: () => number): LockHandle {
  let lost = false
  let released = false
  const holds = async () => !released && (await readOwner(path))?.token === owner.token
  const beat = async () => {
    if (released || lost) return
    if (!(await holds())) {
      lost = true
      return
    }
    await writeJsonAtomic(join(path, OWNER), { ...owner, at: now() }).catch(() => undefined)
  }
  const timer = setInterval(() => void beat(), heartbeatMs)
  timer.unref?.()
  return {
    path,
    token: owner.token,
    get lost() {
      return lost
    },
    holds,
    async note(name, value) {
      if (await holds()) await writeJsonAtomic(join(path, `${name}.json`), value).catch(() => undefined)
    },
    async release() {
      if (released) return
      clearInterval(timer)
      const mine = await holds()
      released = true
      if (!mine) return
      // Renamed aside first, so another process's `mkdir` never meets a half-removed folder.
      const aside = `${path}.released-${randomPart()}`
      try {
        await rename(path, aside)
      } catch (error) {
        if (errnoOf(error) === "ENOENT") return
        throw error
      }
      await remove(aside)
    },
  }
}
