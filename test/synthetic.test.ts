import { describe, expect, it } from "vitest"
import { createArgs } from "../src/argv.js"
import { BoxdError } from "../src/errors.js"
import { order, parseExport } from "../src/transfer.js"
import { transfer, world } from "./world.js"

describe("synthetic fleet", () => {
  it("runs a session off the laptop and will not drop it until the import is proven", async () => {
    const { fleet, boxd, guest, prover } = await world()
    const opened = await fleet.ensure({ workId: "review-api", repo: "https://github.com/joe-broadhead/example" })
    expect(opened).toMatchObject({ state: "ready", machine: "oc-review-api", version: "2.2.6" })
    expect(boxd.calls.some((call) => call.includes("--shared") || call.includes("isolated"))).toBe(false)
    expect(boxd.calls).toContain("create oc-review-api opencode-claude-final")

    const admitted = await fleet.submit({ workId: "review-api", text: "Add a health check." })
    expect(admitted).toMatchObject({ state: "admitted", sessionId: "ses_root_review-api" })
    expect(guest.prompts).toEqual(["ses_root_review-api:Add a health check."])

    const busy = await fleet.job({ workId: "review-api" })
    expect(busy.state).toBe("busy")
    await expect(fleet.harvest({ workId: "review-api", localDirectory: "/work/example" })).rejects.toMatchObject({ code: "SESSION_BUSY" })

    guest.phaseById.set("ses_root_review-api", "idle")
    guest.sessions.push({ id: "ses_child_1", parentID: "ses_root_review-api" })
    guest.exports.set("ses_child_1", transfer("ses_child_1", "ses_root_review-api", "child"))

    const proven = await fleet.harvest({ workId: "review-api", localDirectory: "/work/example" })
    expect(proven.state).toBe("proven")
    expect(prover.calls.map((call) => call.remoteId)).toEqual(["ses_root_review-api", "ses_child_1"])
    expect(prover.calls[1]?.parentID).toBe("ses_local_1")

    await expect(fleet.drop({ workId: "review-api" })).resolves.toMatchObject({ state: "dropped" })
    expect(boxd.calls).toContain("remove oc-review-api")
  })

  it("refuses a mismatched guest, a shared machine, a dirty tree, and an unharvested image", async () => {
    const mismatched = await world({ version: "opencode v2.2.5" })
    await expect(mismatched.fleet.ensure({ workId: "review-api" })).rejects.toMatchObject({ code: "GUEST_VERSION" })

    const shared = await world()
    shared.boxd.seed("oc-review-api", "running", { sharing: "shared" })
    await expect(shared.fleet.ensure({ workId: "review-api" })).rejects.toMatchObject({ code: "MACHINE_SHARED" })
    expect(shared.boxd.calls.some((call) => call.startsWith("create"))).toBe(false)

    const dirty = await world()
    await dirty.fleet.ensure({ workId: "review-api" })
    await dirty.fleet.submit({ workId: "review-api", text: "Leave the tree dirty." })
    dirty.guest.phaseById.set("ses_root_review-api", "idle")
    dirty.guest.gitState = { remote: "https://github.com/joe-broadhead/example", branch: "master", sha: "abc", dirty: true }
    await dirty.fleet.harvest({ workId: "review-api", localDirectory: "/work/example" })
    await expect(dirty.fleet.drop({ workId: "review-api" })).rejects.toMatchObject({ code: "DIRTY" })
    expect(dirty.boxd.calls.some((call) => call.startsWith("remove"))).toBe(false)

    const unharvested = await world()
    await unharvested.fleet.ensure({ workId: "review-api" })
    await unharvested.fleet.submit({ workId: "review-api", text: "Still running." })
    await expect(unharvested.fleet.image({ machine: "oc-review-api", name: "opencode-next" })).rejects.toMatchObject({ code: "NOT_PROVEN" })
    expect(createArgs("review-api", "opencode-claude-final").join(" ")).not.toContain("--shared")
    expect(createArgs("review-api", "opencode-claude-final").join(" ")).not.toContain("--isolated")
  })

  it("restarts a destroyed machine from the golden snapshot and the proven transcript", async () => {
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
    expect(guest.imports.map((item) => item.id)).toEqual(["ses_root_review-api", "ses_child_1"])
    expect(guest.imports[1]?.parentID).toMatch(/^ses_guest_/)
    await expect(fleet.drop({ workId: "review-api" })).rejects.toMatchObject({ code: "NOT_PROVEN" })
  })

  it("imports a grandchild only after its parent", () => {
    const ordered = order([
      parseExport(transfer("ses_grand", "ses_child")),
      parseExport({ data: transfer("ses_root") }),
      parseExport(transfer("ses_child", "ses_root")),
    ])
    expect(ordered.map((item) => item.info.id)).toEqual(["ses_root", "ses_child", "ses_grand"])
  })

  it("does not import a child whose parent was never exported", () => {
    expect(() => order([parseExport(transfer("ses_child", "ses_missing"))])).toThrow(BoxdError)
  })
})
