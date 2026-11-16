// The v1 ledger (design §2.2, §7.1 "Ledger"): copy-on-write records and files, the cross-process work lock, the index
// refreshed by mtime, `saved` computed, and the untracked swap that a crash cannot leave half done.
import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BoxdError } from "../../src/errors.js"
import { runImport } from "../../src/import-v0.js"
import { acquireLock, readOwner } from "../../src/ledger/lock.js"
import { Ledger, savedState, withoutUserinfo } from "../../src/ledger/store.js"
import type { WorkRecord } from "../../src/ledger/types.js"
import type { MachineId } from "../../src/ports.js"
import { fakeImportBoxd, removeRoot, tempRoot } from "../support/ledger-fakes.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) removeRoot(root)
})

/** A published, empty v1 ledger: the import's own path with no v0 ledger. */
async function emptyLedger(options: ConstructorParameters<typeof Ledger>[1] = {}): Promise<Ledger> {
  const root = tempRoot("boxd-ledger-")
  roots.push(root)
  expect(await runImport({ root, boxd: fakeImportBoxd() })).toEqual({ state: "published" })
  return new Ledger(root, options)
}

/**
 * Every test that calls `emptyLedger` runs a full `runImport`, with its fsyncs: bun's 5 s default is too short on a
 * loaded machine, and a test cut short leaves its import running into the root `afterEach` deletes.
 */
const LEDGER_TEST_TIMEOUT_MS = 30_000

const record = (workId: string, over: Partial<WorkRecord> = {}): WorkRecord => ({
  format: 1,
  workId,
  state: "open",
  region: "fra",
  machine: `oc-${workId}`,
  machineId: `vm_${workId}` as MachineId,
  size: "2x8",
  image: { name: "oc-golden-2.2.6-2x8", opencode: "2.2.6" },
  laptopDirectory: "/work/projects/api",
  guestDirectory: `/home/boxd/work/${workId}`,
  createdAt: "2026-11-15T10:00:00.000Z",
  guestHelper: "v1",
  ...over,
})

const sha = (body: string | Buffer) => createHash("sha256").update(body).digest("hex")

const child = (...args: string[]) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    const proc = spawn("bun", [join(import.meta.dir, "..", "support", "ledger-child.ts"), ...args], { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    proc.stdout.on("data", (chunk) => (out += chunk))
    proc.stderr.on("data", (chunk) => (out += chunk))
    proc.on("close", (code, signal) => resolve({ code: code ?? (signal ? 137 : 1), out }))
  })

describe("saved is computed", () => {
  const saved = { at: "2026-11-15T11:00:00.000Z", complete: true, guestVersion: "2.2.6", sessions: [] }
  test("none, fresh, stale after a later prompt, stale when partial", () => {
    expect(savedState({})).toBe("none")
    expect(savedState({ saved })).toBe("fresh")
    expect(savedState({ saved, lastSubmit: { at: "2026-11-15T10:59:59.000Z", delivery: "steer" } })).toBe("fresh")
    expect(savedState({ saved, lastSubmit: { at: "2026-11-15T11:00:00.000Z", delivery: "steer" } })).toBe("fresh")
    expect(savedState({ saved, lastSubmit: { at: "2026-11-15T11:00:01.000Z", delivery: "queue" } })).toBe("stale")
    expect(savedState({ saved: { ...saved, complete: false } })).toBe("stale")
  })

  test("a remote loses its userinfo, and only that", () => {
    expect(withoutUserinfo("https://x-access-token:ghs_abc@github.com/o/r.git")).toBe("https://github.com/o/r.git")
    expect(withoutUserinfo("https://github.com/o/r")).toBe("https://github.com/o/r")
    expect(withoutUserinfo("git@github.com:o/r.git")).toBe("git@github.com:o/r.git")
  })
})

describe("records", () => {
  test("the import publishes v1 whole, with its complete marker", async () => {
    const root = tempRoot("boxd-ledger-")
    roots.push(root)
    await runImport({ root, boxd: fakeImportBoxd() })
    expect(existsSync(join(root, "v1", "complete"))).toBe(true)
    expect(new Ledger(root).dir).toBe(join(root, "v1"))
  }, LEDGER_TEST_TIMEOUT_MS)

  test("mutate writes a new file each time, 0600 in 0700 folders, and leaves no temp file", async () => {
    const ledger = await emptyLedger()
    const first = await ledger.mutate("alpha", () => record("alpha"))
    expect(first?.workId).toBe("alpha")
    const path = ledger.recordPath("alpha")
    const before = statSync(path)
    expect(before.mode & 0o777).toBe(0o600)
    expect(statSync(ledger.workDir("alpha")).mode & 0o777).toBe(0o700)
    expect(statSync(ledger.dir).mode & 0o777).toBe(0o700)
    await ledger.mutate("alpha", (current) => current && { ...current, model: "anthropic/claude-sonnet-4-5" })
    expect(statSync(path).ino).not.toBe(before.ino)
    expect(readdirSync(ledger.workDir("alpha"))).toEqual(["work.json"])
    expect((await ledger.get("alpha"))?.model).toBe("anthropic/claude-sonnet-4-5")
  }, LEDGER_TEST_TIMEOUT_MS)

  test("copy-on-write: a hard link to the record keeps the old bytes", async () => {
    const ledger = await emptyLedger()
    await ledger.mutate("alpha", () => record("alpha"))
    const link = join(ledger.root, "linked.json")
    linkSync(ledger.recordPath("alpha"), link)
    const old = readFileSync(link)
    await ledger.mutate("alpha", (current) => current && { ...current, title: "changed" })
    expect(readFileSync(link)).toEqual(old)
    expect(JSON.parse(readFileSync(ledger.recordPath("alpha"), "utf8")).title).toBe("changed")
  }, LEDGER_TEST_TIMEOUT_MS)

  test("a crash between the temp write and the rename leaves the old record; the temp file is swept", async () => {
    const ledger = await emptyLedger()
    await ledger.mutate("alpha", () => record("alpha", { title: "old" }))
    // What a crash leaves: a finished temp file beside the record, never renamed, from a process that is gone.
    const dead = spawn("true")
    await new Promise((resolve) => dead.on("close", resolve))
    const temp = join(ledger.workDir("alpha"), `.work.json.${dead.pid}.0123456789ab.tmp`)
    writeFileSync(temp, JSON.stringify(record("alpha", { title: "new" })))
    const fresh = new Ledger(ledger.root)
    expect((await fresh.get("alpha"))?.title).toBe("old")
    expect((await fresh.list()).map((item) => item.title)).toEqual(["old"])
    await fresh.sweepTemps("alpha")
    expect(existsSync(temp)).toBe(false)
  }, LEDGER_TEST_TIMEOUT_MS)

  test("a recipe that throws or returns undefined writes nothing, and a lock for a work never written leaves no folder", async () => {
    const ledger = await emptyLedger()
    await expect(ledger.mutate("alpha", () => Promise.reject(new Error("no")))).rejects.toThrow("no")
    expect(await ledger.mutate("beta", () => undefined)).toBeUndefined()
    expect(existsSync(ledger.workDir("alpha"))).toBe(false)
    expect(existsSync(ledger.workDir("beta"))).toBe(false)
  }, LEDGER_TEST_TIMEOUT_MS)

  test("a record for another id or format is refused", async () => {
    const ledger = await emptyLedger()
    await expect(ledger.mutate("alpha", () => record("beta"))).rejects.toThrow(/LEDGER_FAILED/)
    await expect(ledger.mutate("Bad_Id", () => record("Bad_Id"))).rejects.toThrow(/NAME_INVALID/)
  }, LEDGER_TEST_TIMEOUT_MS)
})

describe("the index", () => {
  test("refreshes only records whose mtime changed, and never reads an unchanged closed work", async () => {
    const ledger = await emptyLedger()
    await ledger.mutate("open-one", () => record("open-one"))
    await ledger.mutate("closed-one", () => record("closed-one", { state: "closed", closed: { at: "2026-11-15T12:00:00.000Z", how: "dropped" } }))
    // A whole-second mtime, so the test can put it back exactly after changing the bytes.
    const closedPath = ledger.recordPath("closed-one")
    utimesSync(closedPath, 1_763_200_000, 1_763_200_000)
    const index = await ledger.refresh()
    expect(index.works["open-one"]).toMatchObject({ state: "open", region: "fra", phase: null, saved: "none" })
    expect(index.works["closed-one"]).toMatchObject({ state: "closed", phase: "closed" })
    expect(JSON.parse(readFileSync(join(ledger.dir, "index.json"), "utf8")).works["closed-one"].state).toBe("closed")

    // A new process: it reads index.json. The closed record's file is made unreadable JSON with the same mtime: it is
    // not read for a default list, so nothing fails; with closed works asked for, it is read and fails.
    writeFileSync(closedPath, "{ not json")
    utimesSync(closedPath, 1_763_200_000, 1_763_200_000)
    const fresh = new Ledger(ledger.root)
    expect((await fresh.list()).map((item) => item.workId)).toEqual(["open-one"])
    await expect(fresh.list({ closed: true })).rejects.toThrow(/LEDGER_FAILED/)

    // A record changed by another process is read again.
    const other = new Ledger(ledger.root)
    await other.mutate("open-one", (current) => current && { ...current, region: "nyc" })
    expect((await fresh.refresh()).works["open-one"]?.region).toBe("nyc")
  }, LEDGER_TEST_TIMEOUT_MS)

  test("the watcher's phase is kept in the index; a removed work leaves it", async () => {
    const ledger = await emptyLedger()
    await ledger.mutate("alpha", () => record("alpha"))
    await ledger.refresh()
    await ledger.setPhase("alpha", "busy")
    expect((await ledger.refresh()).works.alpha?.phase).toBe("busy")
    removeRoot(ledger.workDir("alpha"))
    expect((await ledger.refresh()).works.alpha).toBeUndefined()
  }, LEDGER_TEST_TIMEOUT_MS)
})

describe("files: the last good export survives (M-a)", () => {
  test("a staged export with the wrong size or digest keeps the stored one byte for byte and leaves no temp file", async () => {
    const ledger = await emptyLedger()
    await ledger.mutate("alpha", () => record("alpha"))
    const target = ledger.exportPath("alpha", "ses_root")
    const good = '{"info":{"id":"ses_root"},"messages":[]}\n'
    const first = await ledger.stageFile("alpha", "exports/ses_root.json")
    expect(first.path).toMatch(/exports\/ses_root\.json\.[0-9]+-[0-9a-f]{12}\.tmp$/)
    writeFileSync(first.path, good)
    await ledger.commitStaged(first, { bytes: good.length, sha256: sha(good) })
    const link = join(ledger.root, "export-link.json")
    linkSync(target, link)

    // Cut off half-way: fewer bytes than the guest reported.
    const newer = '{"info":{"id":"ses_root","title":"new"},"messages":[1]}\n'
    const cut = await ledger.stageFile("alpha", "exports/ses_root.json")
    writeFileSync(cut.path, newer.slice(0, 10))
    await expect(ledger.commitStaged(cut, { bytes: newer.length, sha256: sha(newer) })).rejects.toThrow(/EXPORT_INVALID/)
    // The right size, the wrong digest.
    const wrong = await ledger.stageFile("alpha", "exports/ses_root.json")
    writeFileSync(wrong.path, newer.replace("new", "bad"))
    await expect(ledger.commitStaged(wrong, { bytes: newer.length, sha256: sha(newer) })).rejects.toThrow(/EXPORT_INVALID/)
    // A copy that failed is discarded by the caller.
    const failed = await ledger.stageFile("alpha", "exports/ses_root.json")
    await ledger.discard(failed)
    expect(readFileSync(target, "utf8")).toBe(good)
    expect(readdirSync(join(ledger.workDir("alpha"), "exports"))).toEqual(["ses_root.json"])

    // A verified one replaces it, and the hard link to the old file still holds the old bytes.
    const right = await ledger.stageFile("alpha", "exports/ses_root.json")
    writeFileSync(right.path, newer)
    expect(await ledger.commitStaged(right, { bytes: newer.length, sha256: sha(newer) })).toEqual({ bytes: newer.length, sha256: sha(newer) })
    expect(readFileSync(target, "utf8")).toBe(newer)
    expect(readFileSync(link, "utf8")).toBe(good)
    expect(statSync(target).mode & 0o777).toBe(0o600)
  }, LEDGER_TEST_TIMEOUT_MS)

  test("only the files a harvest writes, and only paths the ledger staged, are accepted", async () => {
    const ledger = await emptyLedger()
    await expect(ledger.stageFile("alpha", "work.json" as never)).rejects.toThrow(/LEDGER_FAILED/)
    await expect(ledger.stageFile("alpha", "exports/../../x.json" as never)).rejects.toThrow(/LEDGER_FAILED/)
    const staged = await ledger.stageFile("alpha", "patch.diff")
    const forged = { ...staged, path: join(ledger.workDir("alpha"), "exports", "..", "..", "beta", "patch.diff.0123456789ab.tmp") }
    await expect(ledger.commitStaged(forged, { bytes: 0, sha256: sha("") })).rejects.toThrow(/LEDGER_FAILED/)
    await expect(ledger.commitStaged({ ...staged, path: `${staged.path}x` }, { bytes: 0, sha256: sha("") })).rejects.toThrow(/LEDGER_FAILED/)
    await ledger.commitStaged(staged, { bytes: 0, sha256: sha("") })
    expect(readFileSync(ledger.patchPath("alpha"), "utf8")).toBe("")
  }, LEDGER_TEST_TIMEOUT_MS)

  test("untracked/ is swapped whole after a verified staging; a crash between the two renames gets the old set back", async () => {
    const ledger = await emptyLedger()
    await ledger.mutate("alpha", () => record("alpha"))
    const first = await ledger.stageFolder("alpha")
    expect(first.path).toMatch(/untracked\.[0-9]+-[0-9a-f]{12}\.tmp$/)
    mkdirSync(join(first.path, "notes"))
    writeFileSync(join(first.path, "notes", "a.txt"), "one")
    await ledger.commitFolder(first, { "notes/a.txt": { bytes: 3, sha256: sha("one") } })
    expect(readFileSync(join(ledger.untrackedDir("alpha"), "notes", "a.txt"), "utf8")).toBe("one")

    // A staged set that is missing a file, or holds one more, or a different one: the stored set stays.
    for (const [files, expected] of [
      [{ "b.txt": "two" }, { "b.txt": { bytes: 3, sha256: sha("two") }, "c.txt": { bytes: 1, sha256: sha("c") } }],
      [{ "b.txt": "two", "x.txt": "x" }, { "b.txt": { bytes: 3, sha256: sha("two") } }],
      [{ "b.txt": "TWO" }, { "b.txt": { bytes: 3, sha256: sha("two") } }],
    ] as const) {
      const staged = await ledger.stageFolder("alpha")
      for (const [name, body] of Object.entries(files)) writeFileSync(join(staged.path, name), body)
      await expect(ledger.commitFolder(staged, expected)).rejects.toThrow(/EXPORT_INVALID/)
      expect(existsSync(staged.path)).toBe(false)
    }
    expect(readdirSync(ledger.untrackedDir("alpha"))).toEqual(["notes"])

    // A crash after the old set was moved aside and before the new one was renamed in.
    const second = await ledger.stageFolder("alpha")
    writeFileSync(join(second.path, "b.txt"), "two")
    renameSync(ledger.untrackedDir("alpha"), join(ledger.workDir("alpha"), "untracked.old-crash"))
    await ledger.recoverUntracked("alpha")
    expect(readdirSync(ledger.untrackedDir("alpha"))).toEqual(["notes"])
    // A stage of a live process is never swept: it may still be filled and committed.
    expect(existsSync(second.path)).toBe(true)
    await ledger.discard(second)

    const third = await ledger.stageFolder("alpha")
    writeFileSync(join(third.path, "c.txt"), "three")
    await ledger.commitFolder(third, { "c.txt": { bytes: 5, sha256: sha("three") } })
    expect(readdirSync(ledger.untrackedDir("alpha"))).toEqual(["c.txt"])
    expect(readdirSync(ledger.workDir("alpha")).sort()).toEqual(["untracked", "work.json"])
  }, LEDGER_TEST_TIMEOUT_MS)
})

describe("two harvests of one work at once", () => {
  test("committing one staged untracked set never deletes the other one mid-fill; each commit swaps in its own", async () => {
    const ledger = await emptyLedger()
    await ledger.mutate("alpha", () => record("alpha"))
    const a = await ledger.stageFolder("alpha")
    const b = await ledger.stageFolder("alpha")
    expect(a.path).not.toBe(b.path)
    // A is half filled when B commits.
    writeFileSync(join(a.path, "a1.txt"), "a1")
    writeFileSync(join(b.path, "b.txt"), "b")
    await ledger.commitFolder(b, { "b.txt": { bytes: 1, sha256: sha("b") } })
    expect(readdirSync(ledger.untrackedDir("alpha"))).toEqual(["b.txt"])
    expect(readdirSync(a.path)).toEqual(["a1.txt"])
    writeFileSync(join(a.path, "a2.txt"), "a2")
    await ledger.commitFolder(a, { "a1.txt": { bytes: 2, sha256: sha("a1") }, "a2.txt": { bytes: 2, sha256: sha("a2") } })
    expect(readdirSync(ledger.untrackedDir("alpha")).sort()).toEqual(["a1.txt", "a2.txt"])
    expect(readdirSync(ledger.workDir("alpha")).sort()).toEqual(["untracked", "work.json"])
  }, LEDGER_TEST_TIMEOUT_MS)

  test("the same for staged exports, and a crashed process's leftovers are swept", async () => {
    const ledger = await emptyLedger()
    await ledger.mutate("alpha", () => record("alpha"))
    const a = await ledger.stageFile("alpha", "patch.diff")
    const b = await ledger.stageFile("alpha", "patch.diff")
    writeFileSync(b.path, "b")
    await ledger.commitStaged(b, { bytes: 1, sha256: sha("b") })
    expect(existsSync(a.path)).toBe(true)
    writeFileSync(a.path, "a")
    await ledger.commitStaged(a, { bytes: 1, sha256: sha("a") })
    expect(readFileSync(ledger.patchPath("alpha"), "utf8")).toBe("a")

    // Leftovers of a process that is gone: a staged set and a staged file.
    const dead = spawn("true")
    await new Promise((resolve) => dead.on("close", resolve))
    const leftSet = join(ledger.workDir("alpha"), `untracked.${dead.pid}-0123456789ab.tmp`)
    const leftFile = join(ledger.workDir("alpha"), `patch.diff.${dead.pid}-0123456789ab.tmp`)
    mkdirSync(leftSet)
    writeFileSync(leftFile, "x")
    const live = await ledger.stageFolder("alpha")
    await ledger.recoverUntracked("alpha")
    expect(existsSync(leftSet)).toBe(false)
    expect(existsSync(live.path)).toBe(true)
    await ledger.sweepTemps("alpha")
    expect(existsSync(leftFile)).toBe(false)
  }, LEDGER_TEST_TIMEOUT_MS)
})

describe("the fence: no write lands after its lock is lost (M-2)", () => {
  test("a holder whose lock was taken over has its record write dropped; the new holder's change stands", async () => {
    const ledger = await emptyLedger()
    await ledger.mutate("alpha", () => record("alpha"))
    // A holder whose heartbeat stalls (a laptop asleep mid-call): 300 ms makes it stale here.
    const stalled = new Ledger(ledger.root, { lock: { heartbeatMs: 60_000, staleMs: 300 } })
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let entered!: () => void
    const inside = new Promise<void>((resolve) => (entered = resolve))
    const late = stalled.mutate("alpha", async (current) => {
      entered()
      await gate
      return current && { ...current, model: "from-A" }
    })
    await inside
    await new Promise((resolve) => setTimeout(resolve, 350))
    const other = new Ledger(ledger.root, { lock: { staleMs: 300 } })
    await other.mutate("alpha", (current) => current && { ...current, reboots: [{ at: "B", why: "repair" }] })
    release()
    const refused = (await late.catch((error: unknown) => error)) as BoxdError
    expect(refused).toBeInstanceOf(BoxdError)
    expect(refused.code).toBe("LEDGER_LOCKED")
    const final = await new Ledger(ledger.root).get("alpha")
    expect(final?.reboots).toEqual([{ at: "B", why: "repair" }])
    expect(final?.model).toBeUndefined()
    expect(readdirSync(ledger.workDir("alpha"))).toEqual(["work.json"])
  }, LEDGER_TEST_TIMEOUT_MS)

  test("the same for a staged export and an untracked swap", async () => {
    const ledger = await emptyLedger()
    await ledger.mutate("alpha", () => record("alpha"))
    const stalled = new Ledger(ledger.root, { lock: { heartbeatMs: 60_000, staleMs: 300 } })
    const staged = await stalled.stageFile("alpha", "patch.diff")
    writeFileSync(staged.path, "late")
    const folder = await stalled.stageFolder("alpha")
    writeFileSync(join(folder.path, "late.txt"), "late")
    const outcome = await stalled.withWork("alpha", async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
      await new Ledger(ledger.root, { lock: { staleMs: 300 } }).mutate("alpha", (current) => current && { ...current, title: "B" })
      const file = await stalled.commitStaged(staged, { bytes: 4, sha256: sha("late") }).catch((error: unknown) => (error as BoxdError).code)
      const swap = await stalled.commitFolder(folder, { "late.txt": { bytes: 4, sha256: sha("late") } }).catch((error: unknown) => (error as BoxdError).code)
      return [file, swap]
    }).catch((error: unknown) => error)
    expect(outcome).toEqual(["LEDGER_LOCKED", "LEDGER_LOCKED"])
    expect(existsSync(ledger.patchPath("alpha"))).toBe(false)
    expect(existsSync(ledger.untrackedDir("alpha"))).toBe(false)
    expect(existsSync(staged.path)).toBe(false)
    expect(existsSync(folder.path)).toBe(false)
    expect((await ledger.get("alpha"))?.title).toBe("B")
  }, LEDGER_TEST_TIMEOUT_MS)
})

describe("one writer per work, across processes", () => {
  test("two processes writing one work lose nothing", async () => {
    const ledger = await emptyLedger()
    await ledger.mutate("shared", () => record("shared"))
    const [a, b] = await Promise.all([child("mutate", ledger.root, "shared", "a", "25"), child("mutate", ledger.root, "shared", "b", "25"), ledger.mutate("shared", (c) => c && { ...c, title: "parent" })])
    expect([a.out.trim(), b.out.trim()]).toEqual(["ok", "ok"])
    const final = await new Ledger(ledger.root).get("shared")
    const tags = (final?.reboots ?? []).map((item) => item.at)
    expect(tags).toHaveLength(50)
    expect(new Set(tags).size).toBe(50)
    expect(final?.title).toBe("parent")
  }, 60_000)

  test("two processes taking two works' locks in opposite order both finish (sorted order)", async () => {
    const ledger = await emptyLedger()
    await ledger.mutate("left", () => record("left"))
    await ledger.mutate("right", () => record("right"))
    const results = await Promise.all([child("pair", ledger.root, "left", "right", "10"), child("pair", ledger.root, "right", "left", "10")])
    expect(results.map((item) => item.out.trim())).toEqual(["ok", "ok"])
    const fresh = new Ledger(ledger.root)
    expect((await fresh.get("left"))?.reboots).toHaveLength(20)
    expect((await fresh.get("right"))?.reboots).toHaveLength(20)
  }, 60_000)

  test("a live lock answers LEDGER_LOCKED after the wait; a stale one is taken over; a dead holder's at once", async () => {
    const ledger = await emptyLedger({ lockWaitMs: 200 })
    await ledger.mutate("alpha", () => record("alpha"))
    const lockPath = join(ledger.workDir("alpha"), "work.lock")
    const held = await acquireLock(lockPath, { purpose: "test" })
    const other = new Ledger(ledger.root, { lockWaitMs: 200 })
    const refused = await other.mutate("alpha", (c) => c && { ...c, title: "x" }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(BoxdError)
    expect((refused as BoxdError).code).toBe("LEDGER_LOCKED")
    await held!.release()

    // Stale: a heartbeat older than 60 s, from a process that is still alive (this one).
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "old", pid: process.pid, host: "elsewhere", at: Date.now() - 120_000, purpose: "test" }))
    await other.mutate("alpha", (c) => c && { ...c, title: "after-stale" })
    expect((await other.get("alpha"))?.title).toBe("after-stale")

    // Dead: a fresh heartbeat from a process on this host that no longer exists.
    const dead = spawn("true")
    await new Promise((resolve) => dead.on("close", resolve))
    const { hostname } = await import("node:os")
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "dead", pid: dead.pid, host: hostname(), at: Date.now(), purpose: "test" }))
    await other.mutate("alpha", (c) => c && { ...c, title: "after-dead" })
    expect((await other.get("alpha"))?.title).toBe("after-dead")
    expect(existsSync(lockPath)).toBe(false)
  }, LEDGER_TEST_TIMEOUT_MS)

  test("a holder whose lock was taken over knows it", async () => {
    const root = tempRoot("boxd-lock-")
    roots.push(root)
    const path = join(root, "x.lock")
    let now = 1_000_000
    const first = await acquireLock(path, { purpose: "a", now: () => now, heartbeatMs: 60_000 })
    expect(await first!.holds()).toBe(true)
    now += 61_000
    const second = await acquireLock(path, { purpose: "b", now: () => now })
    expect(second).not.toBeNull()
    expect(await first!.holds()).toBe(false)
    expect((await readOwner(path))?.token).toBe(second!.token)
    // Releasing a lock that is no longer ours leaves the new owner's in place.
    await first!.release()
    expect((await readOwner(path))?.token).toBe(second!.token)
    await second!.release()
    expect(existsSync(path)).toBe(false)
  }, LEDGER_TEST_TIMEOUT_MS)

  test("a stale holder's late heartbeat and release never touch its successor's lock (LOW-1)", async () => {
    const root = tempRoot("boxd-lock-")
    roots.push(root)
    const path = join(root, "x.lock")
    // A's clock is far behind, so its lock is stale to everyone else from the start; its heartbeat keeps running.
    const first = await acquireLock(path, { purpose: "a", now: () => 1_000, heartbeatMs: 5 })
    const second = await acquireLock(path, { purpose: "b" })
    expect(second).not.toBeNull()
    const ownerFile = readFileSync(join(path, "owner.json"), "utf8")
    // A late heartbeat from A lands as its own beat file only: B's owner and its freshness are unchanged.
    writeFileSync(join(path, `beat-${first!.token}.json`), JSON.stringify({ at: Date.now() + 1_000_000 }))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(readFileSync(join(path, "owner.json"), "utf8")).toBe(ownerFile)
    expect((await readOwner(path))?.token).toBe(second!.token)
    expect(await second!.holds()).toBe(true)
    expect(first!.lost).toBe(true)
    await first!.release()
    expect(await second!.holds()).toBe(true)
    await second!.release()
    expect(existsSync(path)).toBe(false)
  }, LEDGER_TEST_TIMEOUT_MS)

  test("within one process the queue serialises writers, and the lock is re-entrant", async () => {
    const ledger = await emptyLedger()
    await ledger.mutate("alpha", () => record("alpha"))
    await Promise.all(Array.from({ length: 20 }, (_, index) => ledger.mutate("alpha", (c) => c && { ...c, reboots: [...(c.reboots ?? []), { at: String(index), why: "repair" }] })))
    expect((await ledger.get("alpha"))?.reboots).toHaveLength(20)
    const nested = await ledger.withWork("alpha", () => ledger.mutate("alpha", (c) => c && { ...c, title: "nested" }))
    expect(nested?.title).toBe("nested")
  }, LEDGER_TEST_TIMEOUT_MS)
})
