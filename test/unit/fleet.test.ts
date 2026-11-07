import { describe, expect, test } from "bun:test"
import { BoxdError, type Code } from "../../src/errors.js"
import { proofState } from "../../src/fleet.js"
import { createArgs, holdAwakeArgs, AWAKE_SECONDS } from "../../src/argv.js"
import { order, parseExport } from "../../src/transfer.js"
import { transfer, world } from "./fake.js"

const refusal = async (promise: Promise<unknown>, code: Code) => {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  )
  expect(error).toBeInstanceOf(BoxdError)
  expect((error as BoxdError).code).toBe(code)
  expect((error as BoxdError).message).toStartWith(`${code}: `)
  expect((error as BoxdError).message).toContain(" Next step: ")
  return error as BoxdError
}

describe("the control plane", () => {
  test("runs a session off the laptop and refuses to sleep or drop it until the import is proven", async () => {
    const { fleet, boxd, guest, prover } = await world()
    const opened = await fleet.ensure({ workId: "review-api", repo: "https://github.com/joe-broadhead/example" })
    expect(opened).toMatchObject({ state: "ready", machine: "oc-review-api", guestVersion: "2.2.6" })
    expect(boxd.calls.some((call) => call.includes("--shared") || call.includes("isolated"))).toBe(false)
    expect(boxd.calls).toContain("create oc-review-api opencode-claude-final")

    const admitted = await fleet.submit({ workId: "review-api", text: "Add a health check." })
    expect(admitted).toMatchObject({ state: "admitted", sessionId: "ses_root_review-api" })
    expect(guest.prompts).toEqual(["ses_root_review-api:Add a health check."])

    expect((await fleet.job({ workId: "review-api" })).state).toBe("busy")
    await refusal(fleet.harvest({ workId: "review-api", localDirectory: "/work/example" }), "SESSION_BUSY")
    await refusal(fleet.sleep({ workId: "review-api" }), "NOT_PROVEN")
    await refusal(fleet.drop({ workId: "review-api" }), "NOT_PROVEN")

    guest.phaseById.set("ses_root_review-api", "idle")
    guest.sessions.push({ id: "ses_child_1", parentID: "ses_root_review-api" })
    guest.exports.set("ses_child_1", transfer("ses_child_1", "ses_root_review-api", "child"))

    const proven = await fleet.harvest({ workId: "review-api", localDirectory: "/work/example" })
    expect(proven.state).toBe("proven")
    expect(prover.calls.map((call) => call.remoteId)).toEqual(["ses_root_review-api", "ses_child_1"])
    expect(prover.calls[1]?.parentID).toBe("ses_root_review-api")

    // A second harvest is proven again: the prover treats an id that already exists as already imported.
    expect((await fleet.harvest({ workId: "review-api", localDirectory: "/work/example" })).state).toBe("proven")
    await expect(fleet.sleep({ workId: "review-api" })).resolves.toMatchObject({ state: "hibernated" })
    await expect(fleet.drop({ workId: "review-api" })).resolves.toMatchObject({ state: "dropped" })
    expect(boxd.calls).toContain("remove oc-review-api")
  })

  test("refuses a mismatched guest, a shared machine, a dirty tree and an unharvested image", async () => {
    const mismatched = await world({ hostVersion: "2.2.6", version: "opencode v2.2.5" })
    await refusal(mismatched.fleet.ensure({ workId: "review-api" }), "GUEST_VERSION")

    const shared = await world()
    shared.boxd.seed("oc-review-api", "running", { sharing: "shared" })
    await refusal(shared.fleet.ensure({ workId: "review-api" }), "MACHINE_SHARED")
    expect(shared.boxd.calls.some((call) => call.startsWith("create"))).toBe(false)

    const isolated = await world()
    isolated.boxd.seed("oc-review-api", "running", { isolated: true })
    await refusal(isolated.fleet.ensure({ workId: "review-api" }), "MACHINE_ISOLATED")

    const dirty = await world()
    await dirty.fleet.ensure({ workId: "review-api" })
    await dirty.fleet.submit({ workId: "review-api", text: "Leave the tree dirty." })
    dirty.guest.phaseById.set("ses_root_review-api", "idle")
    dirty.guest.gitState = { remote: "https://github.com/joe-broadhead/example", branch: "master", sha: "abc", dirty: true }
    await dirty.fleet.harvest({ workId: "review-api", localDirectory: "/work/example" })
    // Dirty, with no diff in the fake: the patch is not stored, so the disk is not destroyed.
    await refusal(dirty.fleet.drop({ workId: "review-api" }), "DIRTY")

    const unharvested = await world()
    await unharvested.fleet.ensure({ workId: "review-api" })
    await unharvested.fleet.submit({ workId: "review-api", text: "Still running." })
    await refusal(unharvested.fleet.image({ machine: "oc-review-api", name: "opencode-next" }), "NOT_PROVEN")

    expect(createArgs("review-api", "opencode-claude-final").join(" ")).not.toContain("--shared")
    expect(createArgs("review-api", "opencode-claude-final").join(" ")).not.toContain("--isolated")
    expect(createArgs("review-api", "opencode-claude-final").join(" ")).not.toContain("--idle-ignore-outbound")
    expect(holdAwakeArgs("oc-review-api")).toContain(AWAKE_SECONDS)
    expect(holdAwakeArgs("oc-review-api")).not.toContain("0")
  })

  test("a dirty tree whose patch could not be stored blocks drop, and the reason is DIRTY", async () => {
    const { fleet, guest, ledger } = await world()
    await fleet.ensure({ workId: "review-api" })
    await fleet.submit({ workId: "review-api", text: "Unstored change." })
    guest.phaseById.set("ses_root_review-api", "idle")
    await fleet.harvest({ workId: "review-api", localDirectory: "/work/example" })
    const work = await ledger.load("review-api")
    work!.git = { remote: null, branch: null, sha: null, dirty: true, patchStored: false }
    await ledger.save(work!)
    await refusal(fleet.drop({ workId: "review-api" }), "DIRTY")
  })

  test("restarts a destroyed machine from the golden snapshot and the proven transcript", async () => {
    const { fleet, boxd, guest } = await world()
    await fleet.ensure({ workId: "review-api" })
    await fleet.submit({ workId: "review-api", text: "Remember this." })
    guest.phaseById.set("ses_root_review-api", "idle")
    guest.sessions.push({ id: "ses_child_1", parentID: "ses_root_review-api" })
    guest.exports.set("ses_child_1", transfer("ses_child_1", "ses_root_review-api"))
    await fleet.harvest({ workId: "review-api", localDirectory: "/work/example" })
    await fleet.sleep({ workId: "review-api" })
    expect(boxd.machines.get("oc-review-api")?.status).toBe("hibernated")

    boxd.machines.get("oc-review-api")!.status = "destroyed"
    const restarted = await fleet.resume({ workId: "review-api" })
    expect(restarted).toMatchObject({ resumed: "import", state: "ready" })
    expect(boxd.calls.filter((call) => call.startsWith("create")).at(-1)).toBe("create oc-review-api opencode-claude-final")
    expect(boxd.calls.some((call) => call.startsWith("snapshot"))).toBe(false)
    expect(guest.imports.map((item) => item.info.id)).toEqual(["ses_root_review-api", "ses_child_1"])
    await refusal(fleet.drop({ workId: "review-api" }), "NOT_PROVEN")
  })

  test("keeps the guest session id when the admit fails", async () => {
    const { fleet, guest, ledger } = await world()
    await fleet.ensure({ workId: "review-api" })
    guest.prompt = async () => {
      throw new Error("admit failed")
    }
    await expect(fleet.submit({ workId: "review-api", text: "This admit fails." })).rejects.toThrow("admit failed")
    expect((await ledger.load("review-api"))?.rootSessionId).toBe("ses_root_review-api")
  })

  test("image is refused for a machine no work owns, and for an existing snapshot name", async () => {
    const { fleet, boxd } = await world()
    await refusal(fleet.image({ machine: "oc-someone-else", name: "opencode-next" }), "NOT_OURS")
    await fleet.ensure({ workId: "review-api" })
    boxd.snapshots.push({ name: "opencode-next", storage: "local", status: "ready" })
    await refusal(fleet.image({ machine: "oc-review-api", name: "opencode-next" }), "SNAPSHOT_EXISTS")
  })

  test("status reads the ledger, asks boxd for each machine, and never wakes one", async () => {
    const { fleet, boxd } = await world()
    await fleet.ensure({ workId: "review-api" })
    boxd.calls.length = 0
    const status = await fleet.status()
    expect(status.snapshot).toBe("opencode-claude-final")
    expect(status.works).toEqual([{ workId: "review-api", machine: "oc-review-api", sessionId: null, proof: "missing", dirty: false, machineStatus: "running" }])
    expect(boxd.calls.every((call) => call.startsWith("get "))).toBe(true)
  })

  test("a work that was never opened is NOT_OURS, and a second work id cannot adopt another machine", async () => {
    const { fleet, ledger } = await world()
    await refusal(fleet.job({ workId: "never-opened" }), "NOT_OURS")
    await fleet.ensure({ workId: "review-api" })
    const work = await ledger.load("review-api")
    work!.machine = "oc-something-else"
    await ledger.save(work!)
    await refusal(fleet.job({ workId: "review-api" }), "NOT_OURS")
  })
})

describe("proof state", () => {
  test("is fresh only after a harvest later than the last prompt", () => {
    expect(proofState({ workId: "w", machine: "oc-w", snapshot: "s", directory: "/d" })).toBe("missing")
    const proof = { harvestedAt: "2026-11-07T12:00:00.000Z", guestVersion: "2.2.6", sessions: [], sha256: {} }
    expect(proofState({ workId: "w", machine: "oc-w", snapshot: "s", directory: "/d", proof })).toBe("fresh")
    expect(proofState({ workId: "w", machine: "oc-w", snapshot: "s", directory: "/d", proof, lastSubmitAt: "2026-11-07T12:00:01.000Z" })).toBe("stale")
  })
})

describe("session trees", () => {
  test("imports a grandchild only after its parent", () => {
    const ordered = order([parseExport(transfer("ses_grand", "ses_child")), parseExport({ data: transfer("ses_root") }), parseExport(transfer("ses_child", "ses_root"))])
    expect(ordered.map((item) => item.info.id)).toEqual(["ses_root", "ses_child", "ses_grand"])
  })

  test("does not import a child whose parent was never exported", async () => {
    await expect(async () => order([parseExport(transfer("ses_child", "ses_missing"))])).toThrow(/^PARENT_MISSING: /)
  })

  test("refuses an export with no info or messages", async () => {
    await expect(async () => parseExport({ info: { id: "ses_1" } })).toThrow(/^EXPORT_INVALID: /)
  })
})
