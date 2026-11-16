// The ledger and import ports (design §9.1, src/ports.ts): built by `createImportV0` and `createLedger` as the plugin
// builds them, every record call passes the import gate (LEDGER_IMPORTING until published, IMPORT_V0_FAILED for a
// failed listing and for a blocked id), `update` writes only the works it locked, and events carry status's cursor.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BoxdError } from "../../src/errors.js"
import { createImportV0 } from "../../src/import-v0.js"
import { createLedger, ledgerPort } from "../../src/ledger/index.js"
import { Ledger } from "../../src/ledger/store.js"
import type { WorkRecord } from "../../src/ledger/types.js"
import { parseOptions } from "../../src/options.js"
import type { ImportState, ImportV0Port, LedgerPort, OpContext } from "../../src/ports.js"
import type { HostServices, Runtime } from "../../src/services.js"
import { notBuilt } from "../support/not-built.js"
import { fakeImportBoxd, removeRoot, tempRoot, v0Root, type FakeImportBoxd } from "../support/ledger-fakes.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) removeRoot(root)
})

const context: OpContext = { call: { callId: "t", source: "boxd_status" } }

/** The plugin's own wiring, with a fake boxd port and everything else unbuilt. */
function core(root: string, boxd: FakeImportBoxd) {
  const problems = new Map<string, string>()
  const host: HostServices & Runtime = {
    options: parseOptions({}),
    hostVersion: "2.2.6",
    projectDirectory: root,
    ledgerRoot: root,
    boxdBin: "boxd",
    opencodeBin: "opencode",
    clock: { now: () => new Date() },
    sessions: notBuilt("sessions"),
    report: (area, problem) => void (problem ? problems.set(area, problem) : problems.delete(area)),
    runner: notBuilt("runner"),
    boxd: { ...notBuilt<Runtime["boxd"]>("boxd"), list: boxd.list, get: boxd.get },
    guest: notBuilt("guest"),
    laptop: notBuilt("laptop"),
    dispose: async () => {},
  }
  const importV0 = createImportV0(host)
  return { importV0, ledger: createLedger({ ...host, importV0 }), problems }
}

const errorOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(BoxdError)
  return error as BoxdError
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

async function settled(port: ImportV0Port): Promise<ImportState> {
  for (let index = 0; index < 200; index++) {
    const state = await port.run(context)
    if (state.state === "complete" || state.state === "failed") return state
  }
  throw new Error("the import did not settle")
}

describe("the ports as the plugin builds them", () => {
  test("the import starts at plugin start; records are served once it is complete; blocked ids are refused", async () => {
    const root = v0Root("boxd-port-")
    roots.push(root)
    const { importV0, ledger, problems } = core(root, fakeImportBoxd())
    expect(await settled(importV0)).toEqual({ state: "complete", works: 9, blocked: ["corrupt-work", "missing-export"] })
    expect(problems.size).toBe(0)
    await ledger.ready(context)
    expect((await ledger.get("proven-fresh", context))?.saved?.sessions).toHaveLength(2)
    expect((await ledger.list({}, context)).map((item) => item.workId)).toEqual(["empty-proof", "laptop-id", "never-prompted", "old-shape", "pending-create", "proven-fresh", "proven-stale", "slept-work"])
    expect((await ledger.list({ closed: true, region: "nyc" }, context)).map((item) => item.workId)).toEqual(["proven-stale"])
    expect((await ledger.list({ workIds: ["old-shape", "nope"] }, context)).map((item) => item.workId)).toEqual(["old-shape"])
    expect(ledger.saved((await ledger.get("proven-fresh", context))!)).toBe("fresh")
    expect(ledger.saved((await ledger.get("proven-stale", context))!)).toBe("stale")
    expect(ledger.saved((await ledger.get("never-prompted", context))!)).toBe("none")

    // A blocked id: no read, and `ensure` can never open a fresh record over it.
    expect((await errorOf(ledger.get("corrupt-work", context))).code).toBe("IMPORT_V0_FAILED")
    const refused = await errorOf(ledger.update(["corrupt-work"], async () => ({ write: [record("corrupt-work")], value: 1 }), context))
    expect(refused.code).toBe("IMPORT_V0_FAILED")
    expect(existsSync(join(root, "v1", "works", "corrupt-work"))).toBe(false)
  })

  test("a failing listing: IMPORT_V0_FAILED for every call, no v1/, and status hears of it", async () => {
    const root = v0Root("boxd-port-")
    roots.push(root)
    const boxd = fakeImportBoxd()
    boxd.failList = "not signed in"
    const { importV0, ledger, problems } = core(root, boxd)
    expect(await settled(importV0)).toMatchObject({ state: "failed" })
    expect((await errorOf(ledger.ready(context))).code).toBe("IMPORT_V0_FAILED")
    expect((await errorOf(ledger.list({}, context))).message).toMatch(/not signed in/)
    expect(problems.get("import")).toMatch(/^IMPORT_V0_FAILED: .*not signed in/)
    expect(existsSync(join(root, "v1"))).toBe(false)
    expect(boxd.lists).toBe(1)
  })

  test("while another process imports, every call answers LEDGER_IMPORTING with its progress", async () => {
    const root = v0Root("boxd-port-")
    roots.push(root)
    // Another live process holds the import lock and has written its progress.
    const lock = join(root, "import.lock")
    mkdirSync(lock)
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ token: "other", pid: process.pid, host: "another-host", at: Date.now(), purpose: "import-v0" }))
    writeFileSync(join(lock, "progress.json"), JSON.stringify({ done: 4, total: 11 }))
    const { ledger } = core(root, fakeImportBoxd())
    const error = await errorOf(ledger.get("proven-fresh", context))
    expect(error.code).toBe("LEDGER_IMPORTING")
    expect(error.details.progress).toEqual({ done: 4, total: 11 })
    expect((await errorOf(ledger.appendEvent({ at: new Date().toISOString(), workId: "x", from: null, to: "busy" }, context))).code).toBe("LEDGER_IMPORTING")
    expect(existsSync(join(root, "v1"))).toBe(false)
    removeRoot(lock)
  })
})

describe("the ledger port over a published ledger", () => {
  const complete: Pick<ImportV0Port, "state" | "run"> = {
    state: () => ({ state: "complete", works: 0, blocked: ["blocked-id"] }),
    run: async () => ({ state: "complete", works: 0, blocked: ["blocked-id"] }),
  }
  async function port(): Promise<{ ledger: LedgerPort; store: Ledger }> {
    const root = tempRoot("boxd-port-")
    roots.push(root)
    const { importV0 } = core(root, fakeImportBoxd())
    await settled(importV0)
    const store = new Ledger(root)
    return { ledger: ledgerPort(store, complete), store }
  }

  test("update takes the locks in sorted order, writes only the locked works, and nothing when it throws", async () => {
    const { ledger, store } = await port()
    const value = await ledger.update(
      ["right", "left"],
      async (current) => {
        expect([...current.keys()]).toEqual(["left", "right"])
        expect([...current.values()]).toEqual([undefined, undefined])
        return { write: [record("left"), record("right", { state: "closed", closed: { at: "2026-11-15T12:00:00.000Z", how: "reassigned", to: "left" } })], value: "done" }
      },
      context,
    )
    expect(value).toBe("done")
    expect((await ledger.get("right", context))?.closed?.to).toBe("left")
    expect((await errorOf(ledger.update(["left"], async () => ({ write: [record("left"), record("other")], value: 0 }), context))).code).toBe("LEDGER_FAILED")
    expect(await store.get("other")).toBeUndefined()
    await expect(ledger.update(["left"], async () => Promise.reject(new Error("no")), context)).rejects.toThrow("no")
    expect((await ledger.get("left", context))?.title).toBeUndefined()
    expect((await errorOf(ledger.update(["blocked-id"], async () => ({ write: [], value: 0 }), context))).code).toBe("IMPORT_V0_FAILED")
  })

  test("events: the next seq, the index's phase, and the cursor", async () => {
    const { ledger, store } = await port()
    await ledger.update(["alpha"], async () => ({ write: [record("alpha")], value: undefined }), context)
    const first = await ledger.appendEvent({ at: "2026-11-15T12:00:00.000Z", workId: "alpha", from: null, to: "busy" }, context)
    const second = await ledger.appendEvent({ at: "2026-11-15T12:01:00.000Z", workId: "alpha", from: null, to: "idle", code: "made up words" }, context)
    expect([first.seq, second.seq, second.code]).toEqual([1, 2, "RUN_FAILED"])
    expect(await ledger.eventsSince(1, context)).toEqual({ events: [second], cursor: 2, cursorExpired: false })
    expect(await ledger.eventsSince(2, context)).toEqual({ events: [], cursor: 2, cursorExpired: false })
    expect((await ledger.eventsSince(9, context)).cursorExpired).toBe(true)
    expect((await store.refresh()).works.alpha?.phase).toBe("idle")
  })

  test("phases: the index's cached phase per work, open ones unless closed is asked for, with no event replay", async () => {
    const { ledger } = await port()
    await ledger.update(["alpha", "beta", "gone"], async () => ({ write: [record("alpha"), record("beta"), record("gone", { state: "closed", closed: { at: "2026-11-15T12:00:00.000Z", how: "dropped" } })], value: undefined }), context)
    await ledger.appendEvent({ at: "2026-11-15T12:00:00.000Z", workId: "alpha", from: null, to: "busy" }, context)
    const open = await ledger.phases({}, context)
    expect([...open.keys()].sort()).toEqual(["alpha", "beta"])
    expect(open.get("alpha")).toMatchObject({ state: "open", region: "fra", phase: "busy", saved: "none" })
    expect(open.get("beta")?.phase).toBeNull()
    expect((await ledger.phases({ closed: true }, context)).get("gone")).toMatchObject({ state: "closed", phase: "closed" })
  })

  test("staged writes pass the gate: a blocked id is refused, a verified file lands, a bad one is discarded", async () => {
    const { ledger } = await port()
    expect((await errorOf(ledger.stageFile("blocked-id", "patch.diff", context))).code).toBe("IMPORT_V0_FAILED")
    expect((await errorOf(ledger.stageFolder("blocked-id", "untracked", context))).code).toBe("IMPORT_V0_FAILED")
    await ledger.update(["alpha"], async () => ({ write: [record("alpha")], value: undefined }), context)
    const staged = await ledger.stageFile("alpha", "exports/ses_a.json", context)
    writeFileSync(staged.path, "body")
    expect((await errorOf(ledger.commitFile(staged, { bytes: 4, sha256: "0".repeat(64) }, context))).code).toBe("EXPORT_INVALID")
    expect(existsSync(staged.path)).toBe(false)
    const again = await ledger.stageFile("alpha", "exports/ses_a.json", context)
    writeFileSync(again.path, "body")
    await ledger.commitFile(again, { bytes: 4, sha256: "230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5" }, context)
    expect(readFileSync(join(ledger.workFolder("alpha"), "exports", "ses_a.json"), "utf8")).toBe("body")
    const folder = await ledger.stageFolder("alpha", "untracked", context)
    writeFileSync(join(folder.path, "x.txt"), "body")
    await ledger.commitFolder(folder, { "x.txt": { bytes: 4, sha256: "230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5" } }, context)
    expect(readFileSync(join(ledger.workFolder("alpha"), "untracked", "x.txt"), "utf8")).toBe("body")
    const unused = await ledger.stageFolder("alpha", "untracked", context)
    await ledger.discard(unused)
    expect(existsSync(unused.path)).toBe(false)
  })

  test("while the import runs, staging a file is refused like every other call, so no v1/ is made under it (LOW-2)", async () => {
    const root = v0Root("boxd-port-")
    roots.push(root)
    const importing: Pick<ImportV0Port, "state" | "run"> = {
      state: () => ({ state: "importing", done: 1, total: 11 }),
      run: async () => ({ state: "importing", done: 1, total: 11 }),
    }
    const ledger = ledgerPort(new Ledger(root), importing)
    expect((await errorOf(ledger.stageFile("proven-fresh", "patch.diff", context))).code).toBe("LEDGER_IMPORTING")
    expect(existsSync(join(root, "v1"))).toBe(false)
  })
})
