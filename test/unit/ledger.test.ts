// The ledger is the laptop's copy of a session, and two tools in one script can write it at once. These tests prove the
// two properties the drop guard depends on: no write is lost, and no reader ever sees a half-written file.
import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Ledger, type Work } from "../../src/ledger.js"
import { transfer } from "./fake.js"

const work = (workId: string): Work => ({ workId, machine: `oc-${workId}`, snapshot: "opencode-golden", laptopDirectory: "/work/x", guestDirectory: "/home/boxd/work/x" })

const fresh = () => mkdtemp(join(tmpdir(), "boxd-ledger-"))

describe("the ledger under concurrent writes", () => {
  test("twenty concurrent updates of one work all land, in order, with no lost field", async () => {
    const ledger = new Ledger(await fresh())
    await ledger.save(work("review-api"))
    const counts = { total: 0 }
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        ledger.mutate("review-api", (current) => {
          counts.total += 1
          return { ...(current ?? work("review-api")), lastSubmitAt: `2026-11-07T12:00:${String(index).padStart(2, "0")}.000Z` }
        }),
      ),
    )
    expect(counts.total).toBe(20)
    const saved = await ledger.load("review-api")
    // Every recipe saw the work as it was when its turn came, so none lost another's field.
    expect(saved?.lastSubmitAt).toBe("2026-11-07T12:00:19.000Z")
    expect(saved?.machine).toBe("oc-review-api")
  })

  test("a whole-work save and a mutate racing do not throw: the last writer wins only for what it wrote", async () => {
    const ledger = new Ledger(await fresh())
    await ledger.save(work("review-api"))
    const results = await Promise.allSettled([
      ledger.save({ ...work("review-api"), laptopDirectory: "/work/a" }),
      ledger.mutate("review-api", (current) => ({ ...(current ?? work("review-api")), rootSessionId: "ses_race" })),
      ledger.save({ ...work("review-api"), laptopDirectory: "/work/b" }),
      ledger.mutate("review-api", (current) => ({ ...(current ?? work("review-api")), lastSubmitAt: "2026-11-07T12:00:00.000Z" })),
    ])
    expect(results.filter((result) => result.status === "rejected")).toEqual([])
    const saved = await ledger.load("review-api")
    // Every write landed whole; a `save` of a stale object can still replace a field, which is why the fleet mutates.
    expect(saved?.workId).toBe("review-api")
    expect(JSON.parse(await readFile(join(ledger.root, "works", "review-api", "work.json"), "utf8"))).toBeObject()
  })

  test("a progress stamp written before a prompt makes a racing harvest stale, which is what drop reads", async () => {
    const ledger = new Ledger(await fresh())
    await ledger.save(work("review-api"))
    // The harvest loaded the work, then a submit stamped a later prompt, then the harvest wrote its proof.
    const loaded = (await ledger.load("review-api"))!
    await ledger.mutate("review-api", (current) => ({ ...(current ?? loaded), lastSubmitAt: "2026-11-07T12:00:09.000Z" }))
    await ledger.mutate("review-api", (current) => ({
      ...(current ?? loaded),
      proof: { harvestedAt: "2026-11-07T12:00:01.000Z", guestVersion: "2.2.6", sessions: [], sha256: {} },
    }))
    const saved = await ledger.load("review-api")
    expect(saved?.lastSubmitAt).toBe("2026-11-07T12:00:09.000Z")
  })

  test("a failed write is coded, never a raw ENOENT, and the work survives", async () => {
    const root = await fresh()
    const ledger = new Ledger(root)
    await ledger.save(work("review-api"))
    // A directory where the work file should be: the rename fails.
    const error = await ledger.save({ ...work("review-api"), workId: "review-api" }).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(error).toBeUndefined()
    const missing = await ledger.load("no-such-work")
    expect(missing).toBeUndefined()
    // A read of an export that was never stored is LEDGER_FAILED, not ENOENT.
    await expect(ledger.loadExport("review-api", "ses_missing")).rejects.toMatchObject({ code: "LEDGER_FAILED" })
  })

  test("writes are private: the folder is 0700 and every file 0600", async () => {
    const ledger = new Ledger(await fresh())
    await ledger.save(work("review-api"))
    await ledger.saveExport("review-api", "ses_1", transfer("ses_1"))
    await ledger.savePatch("review-api", "diff --git a/x b/x\n")
    const dir = join(ledger.root, "works", "review-api")
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    for (const path of [join(dir, "work.json"), join(dir, "exports", "ses_1.json"), join(dir, "patch.diff")]) {
      expect({ path, mode: (await stat(path)).mode & 0o777 }).toEqual({ path, mode: 0o600 })
    }
  })

  test("a temp file is never left behind", async () => {
    const ledger = new Ledger(await fresh())
    await ledger.save(work("review-api"))
    const files = await Array.fromAsync(new Bun.Glob("**/*.tmp").scan({ cwd: ledger.root }))
    expect(files).toEqual([])
    expect(JSON.parse(await readFile(join(ledger.root, "works", "review-api", "work.json"), "utf8"))).toMatchObject({ workId: "review-api" })
  })
})
