// The fake boxd CLI's state lock, shared by the fake binaries (`fake-boxd.mjs`) and the test side (`fake-cli.ts`): a
// folder made with an atomic mkdir, holding an `owner` file with the holder's pid.
//
// - A waiter waits by time, not by a count of tries: a holder slowed by the machine (a disk stall writing the state
//   file) delays a call, and never fails it. Only a lock still held after `LOCK_WAIT_MS` fails, naming its owner.
// - A lock whose owner is dead (a holder SIGKILLed mid-write, after its SIGTERM grace) is taken over: renamed aside
//   atomically, so two waiters never both take it, then removed. A folder with no `owner` file yet is a holder between
//   its mkdir and its write, unless it is older than `OWNERLESS_STALE_MS`.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const LOCK_WAIT_MS = 60_000
const OWNERLESS_STALE_MS = 5_000
const SPIN_MS = 2

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: a live process of another user.
    return error?.code === "EPERM"
  }
}

/** True when the lock's holder can never release it: a dead pid, or no owner long after the mkdir. */
function stale(lock) {
  let owner
  try {
    owner = Number(readFileSync(join(lock, "owner"), "utf8"))
  } catch {
    try {
      return Date.now() - statSync(lock).mtimeMs > OWNERLESS_STALE_MS
    } catch {
      return false
    }
  }
  return Number.isInteger(owner) && owner > 0 && !alive(owner)
}

/** Takes the lock, waiting up to `LOCK_WAIT_MS` and taking over a stale one. */
export function acquire(lock) {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (let tries = 0; ; tries++) {
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, "owner"), String(process.pid))
      return
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
    }
    if (tries % 25 === 0 && stale(lock)) {
      const aside = `${lock}.stale-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
      try {
        renameSync(lock, aside)
        rmSync(aside, { recursive: true, force: true })
      } catch {
        // Another waiter took it over first.
      }
      continue
    }
    if (Date.now() > deadline) {
      let owner = "unknown"
      try {
        owner = readFileSync(join(lock, "owner"), "utf8")
      } catch {}
      throw new Error(`the fake boxd state lock was held for ${LOCK_WAIT_MS / 1000} s by pid ${owner}`)
    }
    pause(SPIN_MS)
  }
}

export function release(lock) {
  rmSync(lock, { recursive: true, force: true })
}
