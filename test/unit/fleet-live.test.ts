// What a coordinating agent reads about many works at once (#1): every work's phase and last words in one status call,
// one result shape for a refusal, a model and a size chosen by the call, a bounded wait, the sealed variables by name,
// and refusals that name the input or the paths they are about.
import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BoxdError, type Code } from "../../src/errors.js"
import { parseSecrets } from "../../src/cli-boxd.js"
import { remoteOf } from "../../src/cli-guest.js"
import { errorState, runTool } from "../../src/tools.js"
import { world } from "./fake.js"

const local = () => mkdtemp(join(tmpdir(), "boxd-local-"))

const refusal = async (promise: Promise<unknown>, code: Code) => {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  )
  expect(error).toBeInstanceOf(BoxdError)
  expect((error as BoxdError).code).toBe(code)
  return error as BoxdError
}

/** A world with one work admitted: running, its prompt not harvested. */
async function admitted() {
  const w = await world()
  await w.fleet.ensure({ workId: "review-api" })
  await w.fleet.submit({ workId: "review-api", text: "Add a health check." })
  return w
}

describe("boxd_status reads the whole fleet", () => {
  test("a running work with an unharvested prompt gets its live phase, outcome and last words", async () => {
    const w = await admitted()
    w.guest.phaseById.set("ses_root_review-api", "idle")
    w.guest.runById.set("ses_root_review-api", { outcome: "failed", error: "401 Unauthorized" })
    w.guest.activityById.set("ses_root_review-api", { lastActivityAt: "2026-11-07T12:30:00.000Z", lastText: "The push was refused with 401.", pending: 0 })
    const status = await w.fleet.status({ live: true })
    expect(status.works[0]).toMatchObject({
      workId: "review-api",
      phase: "idle",
      outcome: "failed",
      error: "401 Unauthorized",
      lastActivityAt: "2026-11-07T12:30:00.000Z",
      lastText: "The push was refused with 401.",
      pending: 0,
    })
    // The read is bounded per machine, and asks for no tail.
    expect(w.guest.phaseReads.at(-1)).toEqual({ timeoutMs: 6_000 })
  })

  test("every other state is named without a guest call: empty, harvested, asleep, starting and gone", async () => {
    const w = await world()
    for (const workId of ["empty-one", "harvested", "asleep", "starting", "gone"]) await w.fleet.ensure({ workId })
    await w.fleet.submit({ workId: "harvested", text: "Done soon." })
    w.guest.phaseById.set("ses_root_review-api", "idle")
    await w.fleet.harvest({ workId: "harvested", localDirectory: await local() })
    w.boxd.seed("oc-asleep", "hibernated")
    w.boxd.seed("oc-starting", "starting")
    w.boxd.machines.delete("oc-gone")
    w.guest.phaseReads.length = 0
    const phases = Object.fromEntries((await w.fleet.status({ live: true })).works.map((work) => [work.workId, work.phase]))
    expect(phases).toEqual({ "empty-one": "empty", harvested: "idle", asleep: "asleep", starting: "starting", gone: "gone" })
    // A harvested work's outcome is the harvest's: its guest is not read, so a status loop does not keep it busy.
    expect(w.guest.phaseReads).toEqual([])
  })

  test("a guest that does not answer is unreachable with its code and next step, and the other works still report", async () => {
    const w = await admitted()
    await w.fleet.ensure({ workId: "other" })
    w.guest.phase = async () => {
      throw new BoxdError("GUEST_UNRESPONSIVE", "The guest's phase on oc-review-api did not answer in time, but the machine did: 120 MiB of 15000 MiB memory available.")
    }
    const status = await w.fleet.status({ live: true })
    expect(status.works.find((work) => work.workId === "review-api")).toMatchObject({
      phase: "unreachable",
      error: "GUEST_UNRESPONSIVE",
      message: expect.stringContaining("120 MiB"),
      next: expect.stringContaining("short of memory"),
    })
    expect(status.works.find((work) => work.workId === "other")).toMatchObject({ phase: "empty" })
  })

  test("a guest that hangs is cut off at the status bound, not waited for", async () => {
    const w = await admitted()
    w.guest.phase = () => new Promise(() => {})
    const started = Date.now()
    const status = await w.fleet.status({ live: true })
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(status.works[0]).toMatchObject({ phase: "unreachable", error: "TIMEOUT" })
  }, 25_000)

  test("lists the sealed variables by name, scope and hosts, and keeps a failed read's redacted reason", async () => {
    const w = await world()
    expect((await w.fleet.status({ live: true })).credentials).toEqual({ secrets: [{ name: "GH_TOKEN", scope: "private", hosts: ["github.com"] }] })
    w.boxd.secrets = new Error("env list failed for someone@example.com")
    expect((await w.fleet.status({ live: true })).credentials).toEqual({ error: "env list failed for [email]" })
  })

  test("the status command's own read stays a machine read: no guest call and no variable listing", async () => {
    const w = await admitted()
    w.boxd.calls.length = 0
    w.guest.phaseReads.length = 0
    const status = await w.fleet.status()
    expect(status.works[0]).not.toHaveProperty("phase")
    expect(status).not.toHaveProperty("credentials")
    expect(w.guest.phaseReads).toEqual([])
    expect(w.boxd.calls).not.toContain("env list")
  })

  test("the tool is the live read", async () => {
    const w = await world()
    const answer = await runTool("status", w.fleet, {})
    expect(answer.output).toHaveProperty("credentials")
  })
})

describe("parseSecrets", () => {
  test("reads names, scopes and hosts from the secret list only, never the plain variables and their values", () => {
    const raw = {
      env: [{ name: "PLAIN", scope: "all", value: "visible-value" }],
      secret: [
        { name: "GH_TOKEN", scope: "private", domains: ["github.com", "api.github.com"] },
        { name: "OPENAI_API_KEY", scope: "all", domains: [] },
        { name: "bad name", scope: "all", domains: [] },
      ],
    }
    const secrets = parseSecrets(raw)
    expect(secrets).toEqual([
      { name: "GH_TOKEN", scope: "private", hosts: ["github.com", "api.github.com"] },
      { name: "OPENAI_API_KEY", scope: "all", hosts: [] },
    ])
    expect(JSON.stringify(secrets)).not.toContain("visible-value")
    expect(parseSecrets({})).toEqual([])
  })
})

describe("boxd_job's tail", () => {
  test("passes the count to the guest and returns its messages", async () => {
    const w = await admitted()
    w.guest.phaseById.set("ses_root_review-api", "idle")
    w.guest.activityById.set("ses_root_review-api", { tail: [{ at: "2026-11-07T12:00:00.000Z", text: "First." }, { text: "Second." }] })
    const answer = await runTool("job", w.fleet, { workId: "review-api", tail: 2 })
    expect(answer.output).toMatchObject({ state: "idle", tail: [{ at: "2026-11-07T12:00:00.000Z", text: "First." }, { text: "Second." }] })
    expect(w.guest.phaseReads.at(-1)).toEqual({ tail: 2 })
  })

  test("refuses a count outside 1 to 10, naming the field", async () => {
    const w = await admitted()
    for (const tail of [0, 11, 2.5, "3"]) {
      const answer = await runTool("job", w.fleet, { workId: "review-api", tail })
      expect(answer.output).toMatchObject({ state: "refused", error: "NAME_INVALID", field: "tail" })
    }
  })
})

describe("one result shape", () => {
  test("a refusal carries a state, so a loop reads one shape", async () => {
    const w = await admitted()
    w.guest.phaseById.set("ses_root_review-api", "busy")
    const busy = await runTool("harvest", w.fleet, { workId: "review-api", localDirectory: await local() })
    expect(busy.output).toMatchObject({ workId: "review-api", machine: "oc-review-api", state: "busy", error: "SESSION_BUSY" })
    w.boxd.seed("oc-review-api", "hibernated")
    const asleep = await runTool("harvest", w.fleet, { workId: "review-api", localDirectory: await local() })
    expect(asleep.output).toMatchObject({ state: "starting", error: "MACHINE_STARTING" })
  })

  test("each code maps to the state a read would give it", () => {
    expect(errorState("TIMEOUT")).toBe("unreachable")
    expect(errorState("GUEST_UNRESPONSIVE")).toBe("unreachable")
    expect(errorState("BOXD_FAILED")).toBe("unreachable")
    expect(errorState("MACHINE_STARTING")).toBe("starting")
    expect(errorState("MACHINE_GONE")).toBe("gone")
    expect(errorState("SESSION_BUSY")).toBe("busy")
    expect(errorState("RUN_INTERRUPTED")).toBe("failed")
    expect(errorState("NOT_PROVEN")).toBe("refused")
  })

  test("an invalid work id is not echoed as the subject", async () => {
    const w = await world()
    const answer = await runTool("job", w.fleet, { workId: "Not A Work" })
    expect(answer.output).toMatchObject({ state: "refused", error: "NAME_INVALID" })
    expect(answer.output).not.toHaveProperty("workId")
  })
})

describe("a model chosen by the call", () => {
  test("ensure records the work's default, and the first prompt's session starts on it", async () => {
    const w = await world()
    expect(await w.fleet.ensure({ workId: "review-api", model: "anthropic/claude-sonnet-4-5" })).toMatchObject({ state: "ready", model: "anthropic/claude-sonnet-4-5" })
    expect(await w.fleet.submit({ workId: "review-api", text: "Go." })).toMatchObject({ state: "admitted", model: "anthropic/claude-sonnet-4-5" })
    expect(w.guest.models).toEqual(["create:anthropic/claude-sonnet-4-5"])
    // The session exists now: a prompt without a model keeps it; one with a model switches it.
    const kept = await w.fleet.submit({ workId: "review-api", text: "Again." })
    expect(kept).not.toHaveProperty("model")
    await w.fleet.submit({ workId: "review-api", text: "Harder.", model: "openai/gpt-5#high" })
    expect(w.guest.models).toEqual(["create:anthropic/claude-sonnet-4-5", "switch:openai/gpt-5#high"])
  })

  test("a submit's model starts a new session on it, without a switch", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api" })
    await w.fleet.submit({ workId: "review-api", text: "Go.", model: "openai/gpt-5" })
    expect(w.guest.models).toEqual(["create:openai/gpt-5"])
  })

  test("ensure on a work whose session exists says the session keeps its model", async () => {
    const w = await admitted()
    const answer = await w.fleet.ensure({ workId: "review-api", model: "openai/gpt-5" })
    expect(String(answer.next)).toContain("keeps its model")
  })

  test("a model that is not provider/model is refused by name, before anything runs", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api" })
    for (const model of ["claude", "anthropic/", "/model", "anthropic/claude sonnet", "a/b#"]) {
      const error = await refusal(w.fleet.submit({ workId: "review-api", text: "Go.", model }), "NAME_INVALID")
      expect(error.what).toStartWith("model ")
    }
    expect(w.guest.prompts).toEqual([])
  })
})

describe("a size chosen at ensure", () => {
  test("a machine the call creates is resized before anything runs on it, and the size is recorded", async () => {
    const w = await world()
    const opened = await w.fleet.ensure({ workId: "review-api", vcpu: 4 })
    expect(opened).toMatchObject({ state: "starting", vcpu: 4 })
    expect(w.boxd.calls).toContain("resize oc-review-api 4")
    expect(w.guest.forgotten).toContain("oc-review-api")
    expect((await w.ledger.load("review-api"))?.vcpu).toBe(4)
    // The next ensure finds it and does not resize it again.
    w.boxd.seed("oc-review-api", "running")
    expect(await w.fleet.ensure({ workId: "review-api", vcpu: 4 })).toMatchObject({ state: "ready" })
    expect(w.boxd.calls.filter((call) => call.startsWith("resize"))).toEqual(["resize oc-review-api 4"])
  })

  test("a machine that is already the size is not resized", async () => {
    const w = await world()
    const create = w.boxd.create.bind(w.boxd)
    w.boxd.create = async (input) => ({ ...(await create(input)), vcpu: 2 })
    expect(await w.fleet.ensure({ workId: "review-api", vcpu: 2 })).toMatchObject({ state: "ready", vcpu: 2 })
    expect(w.boxd.calls.some((call) => call.startsWith("resize"))).toBe(false)
  })

  test("an existing machine keeps its size, and the answer says so", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api" })
    const again = await w.fleet.ensure({ workId: "review-api", vcpu: 8 })
    expect(again).toHaveProperty("sizeNote")
    expect(again).not.toHaveProperty("vcpu")
    // One whose size boxd reports keeps it, and says which.
    w.boxd.seed("oc-review-api", "running", { vcpu: 2 })
    expect(await w.fleet.ensure({ workId: "review-api", vcpu: 8 })).toMatchObject({ vcpu: 2, sizeNote: expect.stringContaining("its 2 vCPU") })
    expect(await w.fleet.ensure({ workId: "review-api", vcpu: 2 })).not.toHaveProperty("sizeNote")
    expect(w.boxd.calls.some((call) => call.startsWith("resize"))).toBe(false)
  })

  test("a rebuilt machine gets the recorded size again", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api", vcpu: 4 })
    w.boxd.seed("oc-review-api", "running")
    await w.fleet.submit({ workId: "review-api", text: "Go." })
    w.guest.phaseById.set("ses_root_review-api", "idle")
    await w.fleet.harvest({ workId: "review-api", localDirectory: await local() })
    w.boxd.machines.delete("oc-review-api")
    expect(await w.fleet.resume({ workId: "review-api" })).toMatchObject({ state: "starting", resumed: "import" })
    expect(w.boxd.calls.filter((call) => call.startsWith("resize"))).toEqual(["resize oc-review-api 4", "resize oc-review-api 4"])
  })

  test("the tool refuses a size boxd does not have, naming the field", async () => {
    const w = await world()
    const answer = await runTool("ensure", w.fleet, { workId: "review-api", vcpu: 3 })
    expect(answer.output).toMatchObject({ state: "refused", error: "NAME_INVALID", field: "vcpu" })
    expect(w.boxd.calls.some((call) => call.startsWith("create"))).toBe(false)
  })
})

describe("a bounded wait", () => {
  test("submit with wait polls a starting machine until its OpenCode answers, then admits once", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api" })
    w.boxd.seed("oc-review-api", "hibernated")
    const pauses: number[] = []
    let polls = 0
    const server = w.guest.server.bind(w.guest)
    w.guest.server = async (machine) => (++polls < 3 ? "starting" : server(machine))
    // The world's fleet has no pause seam of its own: build one with the same parts.
    const { createFleet } = await import("../../src/fleet.js")
    const fleet = createFleet({
      boxd: w.boxd,
      guest: w.guest,
      prover: w.prover,
      ledger: w.ledger,
      now: () => new Date().toISOString(),
      snapshot: "opencode-golden",
      hostVersion: "2.2.6",
      projectDirectory: w.root,
      allowedRoots: [],
      pause: async (ms) => void pauses.push(ms),
    })
    expect(await fleet.submit({ workId: "review-api", text: "Go.", wait: true })).toMatchObject({ state: "admitted" })
    expect(w.guest.prompts).toEqual(["ses_root_review-api:Go."])
    expect(w.boxd.calls.filter((call) => call.startsWith("wake"))).toEqual(["wake oc-review-api"])
    expect(pauses.length).toBeGreaterThanOrEqual(2)
    expect(pauses.every((ms) => ms === 3_000)).toBe(true)
  })

  test("without wait, a starting machine is MACHINE_STARTING at once", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api" })
    w.boxd.seed("oc-review-api", "hibernated")
    await refusal(w.fleet.submit({ workId: "review-api", text: "Go." }), "MACHINE_STARTING")
  })

  test("the wait gives up after its bound and says starting", async () => {
    const w = await world()
    w.guest.serverUp = false
    const { createFleet } = await import("../../src/fleet.js")
    const pauses: number[] = []
    const fleet = createFleet({
      boxd: w.boxd,
      guest: w.guest,
      prover: w.prover,
      ledger: w.ledger,
      now: () => new Date().toISOString(),
      snapshot: "opencode-golden",
      hostVersion: "2.2.6",
      projectDirectory: w.root,
      allowedRoots: [],
      pause: async (ms) => void pauses.push(ms),
    })
    expect(await fleet.ensure({ workId: "review-api", wait: true })).toMatchObject({ state: "starting" })
    expect(pauses.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(30_000)
  })
})

describe("refusals that say what they are about", () => {
  test("a drop refused for untracked paths names the first ten, counts the rest, and lists them for a program", async () => {
    const w = await admitted()
    w.guest.phaseById.set("ses_root_review-api", "idle")
    const untracked = Array.from({ length: 60 }, (_, index) => `out/file-${index}.txt`)
    w.guest.gitState = { known: true, remote: null, branch: null, sha: null, dirty: false, untracked, ignored: [], untrackedFiles: {} }
    await w.fleet.harvest({ workId: "review-api", localDirectory: await local() })
    const answer = await runTool("drop", w.fleet, { workId: "review-api" })
    expect(answer.output).toMatchObject({ state: "refused", error: "UNTRACKED", kind: "untracked", count: 60 })
    const output = answer.output as { message: string; paths: string[] }
    expect(output.paths).toHaveLength(50)
    expect(output.message).toContain("60 untracked paths")
    expect(output.message).toContain("out/file-9.txt and 50 more")
    expect(output.message).not.toContain("out/file-10.txt")
  })

  test("a file input that is refused names its place in the list", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api" })
    const error = await refusal(w.fleet.submit({ workId: "review-api", text: "Go.", files: [{ from: join(w.root, "absent.txt"), to: "absent.txt" }] }), "NAME_INVALID")
    expect(error.what).toStartWith("files[0].from: ")
    const outside = await refusal(w.fleet.submit({ workId: "review-api", text: "Go.", files: [{ from: join(w.root, "absent.txt"), to: "../x" }] }), "PATH_REFUSED")
    expect(outside.what).toStartWith("files[0].to: ")
    expect(outside.details).toEqual({ field: "files[0].to" })
  })
})

describe("a harvested remote", () => {
  test("keeps no user information, so a credential placeholder never reaches a result", () => {
    expect(remoteOf("https://x-access-token:bxds_placeholder@github.com/owner/repo.git")).toBe("https://github.com/owner/repo.git")
    expect(remoteOf("https://token@github.com/owner/repo")).toBe("https://github.com/owner/repo")
    expect(remoteOf("https://github.com/owner/repo")).toBe("https://github.com/owner/repo")
    expect(remoteOf("git@github.com:owner/repo.git")).toBe("git@github.com:owner/repo.git")
    expect(remoteOf("")).toBeNull()
  })
})
