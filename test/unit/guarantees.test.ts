// The guarantees behind the billing and data rules, each proved against the fake CLI and the fake guest: a read never wakes, every wake
// arms the awake bound, a rebuild works twice, hibernating is always an exit from billing, a timed-out create is adopted,
// and drop destroys nothing the laptop cannot account for.
import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BoxdError, type Code } from "../../src/errors.js"
import { proofState } from "../../src/fleet.js"
import { world } from "./fake.js"

const refusal = async (promise: Promise<unknown>, code: Code) => {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  )
  expect(error).toBeInstanceOf(BoxdError)
  expect((error as BoxdError).code).toBe(code)
  return error as BoxdError
}

/** A work that is opened, admitted and harvested once, so the next call starts from a proven state. */
async function proven(overrides: { untracked?: string[]; ignored?: string[]; dirty?: boolean; patch?: string } = {}) {
  const w = await world()
  await w.fleet.ensure({ workId: "review-api" })
  await w.fleet.submit({ workId: "review-api", text: "Add a health check." })
  w.guest.phaseById.set("ses_root_review-api", "idle")
  w.guest.gitState = {
    known: true,
    remote: "https://github.com/joe-broadhead/example",
    branch: "master",
    sha: "abc",
    dirty: overrides.dirty ?? false,
    untracked: overrides.untracked ?? [],
    ignored: overrides.ignored ?? [],
    untrackedFiles: Object.fromEntries((overrides.untracked ?? []).map((path) => [path, "aGVsbG8="])),
    ...(overrides.patch ? { patch: overrides.patch } : {}),
  }
  await w.fleet.harvest({ workId: "review-api", localDirectory: await mkdtemp(join(tmpdir(), "boxd-local-")) })
  return w
}

describe("a read never bills", () => {
  test("boxd_job on a hibernated work reports asleep and never calls wake", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api" })
    w.boxd.machines.get("oc-review-api")!.status = "hibernated"
    w.boxd.calls.length = 0
    const job = await w.fleet.job({ workId: "review-api" })
    expect(job).toMatchObject({ state: "asleep", machineStatus: "hibernated" })
    expect(String(job.next)).toContain("boxd_resume")
    expect(w.boxd.calls.filter((call) => call.startsWith("wake"))).toEqual([])
    expect(w.boxd.calls.filter((call) => call.startsWith("hold"))).toEqual([])
  })

  test("boxd_status on a hibernated work never wakes or holds", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api" })
    w.boxd.machines.get("oc-review-api")!.status = "hibernated"
    w.boxd.calls.length = 0
    const status = await w.fleet.status()
    expect(status.works[0]).toMatchObject({ workId: "review-api", machineStatus: "hibernated" })
    expect(w.boxd.calls.filter((call) => call.startsWith("wake") || call.startsWith("hold"))).toEqual([])
  })

  test("a destroyed machine is reported gone, not woken", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api" })
    w.boxd.machines.get("oc-review-api")!.status = "destroyed"
    w.boxd.calls.length = 0
    expect(await w.fleet.job({ workId: "review-api" })).toMatchObject({ state: "gone" })
    expect(w.boxd.calls.filter((call) => call.startsWith("wake"))).toEqual([])
  })
})

describe("every wake arms the awake bound", () => {
  test("ensure on a hibernated machine holds it awake before it returns starting", async () => {
    const w = await world()
    w.boxd.seed("oc-review-api", "hibernated")
    w.boxd.calls.length = 0
    const opened = await w.fleet.ensure({ workId: "review-api" })
    expect(opened.state).toBe("starting")
    expect(w.boxd.calls).toContain("wake oc-review-api")
    expect(w.boxd.calls).toContain("hold oc-review-api")
    expect(w.boxd.calls.indexOf("hold oc-review-api")).toBeGreaterThan(w.boxd.calls.indexOf("wake oc-review-api"))
  })

  test("submit waking a machine holds it awake", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api" })
    w.boxd.machines.get("oc-review-api")!.status = "hibernated"
    w.boxd.calls.length = 0
    await refusal(w.fleet.submit({ workId: "review-api", text: "Later." }), "MACHINE_STARTING")
    expect(w.boxd.calls).toContain("hold oc-review-api")
  })

  test("resume waking a machine holds it awake", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api" })
    w.boxd.machines.get("oc-review-api")!.status = "hibernated"
    w.boxd.calls.length = 0
    expect((await w.fleet.resume({ workId: "review-api" })).resumed).toBe("wake")
    expect(w.boxd.calls).toContain("hold oc-review-api")
  })

  test("a hold that fails is reported to status, not skipped silently", async () => {
    const problems: string[] = []
    const w = await world({ report: (problem) => problems.push(problem) })
    await w.fleet.ensure({ workId: "review-api" })
    w.boxd.holdAwake = async () => {
      throw new BoxdError("BOXD_FAILED", "boxd machine config set failed.")
    }
    w.boxd.machines.get("oc-review-api")!.status = "hibernated"
    await refusal(w.fleet.submit({ workId: "review-api", text: "Later." }), "MACHINE_STARTING")
    expect(problems).toHaveLength(1)
    expect(problems[0]).toStartWith("AWAKE_UNBOUND: ")
  })
})

describe("a rebuild works any number of times", () => {
  test("resume twice recreates twice, forgets the guest helper each time, and prepares again", async () => {
    const w = await proven()
    // The first ensure created a machine too; count the rebuilds from here.
    w.guest.forgotten.length = 0
    for (let round = 1; round <= 2; round++) {
      w.boxd.machines.get("oc-review-api")!.status = "destroyed"
      const resumed = await w.fleet.resume({ workId: "review-api" })
      expect({ round, resumed: resumed.resumed, state: resumed.state }).toEqual({ round, resumed: "import", state: "ready" })
      // One prepare from the first ensure, then one per rebuild.
      expect(w.guest.prepared).toHaveLength(round + 1)
      // The rebuild clears the proof, so a harvest proves the new machine before the next rebuild.
      w.guest.phaseById.set("ses_root_review-api", "idle")
      await w.fleet.harvest({ workId: "review-api", localDirectory: await mkdtemp(join(tmpdir(), "boxd-local-")) })
    }
    // One forget per create, so the next guest call uploads the helper again.
    expect(w.guest.forgotten).toEqual(["oc-review-api", "oc-review-api"])
  })
})

describe("hibernating is always an exit from billing", () => {
  test("sleep works with no proof and records the warning", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api" })
    await w.fleet.submit({ workId: "review-api", text: "Running." })
    const slept = await w.fleet.sleep({ workId: "review-api" })
    expect(slept).toMatchObject({ state: "hibernated" })
    expect(String(slept.warning)).toContain("not harvested")
    const saved = await w.ledger.load("review-api")
    expect(saved?.warnings?.map((warning) => warning.code)).toEqual(["UNHARVESTED_SLEEP"])
    // Status names it, with its own next step.
    const status = await w.fleet.status()
    expect(status.works[0]?.warnings).toEqual(["UNHARVESTED_SLEEP"])
  })

  test("sleep works when the guest cannot be read at all", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api" })
    w.guest.gitFails = true
    w.guest.phase = async () => {
      throw new BoxdError("GUEST_FAILED", "The guest phase failed.")
    }
    await expect(w.fleet.sleep({ workId: "review-api" })).resolves.toMatchObject({ state: "hibernated" })
  })

  test("a fresh harvest clears the warning", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api" })
    await w.fleet.submit({ workId: "review-api", text: "Running." })
    await w.fleet.sleep({ workId: "review-api" })
    await w.fleet.resume({ workId: "review-api" })
    w.boxd.machines.get("oc-review-api")!.status = "running"
    w.guest.phaseById.set("ses_root_review-api", "idle")
    await w.fleet.harvest({ workId: "review-api", localDirectory: await mkdtemp(join(tmpdir(), "boxd-local-")) })
    expect((await w.ledger.load("review-api"))?.warnings).toEqual([])
  })
})

describe("no billing machine the ledger does not know", () => {
  test("the intent is recorded before the create", async () => {
    const w = await world()
    w.boxd.createBehaviour = "timeout-missing"
    await refusal(w.fleet.ensure({ workId: "review-api" }), "CREATE_UNCERTAIN")
    const saved = await w.ledger.load("review-api")
    expect(saved?.pendingCreate).toBeDefined()
    expect(saved?.machine).toBe("oc-review-api")
  })

  test("a create that times out but lands is adopted, and the work is recorded", async () => {
    const w = await world()
    w.boxd.createBehaviour = "timeout-then-exists"
    const opened = await w.fleet.ensure({ workId: "review-api" })
    expect(opened).toMatchObject({ state: "ready", machine: "oc-review-api" })
    expect((await w.ledger.load("review-api"))?.pendingCreate).toBeUndefined()
  })

  test("status names an oc-* machine no ledger records", async () => {
    const w = await world()
    w.boxd.orphans.push("oc-left-behind")
    const status = await w.fleet.status()
    expect(status.orphans).toEqual(["oc-left-behind"])
  })

  test("a machine created shared is removed again, not left unrecorded", async () => {
    const w = await world()
    w.boxd.createBehaviour = "shared"
    await refusal(w.fleet.ensure({ workId: "review-api" }), "NOT_OURS")
    expect(w.boxd.calls).toContain("remove oc-review-api")
  })
})

describe("drop destroys only what the laptop can account for", () => {
  test("a clean, known, proven tree drops", async () => {
    const w = await proven()
    await expect(w.fleet.drop({ workId: "review-api" })).resolves.toMatchObject({ state: "dropped" })
  })

  test("untracked paths are captured, reported, and refuse the drop", async () => {
    const w = await proven({ untracked: ["notes.txt"] })
    const saved = await w.ledger.load("review-api")
    expect(saved?.git?.untracked).toEqual(["notes.txt"])
    expect(saved?.git?.untrackedStored).toBe(true)
    const error = await refusal(w.fleet.drop({ workId: "review-api" }), "UNTRACKED")
    expect(error.message).toContain("notes.txt")
    expect(w.boxd.calls.filter((call) => call.startsWith("remove"))).toEqual([])
  })

  test("ignored paths refuse the drop too", async () => {
    const w = await proven({ ignored: [".env"] })
    const error = await refusal(w.fleet.drop({ workId: "review-api" }), "UNTRACKED")
    expect(error.message).toContain(".env")
  })

  test("a non-git directory refuses the drop, and the harvest says so", async () => {
    const w = await proven()
    w.guest.gitState = { known: false, remote: null, branch: null, sha: null, dirty: false, untracked: [], ignored: [], untrackedFiles: {} }
    w.guest.phaseById.set("ses_root_review-api", "idle")
    const harvested = await w.fleet.harvest({ workId: "review-api", localDirectory: await mkdtemp(join(tmpdir(), "boxd-local-")) })
    expect(harvested.git).toMatchObject({ known: false })
    expect(String(harvested.next)).toContain("not a git repository")
    await refusal(w.fleet.drop({ workId: "review-api" }), "GIT_UNKNOWN")
  })

  test("a dirty tree with a stored patch drops; without one it is DIRTY", async () => {
    const stored = await proven({ dirty: true, patch: "diff --git a/x b/x\n" })
    expect((await stored.ledger.load("review-api"))?.git).toMatchObject({ dirty: true, patchStored: true })
    await expect(stored.fleet.drop({ workId: "review-api" })).resolves.toMatchObject({ state: "dropped" })

    const lost = await proven({ dirty: true })
    const saved = await lost.ledger.load("review-api")
    await lost.ledger.mutate("review-api", (current) => ({ ...(current ?? saved!), git: { ...saved!.git!, patchStored: false } }))
    await refusal(lost.fleet.drop({ workId: "review-api" }), "DIRTY")
  })

  test("an unharvested work still refuses with NOT_PROVEN", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api" })
    await refusal(w.fleet.drop({ workId: "review-api" }), "NOT_PROVEN")
  })

  test("the harvest's next step names what blocks the drop", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api" })
    await w.fleet.submit({ workId: "review-api", text: "Write notes." })
    w.guest.phaseById.set("ses_root_review-api", "idle")
    w.guest.gitState = { known: true, remote: null, branch: null, sha: null, dirty: false, untracked: ["notes.txt"], ignored: [], untrackedFiles: { "notes.txt": "aGk=" } }
    const harvested = await w.fleet.harvest({ workId: "review-api", localDirectory: await mkdtemp(join(tmpdir(), "boxd-local-")) })
    expect(String(harvested.next)).toContain("Commit or delete notes.txt")
  })
})

describe("a create needs its golden image (SNAPSHOT_MISSING)", () => {
  test("ensure refuses before any create when the snapshot is not in the account", async () => {
    const w = await world()
    w.boxd.snapshots.length = 0
    const error = await refusal(w.fleet.ensure({ workId: "review-api" }), "SNAPSHOT_MISSING")
    expect(error.message).toContain("opencode-golden")
    expect(String(error.next)).toContain("docs/golden-image.md")
    expect(w.boxd.calls.filter((call) => call.startsWith("create"))).toEqual([])
  })

  test("resume refuses before rebuilding from a missing snapshot", async () => {
    const w = await proven()
    w.boxd.snapshots.length = 0
    w.boxd.machines.get("oc-review-api")!.status = "destroyed"
    w.boxd.calls.length = 0
    await refusal(w.fleet.resume({ workId: "review-api" }), "SNAPSHOT_MISSING")
    expect(w.boxd.calls.filter((call) => call.startsWith("create"))).toEqual([])
  })

  test("a create proceeds when the snapshot is there", async () => {
    const w = await world()
    expect(w.boxd.snapshots.map((item) => item.name)).toContain("opencode-golden")
    await expect(w.fleet.ensure({ workId: "review-api" })).resolves.toMatchObject({ state: "ready" })
  })

  test("an unreadable snapshot list is not a refusal: the create reports its own error", async () => {
    const w = await world()
    w.boxd.listSnapshots = async () => {
      throw new BoxdError("BOXD_FAILED", "boxd snapshots list failed.")
    }
    await expect(w.fleet.ensure({ workId: "review-api" })).resolves.toMatchObject({ state: "ready" })
  })

  test("status says whether the image is present, and names the doc when it is not", async () => {
    const present = await world()
    expect((await present.fleet.status()).snapshotPresent).toBe(true)
    const missing = await world()
    missing.boxd.snapshots.length = 0
    expect((await missing.fleet.status()).snapshotPresent).toBe(false)
    const unreadable = await world()
    unreadable.boxd.listSnapshots = async () => {
      throw new BoxdError("BOXD_FAILED", "boxd snapshots list failed.")
    }
    expect((await unreadable.fleet.status()).snapshotPresent).toBeNull()
  })
})

describe("the rest of the review", () => {
  test("a cyclic parent chain fails instead of recursing", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api" })
    await w.fleet.submit({ workId: "review-api", text: "Cycle." })
    w.guest.phaseById.set("ses_root_review-api", "idle")
    // root -> child and child -> root: a cycle the guest could send, which must fail rather than recurse.
    w.guest.sessions.push({ id: "ses_child", parentID: "ses_root_review-api" })
    w.guest.sessions[0]!.parentID = "ses_child"
    await refusal(w.fleet.harvest({ workId: "review-api", localDirectory: await mkdtemp(join(tmpdir(), "boxd-local-")) }), "EXPORT_INVALID")
  })

  test("harvest refuses a local directory that does not exist", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api" })
    await w.fleet.submit({ workId: "review-api", text: "Harvest nowhere." })
    w.guest.phaseById.set("ses_root_review-api", "idle")
    await refusal(w.fleet.harvest({ workId: "review-api", localDirectory: join(w.root, "missing") }), "NAME_INVALID")
  })

  test("a submit stamps the prompt before it admits it, so a crash fails towards stale", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api" })
    await w.fleet.submit({ workId: "review-api", text: "First." })
    w.guest.phaseById.set("ses_root_review-api", "idle")
    await w.fleet.harvest({ workId: "review-api", localDirectory: await mkdtemp(join(tmpdir(), "boxd-local-")) })
    const before = await w.ledger.load("review-api")
    expect(proofState(before!)).toBe("fresh")
    w.guest.prompt = async () => {
      throw new Error("the admit failed")
    }
    await expect(w.fleet.submit({ workId: "review-api", text: "Second." })).rejects.toThrow("the admit failed")
    const after = await w.ledger.load("review-api")
    expect(proofState(after!)).toBe("stale")
  })

  test("the harvest stores the patch and the untracked files in the ledger", async () => {
    const w = await proven({ dirty: true, patch: "diff --git a/x b/x\n", untracked: ["notes.txt"] })
    const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: join(w.ledger.root, "works", "review-api") }))
    expect(files.sort()).toContain("patch.diff")
    expect(files.sort()).toContain("untracked.json")
  })
})
