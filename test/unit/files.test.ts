// Data in and data out: a real task reads a laptop file on the machine and brings its result home. These tests prove the
// upload, the download, the caps, the symlink refusal, the conflict guard, and that a harvested output frees a drop
// while an un-harvested file keeps it.
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { existsSync } from "node:fs"
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { BoxdError, type Code } from "../../src/errors.js"
import { world } from "./fake.js"

const digest = (body: Buffer | string) => createHash("sha256").update(body).digest("hex")

const refusal = async (promise: Promise<unknown>, code: Code) => {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  )
  expect(error).toBeInstanceOf(BoxdError)
  expect((error as BoxdError).code).toBe(code)
  return error as BoxdError
}

/** A work opened in a laptop folder of its own, with the guest reporting a git tree. */
async function openWork() {
  const w = await world()
  const laptop = join(w.root, "work")
  await mkdir(laptop, { recursive: true })
  const opened = await w.fleet.ensure({ workId: "review-api", directory: laptop })
  return { w, laptop, opened }
}

describe("the guest work path (GAP-23)", () => {
  test("every work maps to /home/boxd/work/<id>, and both paths are recorded", async () => {
    const { w, laptop, opened } = await openWork()
    const real = await realpath(laptop)
    expect(opened).toMatchObject({ state: "ready", guestDirectory: "/home/boxd/work/review-api", laptopDirectory: real })
    const work = await w.ledger.load("review-api")
    expect(work).toMatchObject({ guestDirectory: "/home/boxd/work/review-api", laptopDirectory: real })
    // The guest prepared its own folder, never the laptop's absolute path.
    expect(w.guest.prepared).toEqual(["/home/boxd/work/review-api"])
    expect(w.guest.prepared.join(" ")).not.toContain(laptop)
  })

  test("a laptop path outside the project and the allowed roots is refused, by name", async () => {
    const w = await world()
    const error = await refusal(w.fleet.ensure({ workId: "review-api", directory: "/definitely/outside" }), "PATH_REFUSED")
    expect(error.message).toContain("/definitely/outside")
    expect(String(error.next)).toContain("allowedRoots")
  })

  test("a guest that cannot prepare its own folder fails with GUEST_WORKSPACE and its own words", async () => {
    const w = await world()
    w.guest.prepare = async () => {
      throw new BoxdError("GUEST_FAILED", "The guest prepare failed (permission denied: /home/boxd/work).")
    }
    const error = await refusal(w.fleet.ensure({ workId: "review-api" }), "GUEST_WORKSPACE")
    expect(error.message).toContain("/home/boxd/work/review-api")
    expect(error.message).toContain("permission denied")
  })
})

describe("data in (GAP-4)", () => {
  test("submit copies the files to the work tree before the prompt, and records name, size and digest", async () => {
    const { w, laptop } = await openWork()
    const from = join(laptop, "bookmarks.json")
    await writeFile(from, '{"links":[]}')
    const admitted = await w.fleet.submit({
      workId: "review-api",
      text: "Read data/bookmarks.json.",
      files: [{ from, to: "data/bookmarks.json" }],
    })
    expect(admitted).toMatchObject({ state: "admitted", files: [{ path: "data/bookmarks.json", bytes: 12, sha256: digest('{"links":[]}') }] })
    expect(w.guest.uploaded.get("data/bookmarks.json")?.toString()).toBe('{"links":[]}')
    const work = await w.ledger.load("review-api")
    expect(work?.uploads).toEqual([{ path: "data/bookmarks.json", bytes: 12, sha256: digest('{"links":[]}'), at: expect.any(String) }])
    // The content is never recorded.
    expect(JSON.stringify(work)).not.toContain("links")
  })

  test("a path outside the roots, a symlink, and a work-tree escape are each refused before any copy", async () => {
    // Only the work's own folder is a root here, so a sibling file is genuinely outside it.
    const w = await world({ allowedRoots: [] })
    const laptop = join(w.root, "work")
    await mkdir(laptop, { recursive: true })
    await w.fleet.ensure({ workId: "review-api", directory: laptop })
    const outside = join(w.root, "..", `boxd-outside-${process.pid}.txt`)
    await writeFile(outside, "x")
    await refusal(w.fleet.submit({ workId: "review-api", text: "x", files: [{ from: outside, to: "x.txt" }] }), "PATH_REFUSED")

    const target = join(laptop, "real.txt")
    await writeFile(target, "real")
    await symlink(target, join(laptop, "link.txt"))
    await refusal(w.fleet.submit({ workId: "review-api", text: "x", files: [{ from: join(laptop, "link.txt"), to: "x.txt" }] }), "PATH_REFUSED")

    await refusal(w.fleet.submit({ workId: "review-api", text: "x", files: [{ from: target, to: "../escape.txt" }] }), "PATH_REFUSED")
    expect(w.guest.uploaded.size).toBe(0)
  })

  test("a file over 8 MiB, and a call over 32 MiB, are refused", async () => {
    const { w, laptop } = await openWork()
    const big = join(laptop, "big.bin")
    await writeFile(big, Buffer.alloc(8 * 1024 * 1024 + 1))
    await refusal(w.fleet.submit({ workId: "review-api", text: "x", files: [{ from: big, to: "big.bin" }] }), "FILE_TOO_LARGE")

    const files = []
    for (let index = 0; index < 5; index += 1) {
      const path = join(laptop, `part-${index}.bin`)
      await writeFile(path, Buffer.alloc(7 * 1024 * 1024))
      files.push({ from: path, to: `part-${index}.bin` })
    }
    await refusal(w.fleet.submit({ workId: "review-api", text: "x", files }), "FILE_TOO_LARGE")
    expect(w.guest.uploaded.size).toBe(0)
  })
})

describe("data out (GAP-4) and the drop it frees (GAP-5)", () => {
  test("harvest copies the requested files back atomically, 0600, and records them", async () => {
    const { w, laptop } = await openWork()
    await w.fleet.submit({ workId: "review-api", text: "Write SUMMARY.md." })
    w.guest.phaseById.set("ses_root_review-api", "idle")
    w.guest.remote.set("SUMMARY.md", Buffer.from("# Summary\n"))

    const harvested = await w.fleet.harvest({ workId: "review-api", files: ["SUMMARY.md"] })
    expect(harvested).toMatchObject({ state: "proven", files: [{ path: "SUMMARY.md", bytes: 10, sha256: digest("# Summary\n") }] })
    expect(await readFile(join(laptop, "SUMMARY.md"), "utf8")).toBe("# Summary\n")
    expect((await stat(join(laptop, "SUMMARY.md"))).mode & 0o777).toBe(0o600)
    const work = await w.ledger.load("review-api")
    expect(work?.downloads?.[0]).toMatchObject({ path: "SUMMARY.md", sha256: digest("# Summary\n"), laptopPath: await realpath(join(laptop, "SUMMARY.md")) })
  })

  test("a file the guest cannot produce is a coded failure, and the transcript is still proven", async () => {
    const { w } = await openWork()
    await w.fleet.submit({ workId: "review-api", text: "Write nothing." })
    w.guest.phaseById.set("ses_root_review-api", "idle")
    await refusal(w.fleet.harvest({ workId: "review-api", files: ["MISSING.md"] }), "GUEST_FAILED")
    expect((await w.fleet.job({ workId: "review-api" })).proof).toBe("fresh")
  })

  test("a local edit since the last harvest is never overwritten", async () => {
    const { w, laptop } = await openWork()
    await w.fleet.submit({ workId: "review-api", text: "Write SUMMARY.md." })
    w.guest.phaseById.set("ses_root_review-api", "idle")
    w.guest.remote.set("SUMMARY.md", Buffer.from("from the guest\n"))
    await w.fleet.harvest({ workId: "review-api", files: ["SUMMARY.md"] })
    await writeFile(join(laptop, "SUMMARY.md"), "my local edit\n")
    await refusal(w.fleet.harvest({ workId: "review-api", files: ["SUMMARY.md"] }), "FILE_CONFLICT")
    expect(await readFile(join(laptop, "SUMMARY.md"), "utf8")).toBe("my local edit\n")
  })

  test("a harvested output frees the drop; an un-harvested untracked file still refuses it", async () => {
    const { w } = await openWork()
    await w.fleet.submit({ workId: "review-api", text: "Write SUMMARY.md and extra.txt." })
    w.guest.phaseById.set("ses_root_review-api", "idle")
    w.guest.remote.set("SUMMARY.md", Buffer.from("done\n"))
    w.guest.gitState = { known: true, remote: null, branch: null, sha: "abc", dirty: false, untracked: ["SUMMARY.md", "extra.txt"], ignored: [], untrackedFiles: {} }
    await w.fleet.harvest({ workId: "review-api", files: ["SUMMARY.md"] })

    // extra.txt was never harvested, so the guard keeps the refusal and names it.
    const error = await refusal(w.fleet.drop({ workId: "review-api" }), "UNTRACKED")
    expect(error.message).toContain("extra.txt")
    expect(error.message).not.toContain("SUMMARY.md")

    // Once it is harvested too, the drop is allowed.
    w.guest.remote.set("extra.txt", Buffer.from("more\n"))
    w.guest.gitState = { ...w.guest.gitState, untracked: ["SUMMARY.md", "extra.txt"] }
    await w.fleet.harvest({ workId: "review-api", files: ["extra.txt"] })
    await expect(w.fleet.drop({ workId: "review-api" })).resolves.toMatchObject({ state: "dropped" })
  })

  test("ensuring an open work again keeps what the ledger knows: its files, its last outcome and its harvested outputs", async () => {
    const { w, laptop } = await openWork()
    const data = join(laptop, "bookmarks.json")
    await writeFile(data, "[]\n")
    await w.fleet.submit({ workId: "review-api", text: "Write SUMMARY.md.", files: [{ from: data, to: "data/bookmarks.json" }] })
    w.guest.phaseById.set("ses_root_review-api", "idle")
    w.guest.runById.set("ses_root_review-api", { outcome: "completed" })
    w.guest.remote.set("SUMMARY.md", Buffer.from("done\n"))
    w.guest.gitState = { known: true, remote: null, branch: null, sha: "abc", dirty: false, untracked: ["SUMMARY.md"], ignored: [], untrackedFiles: {} }
    await w.fleet.harvest({ workId: "review-api", files: ["SUMMARY.md"] })
    const before = await w.ledger.load("review-api")

    // A coordinator ensures each work again at the start of a turn, such as after a resize.
    await w.fleet.ensure({ workId: "review-api", directory: laptop })
    const after = await w.ledger.load("review-api")
    expect(after?.uploads).toEqual(before?.uploads)
    expect(after?.downloads).toEqual(before?.downloads)
    expect(after?.lastOutcome).toEqual(before?.lastOutcome)
    // So SUMMARY.md still counts as recovered, and the drop the harvest allowed is still allowed.
    await expect(w.fleet.drop({ workId: "review-api" })).resolves.toMatchObject({ state: "dropped" })
  })

  test("a harvested file that changed on the guest keeps the refusal", async () => {
    const { w } = await openWork()
    await w.fleet.submit({ workId: "review-api", text: "Write SUMMARY.md." })
    w.guest.phaseById.set("ses_root_review-api", "idle")
    w.guest.remote.set("SUMMARY.md", Buffer.from("first\n"))
    w.guest.gitState = { known: true, remote: null, branch: null, sha: "abc", dirty: false, untracked: ["SUMMARY.md"], ignored: [], untrackedFiles: {} }
    await w.fleet.harvest({ workId: "review-api", files: ["SUMMARY.md"] })
    // The guest still has the file, but its content changed after the harvest: it is not recovered.
    w.guest.remote.set("SUMMARY.md", Buffer.from("second\n"))
    await refusal(w.fleet.drop({ workId: "review-api" }), "UNTRACKED")
  })

  test("a harvest with a to folder lands the files there, and the proof still names them", async () => {
    const { w, laptop } = await openWork()
    const elsewhere = join(w.root, "elsewhere")
    await mkdir(elsewhere, { recursive: true })
    await w.fleet.submit({ workId: "review-api", text: "Write SUMMARY.md." })
    w.guest.phaseById.set("ses_root_review-api", "idle")
    w.guest.remote.set("SUMMARY.md", Buffer.from("# Summary\n"))

    const harvested = await w.fleet.harvest({ workId: "review-api", files: ["SUMMARY.md"], to: elsewhere })
    expect(harvested).toMatchObject({ state: "proven", files: [{ path: "SUMMARY.md", sha256: digest("# Summary\n") }] })
    // The file is in the named folder, not the work's own, and the transcript still landed in the work folder.
    expect(await readFile(join(elsewhere, "SUMMARY.md"), "utf8")).toBe("# Summary\n")
    expect(existsSync(join(laptop, "SUMMARY.md"))).toBe(false)
    expect((await w.ledger.load("review-api"))?.downloads?.[0]).toMatchObject({ laptopPath: await realpath(join(elsewhere, "SUMMARY.md")) })
  })

  test("a harvest with no files copies nothing", async () => {
    const { w, laptop } = await openWork()
    await w.fleet.submit({ workId: "review-api", text: "Write nothing." })
    w.guest.phaseById.set("ses_root_review-api", "idle")
    const harvested = await w.fleet.harvest({ workId: "review-api" })
    expect(harvested).not.toHaveProperty("files")
    expect((await w.ledger.load("review-api"))?.downloads).toBeUndefined()
    void laptop
  })
})

describe("the guest server and the snapshot (GAP-25, GAP-29)", () => {
  test("boxd_job on a work with no session reports a dead guest server, not ready", async () => {
    const { w } = await openWork()
    w.guest.serverUp = false
    expect(await w.fleet.job({ workId: "review-api" })).toMatchObject({ state: "starting" })
    w.guest.serverUp = true
    expect(await w.fleet.job({ workId: "review-api" })).toMatchObject({ state: "empty" })
  })

  test("BOXD_MISSING names the PATH and the HOME config, with a next step for a service", async () => {
    const { CODES } = await import("../../src/errors.js")
    expect(CODES.BOXD_MISSING).toContain("PATH")
    expect(CODES.BOXD_MISSING).toContain("HOME")
    expect(CODES.BOXD_MISSING).toContain("~/Library/Application Support/boxd")
    expect(CODES.BOXD_MISSING).toContain("~/.config/boxd")
  })

  test("status checks the snapshot with no work at all", async () => {
    const w = await world()
    expect((await w.fleet.status())).toMatchObject({ works: [], snapshotPresent: true })
  })
})
