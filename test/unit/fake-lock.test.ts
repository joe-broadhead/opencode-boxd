// The fake boxd CLI's own state lock (test/host/fake-lock.mjs): a live holder, however slow, keeps its lock; only a
// dead holder's lock is taken over; and many processes at once never both hold it.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { acquire, plant, release } from "../host/fake-lock.mjs"

const LOCK_MODULE = fileURLToPath(new URL("../host/fake-lock.mjs", import.meta.url))
const roots: string[] = []
const children: Array<{ kill(): void }> = []
const root = () => {
  const made = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "boxd-lock-")))
  roots.push(made)
  return made
}
afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  for (const made of roots.splice(0)) rmSync(made, { recursive: true, force: true })
})

/** A live process that is not this one: the holder a waiter sees. */
const sleeper = () => {
  const child = Bun.spawn(["sleep", "60"])
  children.push(child)
  return child.pid
}
const deadPid = () => Number(Bun.spawnSync(["sh", "-c", "echo $$"]).stdout.toString().trim())
const ownerOf = (lock: string) => readFileSync(join(lock, "owner"), "utf8")

describe("the fake boxd state lock", () => {
  test("a live holder's lock is never taken over, however long it has been held", () => {
    const lock = join(root(), "state.lock")
    const pid = sleeper()
    expect(plant(lock, String(pid))).toBe(true)
    // Old enough for any age-based rule: only the pid decides.
    utimesSync(lock, new Date(0), new Date(0))
    expect(() => acquire(lock, { waitMs: 1_500 })).toThrow(`held for 1.5 s by pid ${pid}`)
    expect(ownerOf(lock)).toBe(String(pid))
  })

  test("a lock is never without its owner, so a slow holder between steps is not mistaken for a stale one", () => {
    const lock = join(root(), "state.lock")
    acquire(lock)
    expect(ownerOf(lock).split(" ")[0]).toBe(String(process.pid))
    release(lock)
    expect(existsSync(lock)).toBe(false)
  })

  test("a dead holder's lock is taken over at once", () => {
    const lock = join(root(), "state.lock")
    expect(plant(lock, String(deadPid()))).toBe(true)
    const started = Date.now()
    acquire(lock, { waitMs: 5_000 })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(ownerOf(lock).split(" ")[0]).toBe(String(process.pid))
    release(lock)
  })

  test("release removes only this acquire's lock, never another holder's", () => {
    const lock = join(root(), "state.lock")
    acquire(lock)
    // Another holder's lock in its place (as after a takeover): this process's release leaves it.
    rmSync(lock, { recursive: true, force: true })
    const pid = sleeper()
    expect(plant(lock, String(pid))).toBe(true)
    release(lock)
    expect(ownerOf(lock)).toBe(String(pid))
  })

  test("eight processes taking the lock 60 times each, with dead holders' locks among them, never lose an update", async () => {
    const dir = root()
    const lock = join(dir, "state.lock")
    const counter = join(dir, "count")
    writeFileSync(counter, "0")
    // A dead holder's lock to start with: the first waiters race to take it over.
    expect(plant(lock, String(deadPid()))).toBe(true)
    const worker = join(dir, "worker.mjs")
    writeFileSync(
      worker,
      [
        `import { readFileSync, writeFileSync } from "node:fs"`,
        `import { acquire, release } from ${JSON.stringify(LOCK_MODULE)}`,
        `const [lock, counter] = process.argv.slice(2)`,
        `for (let i = 0; i < 60; i++) {`,
        `  acquire(lock)`,
        `  const n = Number(readFileSync(counter, "utf8"))`,
        `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, i % 7 === 0 ? 5 : 0)`,
        `  writeFileSync(counter, String(n + 1))`,
        `  release(lock)`,
        `}`,
      ].join("\n"),
    )
    const workers = Array.from({ length: 8 }, () => Bun.spawn(["node", worker, lock, counter], { stderr: "pipe" }))
    const codes = await Promise.all(workers.map((child) => child.exited))
    expect(codes).toEqual(Array(8).fill(0))
    expect(Number(readFileSync(counter, "utf8"))).toBe(480)
    expect(existsSync(lock)).toBe(false)
  }, 120_000)
})
