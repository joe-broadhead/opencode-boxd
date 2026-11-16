// The fake boxd CLI's state lock, shared by the fake binaries (`fake-boxd.mjs`) and the test side (`fake-cli.ts`): a
// folder holding an `owner` file with the holder's pid and a token of its own.
//
// - The lock is made whole: a draft folder with its `owner` file is renamed onto the lock's path, which fails while
//   another holder's lock is there. So a lock is never without its owner, and no waiter can mistake a slow holder (one
//   stalled by a disk stall between steps) for a stale one.
// - A waiter waits by time, not by a count of tries: a slow holder delays a call, and never fails it. Only a lock still
//   held after the wait fails, naming its owner.
// - A lock is taken over only when its owner's pid is dead (a holder SIGKILLed mid-write, after its SIGTERM grace).
//   Takeovers run one at a time, under a second lock of the same kind, and move aside only the very folder that was
//   read dead (by its inode), so a live holder's lock is never handed to another process.
// - `release` removes the lock only while its `owner` holds this acquire's token.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const LOCK_WAIT_MS = 60_000
const SPIN_MS = 2

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const unique = () => `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
/** The token each lock this process holds was taken with. */
const tokens = new Map()

export const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: a live process of another user.
    return error?.code === "EPERM"
  }
}

/** The lock's folder (its inode) and owner: `pid` is undefined for a folder with no readable owner. */
function holder(lock) {
  let ino
  try {
    ino = statSync(lock).ino
  } catch {
    return undefined
  }
  let owner = ""
  try {
    owner = readFileSync(join(lock, "owner"), "utf8")
  } catch {}
  const pid = Number(owner.trim().split(/\s+/)[0])
  return { ino, owner: owner.trim(), pid: Number.isInteger(pid) && pid > 0 ? pid : undefined }
}

/** Puts a lock with this owner text in place in one rename; false when a lock is already there. */
export function plant(lock, owner) {
  const draft = `${lock}.draft-${unique()}`
  mkdirSync(draft)
  try {
    writeFileSync(join(draft, "owner"), owner)
    renameSync(draft, lock)
    return true
  } catch (error) {
    if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") return false
    throw error
  } finally {
    rmSync(draft, { recursive: true, force: true })
  }
}

/** Moves `lock` aside and removes it, only when it is still the folder `ino`; puts back anything else. */
function removeIfSame(lock, ino) {
  const aside = `${lock}.gone-${unique()}`
  try {
    renameSync(lock, aside)
  } catch {
    return
  }
  let moved
  try {
    moved = statSync(aside).ino
  } catch {}
  if (moved === ino) return void rmSync(aside, { recursive: true, force: true })
  try {
    renameSync(aside, lock)
  } catch {}
}

/** Takes over `lock` when its owner is dead, one takeover at a time. */
function reapIfDead(lock) {
  const seen = holder(lock)
  if (!seen || alive(seen.pid)) return
  const reaper = `${lock}.reap`
  const token = `${process.pid} ${unique()}`
  if (!plant(reaper, token)) {
    // A takeover in progress, or one whose taker died: only a dead taker's lock is moved aside.
    const taker = holder(reaper)
    if (taker && !alive(taker.pid)) removeIfSame(reaper, taker.ino)
    return
  }
  try {
    const now = holder(lock)
    if (now && now.ino === seen.ino && !alive(now.pid)) removeIfSame(lock, now.ino)
  } finally {
    const mine = holder(reaper)
    if (mine?.owner === token) removeIfSame(reaper, mine.ino)
  }
}

/** Takes the lock, waiting up to `waitMs` and taking over a dead holder's. */
export function acquire(lock, { waitMs = LOCK_WAIT_MS } = {}) {
  const deadline = Date.now() + waitMs
  const token = `${process.pid} ${unique()}`
  for (let tries = 0; ; tries++) {
    if (plant(lock, token)) {
      tokens.set(lock, token)
      return
    }
    if (tries % 25 === 0) reapIfDead(lock)
    if (Date.now() > deadline) {
      throw new Error(`the fake boxd state lock was held for ${waitMs / 1000} s by pid ${holder(lock)?.pid ?? "unknown"}`)
    }
    pause(SPIN_MS)
  }
}

/** Gives the lock back, only while it is still this acquire's. */
export function release(lock) {
  const token = tokens.get(lock)
  tokens.delete(lock)
  if (token === undefined) return
  const now = holder(lock)
  if (now?.owner === token) removeIfSame(lock, now.ino)
}
