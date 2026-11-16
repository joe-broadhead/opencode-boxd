// The v0 import (design §6, §7.1 "v0 import" and "Import crash safety"): a ledger written by v0.0.6's and v0.0.0's own
// code (test/fixtures/v0-ledger) is imported field for field, the v0 files stay byte-identical, no v1 file shares an
// inode with a v0 file, a corrupt record blocks only its own id, and the gate answers LEDGER_IMPORTING until the ledger
// is published whole.
import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BoxdError } from "../../src/errors.js"
import { ADOPT_COMMAND, adoptV0, LedgerGate, parseV0Phase, readReport, runImport, v0Phase, V0_HELPER_PATH, type ImportStep } from "../../src/import-v0.js"
import { digestFile } from "../../src/ledger/fsx.js"
import { acquireLock } from "../../src/ledger/lock.js"
import type { CompleteMarker, WorkRecord } from "../../src/ledger/types.js"
import type { ChangeTarget, ReadTarget } from "../../src/ports.js"
import { contentOf, fakeImportBoxd, idOf, publishedContent, readTree, removeRoot, v0Root, tempRoot } from "../support/ledger-fakes.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) removeRoot(root)
})
const fixtureRoot = () => {
  const root = v0Root()
  roots.push(root)
  return root
}

const v0Tree = (root: string) => readTree(join(root, "works"), (path) => path.startsWith("README-MOVED-TO-v1"))
const fileTime = (root: string, workId: string) => new Date(statSync(join(root, "works", workId, "work.json")).mtimeMs).toISOString()
const marks = async (root: string, workId: string, id: string, messages: number, parentId: string | null = null) => {
  const digest = await digestFile(join(root, "works", workId, "exports", `${id}.json`))
  return { id, parentId, sha256: digest.sha256, bytes: digest.bytes, lastMessageId: `msg_${id.slice(4)}_${String(messages - 1).padStart(3, "0")}`, messages, updated: 1_763_200_000_000 + messages * 1000 }
}
const git = (over: Record<string, unknown> = {}) => ({
  known: true,
  remote: "https://github.com/acme/api.git",
  branch: "main",
  sha: "0123456789abcdef0123456789abcdef01234567",
  dirty: false,
  patchStored: false,
  untracked: [],
  ignored: [],
  untrackedStored: false,
  ...over,
})
const base = (workId: string, over: Partial<WorkRecord>): WorkRecord => ({
  format: 1,
  workId,
  state: "open",
  region: "fra",
  machine: `oc-${workId}`,
  machineId: idOf(`oc-${workId}`, "fra"),
  size: "2x8",
  image: { name: "opencode-golden", opencode: null },
  laptopDirectory: "/work/projects/api",
  guestDirectory: `/home/boxd/work/${workId}`,
  createdAt: "",
  guestHelper: "v0",
  importedFrom: "v0",
  ...over,
})

/** What §6.2 says each fixture record becomes, field for field. */
async function expected(root: string): Promise<Record<string, WorkRecord>> {
  return {
    "proven-fresh": base("proven-fresh", {
      size: "4x16",
      repo: { url: "https://github.com/acme/api" },
      model: "anthropic/claude-sonnet-4-5",
      createdAt: "2025-11-14T09:59:00.000Z",
      session: { rootId: "ses_freshroot" },
      lastSubmit: { at: "2025-11-14T10:00:00.000Z", delivery: "steer" },
      saved: {
        at: "2025-11-14T11:00:00.000Z",
        complete: true,
        guestVersion: "2.2.6",
        sessions: [await marks(root, "proven-fresh", "ses_freshroot", 6), await marks(root, "proven-fresh", "ses_freshchild", 3, "ses_freshroot")],
      },
      run: { outcome: "completed", at: "2025-11-14T11:00:00.000Z" },
      gitState: git({ dirty: true, patchStored: true, untracked: ["notes/todo.md", "data.bin"], untrackedStored: true }),
      files: {
        in: [{ path: "spec.md", bytes: 12, sha256: "a".repeat(64), at: "2025-11-14T09:59:00.000Z" }],
        out: [{ path: "out/report.md", bytes: 34, sha256: "b".repeat(64), at: "2025-11-14T11:01:00.000Z", laptopPath: "/work/projects/api/out/report.md" }],
      },
      laptopCopy: "unverified",
    }),
    "proven-stale": base("proven-stale", {
      region: "nyc",
      machineId: idOf("oc-proven-stale", "nyc"),
      createdAt: "2025-11-14T12:00:00.000Z",
      session: { rootId: "ses_staleroot" },
      lastSubmit: { at: "2025-11-14T12:30:00.000Z", delivery: "steer" },
      saved: { at: "2025-11-14T12:00:00.000Z", complete: true, guestVersion: "2.2.6", sessions: [await marks(root, "proven-stale", "ses_staleroot", 4)] },
      run: { outcome: "completed", at: "2025-11-14T12:00:00.000Z" },
      gitState: git(),
      laptopCopy: "unverified",
    }),
    "never-prompted": base("never-prompted", { size: "1x4", laptopDirectory: "/work/projects/web", createdAt: fileTime(root, "never-prompted") }),
    "dropped-work": base("dropped-work", {
      state: "closed",
      closed: { at: fileTime(root, "dropped-work"), how: "dropped" },
      region: null,
      machineId: null,
      createdAt: "2025-11-13T08:00:00.000Z",
      session: { rootId: "ses_droproot" },
      lastSubmit: { at: "2025-11-13T08:00:00.000Z", delivery: "steer" },
      saved: { at: "2025-11-13T09:00:00.000Z", complete: true, guestVersion: "2.2.5", sessions: [await marks(root, "dropped-work", "ses_droproot", 2)] },
      gitState: git(),
      laptopCopy: "unverified",
    }),
    "pending-create": base("pending-create", { region: null, machineId: null, createdAt: "2025-11-14T13:00:00.000Z", pendingCreate: { at: "2025-11-14T13:00:00.000Z", image: "opencode-golden" } }),
    "slept-work": base("slept-work", {
      size: "8x32",
      createdAt: "2025-11-14T14:00:00.000Z",
      session: { rootId: "ses_sleptroot" },
      lastSubmit: { at: "2025-11-14T14:00:00.000Z", delivery: "steer" },
      run: { outcome: "failed", error: "APIError: 401 Unauthorized", at: "2025-11-14T14:05:00.000Z" },
      slept: { at: "2025-11-14T14:10:00.000Z", by: "boxd_sleep" },
      warnings: [{ code: "UNHARVESTED_SLEEP", at: "2025-11-14T14:10:00.000Z" }],
    }),
    "empty-proof": base("empty-proof", { createdAt: "2025-11-14T15:00:00.000Z", saved: { at: "2025-11-14T15:00:00.000Z", complete: true, guestVersion: "2.2.6", sessions: [] }, gitState: git() }),
    "old-shape": base("old-shape", {
      laptopDirectory: "/work/projects/old",
      repo: { url: "https://github.com/acme/old" },
      createdAt: "2025-11-10T10:00:00.000Z",
      session: { rootId: "ses_oldroot" },
      lastSubmit: { at: "2025-11-10T10:00:00.000Z", delivery: "steer" },
      saved: { at: "2025-11-10T11:00:00.000Z", complete: true, guestVersion: "2.2.3", sessions: [await marks(root, "old-shape", "ses_oldroot", 2)] },
      run: { outcome: "aborted", at: "2025-11-10T11:00:00.000Z" },
      gitState: git({ known: false, remote: null, branch: null, sha: null }),
      laptopCopy: "unverified",
    }),
    "laptop-id": base("laptop-id", {
      machineId: null,
      createdAt: "2025-11-14T16:00:00.000Z",
      session: { rootId: "ses_remoteroot" },
      lastSubmit: { at: "2025-11-14T16:00:00.000Z", delivery: "steer" },
      saved: { at: "2025-11-14T16:30:00.000Z", complete: true, guestVersion: "2.2.6", sessions: [{ ...(await marks(root, "laptop-id", "ses_remoteroot", 2)), laptopId: "ses_laptoproot" }] },
      gitState: git(),
      laptopCopy: "unverified",
    }),
  }
}

const BLOCKED = ["corrupt-work", "missing-export"]

describe("the v0 import, field for field", () => {
  test("every record maps as §6.2 says, its files are copied, and the v0 tree is untouched apart from the note", async () => {
    const root = fixtureRoot()
    const before = v0Tree(root)
    const boxd = fakeImportBoxd()
    const gate = new LedgerGate({ root, boxd })
    expect(await gate.start()).toEqual({ state: "ready", works: 9, errors: 2, blocked: BLOCKED })
    const ledger = await gate.ledger()

    const want = await expected(root)
    for (const [workId, record] of Object.entries(want)) expect({ workId, record: await ledger.get(workId) }).toEqual({ workId, record })
    expect((await ledger.list({ closed: true })).map((item) => item.workId)).toEqual(Object.keys(want).sort())
    expect((await ledger.list()).map((item) => item.workId)).not.toContain("dropped-work")

    // Files: every stored export, the patch, and untracked.json unpacked into real files; nothing for a blocked id.
    const work = (id: string, ...parts: string[]) => join(root, "v1", "works", id, ...parts)
    for (const id of ["ses_freshroot", "ses_freshchild"]) expect(readFileSync(work("proven-fresh", "exports", `${id}.json`))).toEqual(readFileSync(join(root, "works", "proven-fresh", "exports", `${id}.json`)))
    expect(readFileSync(work("proven-fresh", "patch.diff"))).toEqual(readFileSync(join(root, "works", "proven-fresh", "patch.diff")))
    expect(readFileSync(work("proven-fresh", "untracked", "notes", "todo.md"), "utf8")).toBe("# todo\n")
    expect([...readFileSync(work("proven-fresh", "untracked", "data.bin"))]).toEqual([0, 1, 2, 255])
    for (const id of BLOCKED) expect(existsSync(work(id))).toBe(false)

    // The v0 tree is byte-identical, and the note is the only addition, a folder that v0 skips.
    expect(contentOf(v0Tree(root))).toEqual(contentOf(before))
    expect(readdirSync(join(root, "works")).filter((name) => !before.some((entry) => entry.path === name))).toEqual(["README-MOVED-TO-v1"])
    expect(statSync(join(root, "works", "README-MOVED-TO-v1")).isDirectory()).toBe(true)
    expect(readFileSync(join(root, "works", "README-MOVED-TO-v1", "README.md"), "utf8")).toContain("safe only before")
    // What every v0 release does with each entry under works/: read <entry>/work.json, and skip it when it is absent.
    expect(() => readFileSync(join(root, "works", "README-MOVED-TO-v1", "work.json"))).toThrow(/ENOENT/)

    // Copies, never links: no v1 file shares an inode with a v0 file.
    const v0Inodes = new Set(readTree(join(root, "works")).map((entry) => entry.ino))
    const v1Files = readTree(join(root, "v1")).filter((entry) => entry.kind === "file")
    expect(v1Files.filter((entry) => v0Inodes.has(entry.ino))).toEqual([])
    expect(v1Files.every((entry) => entry.mode === 0o600)).toBe(true)
    expect(readTree(join(root, "v1")).filter((entry) => entry.kind === "dir").every((entry) => entry.mode === 0o700)).toBe(true)

    // The report and the marker.
    const report = await readReport(root)
    expect(report?.blocked).toEqual(BLOCKED)
    expect(report?.results.find((item) => item.workId === "corrupt-work")?.reason).toMatch(/work.json cannot be read/)
    expect(report?.results.find((item) => item.workId === "missing-export")?.reason).toMatch(/stored export of ses_missroot is missing/)
    const marker = JSON.parse(readFileSync(join(root, "v1", "complete"), "utf8")) as CompleteMarker
    expect(marker).toMatchObject({ works: 9, blocked: 2 })
    expect(marker.inputDigest).toMatch(/^[0-9a-f]{64}$/)

    // One fresh listing, and one get per machine found: never for a machine in no region.
    expect(boxd.lists).toBe(1)
    expect(boxd.gets.sort()).toEqual(["fra:oc-empty-proof", "fra:oc-laptop-id", "fra:oc-missing-export", "fra:oc-never-prompted", "fra:oc-old-shape", "fra:oc-proven-fresh", "fra:oc-slept-work", "nyc:oc-proven-stale"])
  })

  test("a blocked id answers IMPORT_V0_FAILED; every other work runs", async () => {
    const root = fixtureRoot()
    const gate = new LedgerGate({ root, boxd: fakeImportBoxd() })
    await gate.start()
    for (const id of BLOCKED) expect(() => gate.assertNotBlocked(id)).toThrow(/^IMPORT_V0_FAILED/)
    expect(() => gate.assertNotBlocked("proven-fresh")).not.toThrow()
    expect(() => gate.assertNotBlocked("brand-new")).not.toThrow()
  })

  test("idempotent: a second start imports nothing again and lists no machine", async () => {
    const root = fixtureRoot()
    await new LedgerGate({ root, boxd: fakeImportBoxd() }).start()
    const tree = readTree(root)
    const again = fakeImportBoxd()
    const gate = new LedgerGate({ root, boxd: again })
    expect((await gate.start()).state).toBe("ready")
    // The blocked ids are tried again (the v0 files are unchanged, so they stay blocked): one listing, nothing written.
    expect(again.lists).toBe(1)
    expect(readTree(root)).toEqual(tree)
    expect(await runImport({ root, boxd: again })).toEqual({ state: "present" })
  })

  test("two published imports of the same v0 tree hold the same ledger", async () => {
    const first = fixtureRoot()
    const second = fixtureRoot()
    await new LedgerGate({ root: first, boxd: fakeImportBoxd() }).start()
    await new LedgerGate({ root: second, boxd: fakeImportBoxd() }).start()
    expect(await publishedContent(second)).toEqual(await publishedContent(first))
  })
})

describe("the gate", () => {
  test("every call answers LEDGER_IMPORTING with progress until the ledger is published, and nothing is written meanwhile", async () => {
    const root = fixtureRoot()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let reached!: () => void
    const atRecord = new Promise<void>((resolve) => (reached = resolve))
    const gate = new LedgerGate({
      root,
      boxd: fakeImportBoxd(),
      onStep: async (step: ImportStep, progress) => {
        if (step === "record" && progress.done === 3) {
          reached()
          await held
        }
      },
    })
    const running = gate.start()
    await atRecord
    const answer = await gate.ledger().catch((error: unknown) => error)
    expect(answer).toBeInstanceOf(BoxdError)
    expect((answer as BoxdError).code).toBe("LEDGER_IMPORTING")
    expect((answer as BoxdError).details.progress).toEqual({ done: 3, total: 11 })
    expect(existsSync(join(root, "v1"))).toBe(false)
    // Another process sees the same through the lock's progress note.
    const other = new LedgerGate({ root, boxd: fakeImportBoxd() })
    const seen = (await other.ledger().catch((error: unknown) => error)) as BoxdError
    expect(seen.code).toBe("LEDGER_IMPORTING")
    expect(seen.details.progress).toEqual({ done: 3, total: 11 })
    release()
    expect((await running).state).toBe("ready")
    expect((await gate.ledger()).dir).toBe(join(root, "v1"))
    expect((await other.ledger()).dir).toBe(join(root, "v1"))
  })

  test("a failing all-region listing makes no v1/, answers IMPORT_V0_FAILED, and retries after its pause", async () => {
    const root = fixtureRoot()
    const boxd = fakeImportBoxd()
    boxd.failList = "not signed in"
    const gate = new LedgerGate({ root, boxd, retryMs: 60_000 })
    const state = await gate.start()
    expect(state).toMatchObject({ state: "failed" })
    expect(existsSync(join(root, "v1"))).toBe(false)
    expect(readdirSync(root).filter((name) => name.startsWith("v1.importing-") || name === "import.lock")).toEqual([])
    await expect(gate.ledger()).rejects.toThrow(/^IMPORT_V0_FAILED: .*not signed in/)
    expect(boxd.lists).toBe(1)

    boxd.failList = null
    const soon = new LedgerGate({ root, boxd, retryMs: 0 })
    await soon.start().then(() => undefined)
    expect((await soon.ledger()).dir).toBe(join(root, "v1"))
  })

  test("with no v0 ledger, an empty v1/ is published the same way, with no listing", async () => {
    const root = tempRoot("boxd-empty-")
    roots.push(root)
    const boxd = fakeImportBoxd()
    const gate = new LedgerGate({ root, boxd })
    expect(await gate.start()).toEqual({ state: "ready", works: 0, errors: 0, blocked: [] })
    expect(boxd.lists).toBe(0)
    expect(readdirSync(join(root, "v1")).sort()).toEqual(["complete", "import-v0.json", "works"])
    expect(existsSync(join(root, "works"))).toBe(false)
  })

  test("two processes start at once: one imports, the other answers LEDGER_IMPORTING, and both end on one ledger", async () => {
    const root = fixtureRoot()
    const outs = await Promise.all([childRun("gate", root), childRun("gate", root)])
    const states = outs.map((out) => JSON.parse(out.trim().split("\n").pop()!).state as string).sort()
    // The loser either found the lock held (importing: its tools answer LEDGER_IMPORTING) or came after the publish.
    expect(states.includes("ready")).toBe(true)
    expect(states.every((state) => state === "ready" || state === "importing")).toBe(true)
    expect(readdirSync(root).filter((name) => name.startsWith("v1"))).toEqual(["v1"])
    const fresh = fixtureRoot()
    await new LedgerGate({ root: fresh, boxd: fakeImportBoxd() }).start()
    expect(await publishedContent(root)).toEqual(await publishedContent(fresh))
  }, 60_000)

  test("a run whose lock was taken over writes only its own staging folder and does not publish", async () => {
    const root = fixtureRoot()
    let now = 1_000_000_000
    const outcome = await runImport({
      root,
      boxd: fakeImportBoxd(),
      lock: { staleMs: 60_000, heartbeatMs: 3_600_000 },
      onStep: async (step) => {
        if (step !== "marker") return
        // Another process finds this run's heartbeat stale and takes the lock over.
        now = Date.now() + 120_000
        const thief = await acquireLock(join(root, "import.lock"), { purpose: "thief", now: () => now })
        expect(thief).not.toBeNull()
      },
    })
    expect(outcome).toEqual({ state: "busy" })
    expect(existsSync(join(root, "v1"))).toBe(false)
    expect(readdirSync(root).filter((name) => name.startsWith("v1.importing-"))).toEqual([])
  })
})

describe("a record whose files cannot be copied (M-1)", () => {
  /** v0.0.6's own saveUntracked can store paths that collide as files: "a" and "a/b". */
  const collide = (root: string) =>
    writeFileSync(join(root, "works", "never-prompted", "untracked.json"), JSON.stringify({ a: Buffer.from("x").toString("base64"), "a/b": Buffer.from("y").toString("base64") }))

  test("blocks only its own id with the reason, and the rest is published", async () => {
    const root = fixtureRoot()
    collide(root)
    const boxd = fakeImportBoxd()
    const gate = new LedgerGate({ root, boxd })
    expect(await gate.start()).toEqual({ state: "ready", works: 8, errors: 3, blocked: ["corrupt-work", "missing-export", "never-prompted"] })
    const report = await readReport(root)
    expect(report?.results.find((item) => item.workId === "never-prompted")?.reason).toMatch(/^its files could not be copied: /)
    expect(existsSync(join(root, "v1", "works", "never-prompted"))).toBe(false)
    expect((await (await gate.ledger()).get("proven-fresh"))?.workId).toBe("proven-fresh")
    expect(() => gate.assertNotBlocked("never-prompted")).toThrow(/^IMPORT_V0_FAILED/)
    expect(boxd.lists).toBe(1)
  })

  test("in the blocked-id rerun too: it stays blocked, and no partial folder is left", async () => {
    const root = fixtureRoot()
    await new LedgerGate({ root, boxd: fakeImportBoxd() }).start()
    // The corrupt record is fixed, but its untracked files collide.
    writeFileSync(join(root, "works", "corrupt-work", "work.json"), readFileSync(join(root, "works", "never-prompted", "work.json"), "utf8").replaceAll("never-prompted", "corrupt-work"))
    writeFileSync(join(root, "works", "corrupt-work", "untracked.json"), JSON.stringify({ a: "eA==", "a/b": "eQ==" }))
    const gate = new LedgerGate({ root, boxd: fakeImportBoxd() })
    expect(await gate.start()).toMatchObject({ state: "ready", blocked: BLOCKED })
    expect((await readReport(root))?.results.find((item) => item.workId === "corrupt-work")?.reason).toMatch(/^its files could not be copied: /)
    expect(existsSync(join(root, "v1", "works", "corrupt-work"))).toBe(false)
  })

  test("a run that throws is a failure with its reason, retried only after its pause", async () => {
    const root = fixtureRoot()
    const boxd = fakeImportBoxd()
    // A listing that answers with something the import cannot use throws inside the run.
    boxd.list = async () => {
      boxd.lists += 1
      return { takenAt: Date.now(), fresh: true, machines: null as never }
    }
    let now = 1_000_000
    const gate = new LedgerGate({ root, boxd, retryMs: 30_000, now: () => new Date(now) })
    expect(await gate.start()).toMatchObject({ state: "failed" })
    for (let index = 0; index < 3; index++) {
      const error = (await gate.ledger().catch((caught: unknown) => caught)) as BoxdError
      expect(error.code).toBe("IMPORT_V0_FAILED")
      expect((await gate.start()).state).toBe("failed")
    }
    expect(boxd.lists).toBe(1)
    now += 30_001
    await gate.start()
    expect(boxd.lists).toBe(2)
  })

  test("a v1/ without its marker in the way is a failure, never adopted", async () => {
    const root = fixtureRoot()
    const gate = new LedgerGate({
      root,
      boxd: fakeImportBoxd(),
      onStep: async (step) => {
        if (step === "publish") mkdirSync(join(root, "v1", "works", "x"), { recursive: true })
      },
    })
    expect(await gate.start()).toMatchObject({ state: "failed", reason: expect.stringMatching(/without its complete marker/) })
    await expect(gate.ledger()).rejects.toThrow(/^IMPORT_V0_FAILED/)
  })
})

describe("blocked ids, imported again into the published ledger", () => {
  test("a fixed v0 record is imported under its lock at the next start; a removed one frees its id", async () => {
    const root = fixtureRoot()
    await new LedgerGate({ root, boxd: fakeImportBoxd() }).start()
    // The person fixes one record and removes the other.
    writeFileSync(join(root, "works", "corrupt-work", "work.json"), readFileSync(join(root, "works", "never-prompted", "work.json"), "utf8").replaceAll("never-prompted", "corrupt-work"))
    rmSync(join(root, "works", "missing-export"), { recursive: true })
    const boxd = fakeImportBoxd()
    boxd.rows.push({ ...boxd.rows[0]!, name: "oc-corrupt-work", labels: { role: "session", work: "corrupt-work" } })
    const gate = new LedgerGate({ root, boxd })
    expect(await gate.start()).toEqual({ state: "ready", works: 10, errors: 0, blocked: [] })
    const record = await (await gate.ledger()).get("corrupt-work")
    expect(record).toMatchObject({ workId: "corrupt-work", region: "fra", machineId: idOf("oc-corrupt-work", "fra"), importedFrom: "v0", guestHelper: "v0" })
    expect(() => gate.assertNotBlocked("corrupt-work")).not.toThrow()
    expect(() => gate.assertNotBlocked("missing-export")).not.toThrow()
    const report = await readReport(root)
    expect(report?.results.find((item) => item.workId === "corrupt-work")).toEqual({ workId: "corrupt-work", result: "imported" })
    expect(existsSync(join(root, "v1", "works", "corrupt-work", "work.lock"))).toBe(false)
  })

  test("a record that still fails stays blocked; a failing listing leaves every blocked id as it was", async () => {
    const root = fixtureRoot()
    await new LedgerGate({ root, boxd: fakeImportBoxd() }).start()
    const boxd = fakeImportBoxd()
    boxd.failList = "offline"
    writeFileSync(join(root, "works", "corrupt-work", "work.json"), readFileSync(join(root, "works", "never-prompted", "work.json"), "utf8").replaceAll("never-prompted", "corrupt-work"))
    const gate = new LedgerGate({ root, boxd })
    expect(await gate.start()).toMatchObject({ state: "ready", blocked: BLOCKED })
    expect(existsSync(join(root, "v1", "works", "corrupt-work"))).toBe(false)
  })
})

describe("the v0 guest: the read fallback and adopt", () => {
  const listing = { takenAt: Date.now(), fresh: true, machines: [] }
  const readTarget: ReadTarget = { region: "fra", name: "oc-proven-fresh", listing, machineId: null }

  test("phase runs v0's own helper with no upload, and maps its answer", async () => {
    const calls: Array<{ command: string; stdin?: string; json: boolean }> = []
    const answer = {
      ok: true,
      phase: "idle",
      outcome: "failed",
      error: { type: "ProviderAuthError", message: "401 token=sk-abcdefghijklmnop expired\nmore" },
      activityAt: 1_763_200_000_000,
      lastText: "done. Bearer abcdefghijklmnopqrstuvwxyz",
      pending: 2,
      tail: [{ at: 1_763_200_000_000, text: "first" }, { at: null, text: "second" }],
    }
    const boxd = {
      exec: async (_target: unknown, command: string, options: { stdin?: string; json: boolean }) => {
        calls.push({ command, ...(options.stdin ? { stdin: options.stdin } : {}), json: options.json })
        return { code: 0, stdout: `update banner\n${JSON.stringify(answer)}\n`, stderr: "", ms: 1 }
      },
    }
    const phase = await v0Phase(boxd, readTarget, { sessionId: "ses_freshroot", tail: 2 }, { call: { callId: "c", source: "boxd_job" } })
    expect(calls).toEqual([{ command: `python3 ${V0_HELPER_PATH}`, stdin: JSON.stringify({ action: "phase", sessionID: "ses_freshroot", tail: 2 }), json: false }])
    expect(phase).toEqual({
      phase: "idle",
      outcome: "failed",
      error: "ProviderAuthError: 401 token=[redacted] expired",
      lastActivityAt: new Date(1_763_200_000_000).toISOString(),
      lastText: "done. Bearer [redacted]",
      waiting: { steer: 2, queue: 0 },
      guestVersion: null,
      tail: [{ at: new Date(1_763_200_000_000).toISOString(), text: "first" }, { text: "second" }],
    })
    await expect(v0Phase(boxd, readTarget, { sessionId: "not-a-session" }, { call: { callId: "c", source: "boxd_job" } })).rejects.toThrow(/NAME_INVALID/)
  })

  test("a v0.0.0 answer without activity fields, a missing session, and a guest whose /tmp a reboot cleared", () => {
    expect(parseV0Phase('{"ok": true, "phase": "busy"}\n', "", 0)).toEqual({ phase: "busy", outcome: null, waiting: { steer: 0, queue: 0 }, guestVersion: null })
    expect(parseV0Phase('{"ok": true, "phase": "missing"}\n', "", 0).phase).toBe("missing")
    expect(() => parseV0Phase("", `python3: can't open file '${V0_HELPER_PATH}': [Errno 2] No such file or directory`, 2)).toThrow(/^GUEST_FAILED: The machine has no opencode-boxd helper/)
    expect(() => parseV0Phase('{"ok": false, "error": "HTTP 500", "detail": "boom"}', "", 1)).toThrow(/GUEST_FAILED: The v0 helper's phase failed \(HTTP 500: boom\)/)
  })

  test("adopt copies the v0 password into the v1 home once, with one plain exec, and changes nothing else", async () => {
    const calls: Array<{ target: unknown; command: string; json: boolean; timeoutSeconds: number }> = []
    let answer = { code: 0, stdout: "update banner\nopencode-boxd-adopted\n", stderr: "", ms: 1 }
    const boxd = {
      exec: async (target: unknown, command: string, options: { json: boolean; timeoutSeconds: number }) => {
        calls.push({ target, command, json: options.json, timeoutSeconds: options.timeoutSeconds })
        return answer
      },
    }
    const target = { region: "fra", name: "oc-proven-fresh", machineId: idOf("oc-proven-fresh", "fra"), checkedAt: Date.now() } as unknown as ChangeTarget
    const context = { call: { callId: "c", source: "boxd_submit" as const } }
    await adoptV0(boxd, target, context)
    expect(calls).toEqual([{ target, command: ADOPT_COMMAND, json: false, timeoutSeconds: 30 }])
    // Only when the v1 home has no password, only from v0's, 0600 through a rename; no server is touched.
    expect(ADOPT_COMMAND).toContain("[ ! -e /home/boxd/.opencode-boxd/password ] && [ -f /tmp/opencode-boxd/password ]")
    expect(ADOPT_COMMAND).toContain("umask 077")
    expect(ADOPT_COMMAND).not.toMatch(/opencode serve|kill|pkill|rm /)
    answer = { code: 1, stdout: "", stderr: "cp: permission denied", ms: 1 }
    await expect(adoptV0(boxd, target, context)).rejects.toThrow(/^GUEST_FAILED: Taking over the v0 guest failed \(cp: permission denied\)/)
  })
})

function childRun(...args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn("bun", [join(import.meta.dir, "..", "support", "ledger-child.ts"), ...args], { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    proc.stdout.on("data", (chunk) => (out += chunk))
    proc.on("close", () => resolve(out))
  })
}
