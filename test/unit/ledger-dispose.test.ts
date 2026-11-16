// Disposal (src/ports.ts `LedgerPort.dispose`, `ImportV0Port.dispose`): on plugin cleanup or reload no lock folder and
// no heartbeat survives, a write in flight finishes or leaves the old file, a waiting call is cancelled, and an import
// that was stopped part-way is run again cleanly by the next start.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { BoxdError } from "../../src/errors.js"
import { LedgerGate, runImport } from "../../src/import-v0.js"
import { LockSet, readOwner } from "../../src/ledger/lock.js"
import { Ledger } from "../../src/ledger/store.js"
import type { WorkRecord } from "../../src/ledger/types.js"
import { fakeImportBoxd, publishedContent, removeRoot, tempRoot, v0Root } from "../support/ledger-fakes.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) removeRoot(root)
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Every lock folder under `root`: work locks, the event log's, the import's. */
function lockFolders(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (/\.lock(\.|$)/.test(entry.name)) found.push(path)
      else walk(path)
    }
  }
  walk(root)
  return found
}

const record = (workId: string, over: Partial<WorkRecord> = {}): WorkRecord => ({
  format: 1,
  workId,
  state: "open",
  region: "fra",
  machine: `oc-${workId}`,
  machineId: null,
  size: "2x8",
  image: { name: "oc-golden-2.2.6-2x8", opencode: "2.2.6" },
  laptopDirectory: "/work/projects/api",
  guestDirectory: `/home/boxd/work/${workId}`,
  createdAt: "2026-11-15T10:00:00.000Z",
  guestHelper: "v1",
  ...over,
})

async function published(): Promise<string> {
  const root = tempRoot("boxd-dispose-")
  roots.push(root)
  await runImport({ root, boxd: fakeImportBoxd() })
  return root
}

describe("the ledger's dispose", () => {
  test("a write in flight finishes, a waiting one is cancelled, and no lock or heartbeat is left", async () => {
    const root = await published()
    const ledger = new Ledger(root, { lock: { heartbeatMs: 10 } })
    await ledger.mutate("alpha", () => record("alpha", { title: "before" }))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let entered!: () => void
    const inside = new Promise<void>((resolve) => (entered = resolve))
    const inFlight = ledger.mutate("alpha", async (current) => {
      entered()
      await gate
      return current && { ...current, title: "in flight" }
    })
    const waiting = ledger.mutate("alpha", (current) => current && { ...current, title: "waiting" })
    await inside
    expect(lockFolders(root)).toEqual([join(root, "v1", "works", "alpha", "work.lock")])

    const disposed = ledger.dispose(2_000)
    await sleep(30)
    release()
    await disposed
    expect((await inFlight)?.title).toBe("in flight")
    // The queued write started only after the stop, so it took no lock and changed nothing.
    const refused = await waiting.catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(BoxdError)
    expect((refused as BoxdError).code).toBe("CANCELLED")
    expect((await new Ledger(root).get("alpha"))?.title).toBe("in flight")
    expect(ledger.locks.size).toBe(0)

    // Several heartbeat intervals later, nothing has brought a lock folder back.
    await sleep(80)
    expect(lockFolders(root)).toEqual([])
    await expect(ledger.mutate("alpha", (current) => current)).rejects.toThrow(/^CANCELLED/)
    await expect(ledger.events.append({ workId: "alpha", from: null, to: "busy" })).rejects.toThrow(/^CANCELLED/)
  })

  test("a holder that does not finish within the grace still loses its lock, and its heartbeat stops", async () => {
    const root = await published()
    const ledger = new Ledger(root, { lock: { heartbeatMs: 10 } })
    await ledger.mutate("alpha", () => record("alpha"))
    let entered!: () => void
    const inside = new Promise<void>((resolve) => (entered = resolve))
    void ledger.withWork("alpha", async () => {
      entered()
      await new Promise(() => undefined)
    })
    await inside
    const lock = join(root, "v1", "works", "alpha", "work.lock")
    expect(existsSync(lock)).toBe(true)
    const started = Date.now()
    await ledger.dispose(100)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(existsSync(lock)).toBe(false)
    await sleep(80)
    expect(lockFolders(root)).toEqual([])
    // Another process takes the work at once, with no stale takeover to wait for.
    const other = new Ledger(root, { lockWaitMs: 0 })
    expect((await other.mutate("alpha", (current) => current && { ...current, title: "next" }))?.title).toBe("next")
  })

  test("a write whose recipe outlives the grace is dropped after the lock is released; the next instance's write stands (M-2)", async () => {
    const root = await published()
    const old = new Ledger(root, { lock: { heartbeatMs: 10 } })
    await old.mutate("alpha", () => record("alpha"))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let entered!: () => void
    const inside = new Promise<void>((resolve) => (entered = resolve))
    const late = old.mutate("alpha", async (current) => {
      entered()
      await gate
      return current && { ...current, model: "from-old-instance" }
    })
    await inside
    await old.dispose(100)
    // A reload: the new instance writes at once.
    await new Ledger(root, { lockWaitMs: 0 }).mutate("alpha", (current) => current && { ...current, reboots: [{ at: "new", why: "repair" }] })
    release()
    const refused = (await late.catch((error: unknown) => error)) as BoxdError
    expect(refused.code).toBe("CANCELLED")
    const final = await new Ledger(root).get("alpha")
    expect(final?.reboots).toEqual([{ at: "new", why: "repair" }])
    expect(final?.model).toBeUndefined()
  })

  test("LockSet: dispose refuses new locks and releases held ones", async () => {
    const root = tempRoot("boxd-lockset-")
    roots.push(root)
    const locks = new LockSet()
    const held = await locks.acquire(join(root, "a.lock"), { purpose: "a", heartbeatMs: 10 })
    const owner = await readOwner(join(root, "a.lock"))
    expect(owner?.token).toBe(held!.token)
    await locks.dispose(0)
    expect(existsSync(join(root, "a.lock"))).toBe(false)
    expect(await held!.holds()).toBe(false)
    await expect(locks.acquire(join(root, "b.lock"), { purpose: "b" })).rejects.toThrow(/^CANCELLED/)
    await sleep(50)
    expect(readdirSync(root)).toEqual([])
  })
})

describe("the import's dispose", () => {
  test("a run stopped mid-way releases import.lock, publishes nothing, and the next start imports cleanly", async () => {
    const root = v0Root("boxd-dispose-")
    roots.push(root)
    const reference = v0Root("boxd-dispose-ref-")
    roots.push(reference)
    await new LedgerGate({ root: reference, boxd: fakeImportBoxd() }).start()

    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let reached!: () => void
    const atRecord = new Promise<void>((resolve) => (reached = resolve))
    const gate = new LedgerGate({
      root,
      boxd: fakeImportBoxd(),
      lock: { heartbeatMs: 10 },
      onStep: async (step, progress) => {
        if (step === "record" && progress.done === 3) {
          reached()
          await held
        }
      },
    })
    const running = gate.start().catch((error: unknown) => error)
    await atRecord
    expect(existsSync(join(root, "import.lock"))).toBe(true)
    const disposed = gate.dispose(2_000)
    release()
    await disposed
    expect(((await running) as BoxdError).code).toBe("CANCELLED")
    expect(existsSync(join(root, "import.lock"))).toBe(false)
    expect(existsSync(join(root, "v1"))).toBe(false)
    await sleep(60)
    expect(lockFolders(root)).toEqual([])
    // A start after the stop does nothing on this gate.
    expect((await gate.start()).state).not.toBe("ready")

    const next = new LedgerGate({ root, boxd: fakeImportBoxd() })
    expect((await next.start()).state).toBe("ready")
    expect(publishedContent(root)).toEqual(publishedContent(reference))
    expect(readdirSync(root).filter((name) => name.startsWith("v1.importing-"))).toEqual([])
  })

  test("a run that never reaches its next step still loses the lock within the grace", async () => {
    const root = v0Root("boxd-dispose-")
    roots.push(root)
    let reached!: () => void
    const atRecord = new Promise<void>((resolve) => (reached = resolve))
    const gate = new LedgerGate({
      root,
      boxd: fakeImportBoxd(),
      lock: { heartbeatMs: 10 },
      onStep: async (step) => {
        if (step === "record") {
          reached()
          await new Promise(() => undefined)
        }
      },
    })
    void gate.start()
    await atRecord
    const lock = join(root, "import.lock")
    const mtime = statSync(lock).mtimeMs
    expect(mtime).toBeGreaterThan(0)
    await gate.dispose(50)
    expect(existsSync(lock)).toBe(false)
    await sleep(60)
    expect(existsSync(lock)).toBe(false)
    // The stuck run can never publish: its token is gone. A new process imports at once.
    expect((await new LedgerGate({ root, boxd: fakeImportBoxd() }).start()).state).toBe("ready")
  })
})
