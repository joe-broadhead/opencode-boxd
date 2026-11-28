// The guest port and the v1 helper together: the real guest/guest.py runs through the fake CLI against a folder that
// stands in for the machine's disk and the loopback fake of the guest's OpenCode server. A change uploads the helper
// once, to the stable path, and replaces an older copy; a read never uploads, never wakes, and works with the helper
// already there; every answer is checked and the model's words are redacted.
//
// The port and the runner run on the test's own clock, which never moves: the read rule's 2 s listing age never depends
// on how fast the fake CLI's children start on a loaded machine. Every child is still a real process, bounded by the
// runner's own timeouts, so a test's limit is generous rather than tight, and a wait waits for its event, not a count.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BoxdError } from "../../src/errors.js"
import { createBoxdCli } from "../../src/provider/boxd/cli.js"
import { createLaptopPort } from "../../src/provider/laptop.js"
import { createRunner } from "../../src/provider/runner.js"
import type { PluginProvider as Runtime } from "../../src/provider/index.js"
import { helperFile } from "../../src/provider/guest/helper.js"
import { createGuestPort } from "../../src/provider/guest/port.js"
import { GUEST_HELPER_PATH, type ChangeTarget, type MachineId, type OpContext, type ReadTarget } from "../../src/ports.js"
import { startFakeCli, type FakeCli, type FakeMachine } from "../host/fake-cli.js"
import { startFakeGuest, type FakeGuest } from "../host/fake-guest.js"

setDefaultTimeout(120_000)

let guestServer: FakeGuest
let fake: FakeCli
let runtime: Runtime
let machine: FakeMachine
const DIRECTORY = "/home/boxd/work/review-api"
const context = (callId = "call_guest"): OpContext => ({ call: { callId, source: "boxd_ensure" } })
const fail = <T>(promise: Promise<T>) => promise.then(() => undefined, (error: unknown) => error as BoxdError)

beforeAll(() => {
  guestServer = startFakeGuest({ version: "2.4.1" })
})
afterAll(async () => {
  await guestServer.close()
})
beforeEach(async () => {
  await runtime?.dispose()
  fake?.dispose()
  guestServer.sessions.clear()
  guestServer.pending.clear()
  guestServer.quirks.activeFails = false
  guestServer.quirks.ignoresTypeFilter = false
  guestServer.quirks.listFails = false
  guestServer.quirks.listFailsAtPage = 0
  guestServer.quirks.listTimes = true
  guestServer.quirks.vanished.clear()
  fake = startFakeCli({ guestPort: guestServer.port })
  runtime = clocked(fake)
  machine = fake.machine({ name: "oc-review-api", region: "fra", labels: { owner: "boxd" } })
})

/** The plugin's runtime as createRuntime builds it, on a clock that never moves. */
function clocked(cli: FakeCli): Runtime {
  const now = () => Date.parse("2026-11-16T09:00:00Z")
  const runner = createRunner({ now })
  const boxd = createBoxdCli({ bin: cli.bin, runner, now })
  return { runner, boxd, guest: createGuestPort({ boxd, runner }), laptop: createLaptopPort({ runner, bin: cli.opencodeBin }), dispose: () => runner.dispose() }
}

/** Reads serve until the folder's detached clone is no longer running. */
async function cloneEnds(directory: string): Promise<string | undefined> {
  for (;;) {
    const clone = (await serveOf(directory)).clone
    if (clone !== "running") return clone
    await Bun.sleep(50)
  }
}

const onDisk = (path: string) => join(fake.disk(machine), path)
const verbs = () => fake.calls().map((call) => call.split(" ").slice(0, 2).join(" "))
const DONE_PLUGIN_PATH = "/home/boxd/.config/opencode/plugins/boxd-done.js"

/** A change as the fleet makes it: the by-id check, under the machine's lock. */
function change<T>(fn: (target: ChangeTarget) => Promise<T>): Promise<T> {
  return runtime.runner.withMachineLock({ id: machine.id as MachineId }, context(), async () => fn((await runtime.boxd.checkOwned("fra", "oc-review-api", machine.id as MachineId, context())).target))
}

async function readTarget(): Promise<ReadTarget> {
  return { region: "fra", name: "oc-review-api", listing: await runtime.boxd.list({ maxAgeMs: 0 }, context()), machineId: machine.id as MachineId }
}

/** The port's serve read of one folder, which also reports that folder's detached clone. */
const serveOf = async (directory: string) => runtime.guest.serve(await readTarget(), { directory }, context())

const setup = (input: Partial<Parameters<Runtime["guest"]["setup"]>[1]> = {}) => change((target) => runtime.guest.setup(target, { directory: DIRECTORY, opencode: "2.4.1", ...input }, context()))

describe("the helper on the machine", () => {
  test("the first change uploads it and it installs itself at the stable path; the next change is one exec", async () => {
    const first = await setup()
    expect(first).toEqual({ server: "up", opencode: "2.4.1", workspace: "ready", helperUploaded: true })
    const helper = await helperFile()
    expect(createHash("sha256").update(readFileSync(onDisk(GUEST_HELPER_PATH))).digest("hex")).toBe(helper.sha256)
    expect(existsSync(onDisk("/home/boxd/.boxd-plugin-upload.py"))).toBe(false)
    expect(existsSync(onDisk(DIRECTORY))).toBe(true)
    expect(verbs()).toEqual(["machine get", "machine exec", "machine cp", "machine exec"])
    fake.update((state) => { state.log = [] })
    expect((await setup()).helperUploaded).toBe(false)
    expect(verbs()).toEqual(["machine get", "machine exec"])
  })

  test("another copy of the helper changes nothing and is replaced", async () => {
    mkdirSync(onDisk("/home/boxd/.boxd-plugin"), { recursive: true })
    writeFileSync(onDisk(GUEST_HELPER_PATH), readFileSync(new URL("../../guest/guest.py", import.meta.url)).toString().replace("PROTOCOL = 1", "PROTOCOL = 1  # an older build"))
    expect((await setup()).helperUploaded).toBe(true)
    expect(verbs().filter((verb) => verb === "machine cp")).toHaveLength(1)
  })

  test("setup writes the completion tool once, rewrites only a changed copy, and never restarts the server for it", async () => {
    await setup()
    const written = readFileSync(onDisk(DONE_PLUGIN_PATH), "utf8")
    expect(written).toContain('name: "done"')
    expect(written).toContain('editor.namespace({ name: "boxd"')
    expect(written).toContain("as your last act")
    const first = statSync(onDisk(DONE_PLUGIN_PATH))
    await setup()
    expect(statSync(onDisk(DONE_PLUGIN_PATH)).ino).toBe(first.ino)
    writeFileSync(onDisk(DONE_PLUGIN_PATH), "// stale\n")
    await setup()
    expect(statSync(onDisk(DONE_PLUGIN_PATH)).ino).not.toBe(first.ino)
    expect(readFileSync(onDisk(DONE_PLUGIN_PATH), "utf8")).toBe(written)
    // The fake server answers as a running one: a restart would have written a pid file and stopped it.
    guestServer.sessions.set("ses_busy", { id: "ses_busy", busy: true, directory: DIRECTORY, messages: [], inbox: [], updated: 1 })
    rmSync(onDisk(DONE_PLUGIN_PATH))
    expect((await setup()).server).toBe("up")
    expect(existsSync(onDisk(DONE_PLUGIN_PATH))).toBe(true)
    expect(existsSync(onDisk("/home/boxd/.boxd-plugin/server.pid"))).toBe(false)
    expect(guestServer.sessions.get("ses_busy")?.busy).toBe(true)
  })

  test("an upload that is not the copy the plugin sent installs nothing and changes nothing", async () => {
    const upload = onDisk("/home/boxd/.boxd-plugin-upload.py")
    writeFileSync(upload, readFileSync(new URL("../../guest/guest.py", import.meta.url)))
    const target = await readTarget()
    const result = await change((owned) =>
      runtime.boxd.exec(owned, "python3 /home/boxd/.boxd-plugin-upload.py --install", { timeoutSeconds: 8, json: false, stdin: JSON.stringify({ action: "setup", helper: "0".repeat(64), directory: DIRECTORY }) }, context()),
    )
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ ok: false, error: "HELPER_OUTDATED" })
    expect(existsSync(upload)).toBe(false)
    expect(existsSync(onDisk(GUEST_HELPER_PATH))).toBe(false)
    expect(existsSync(onDisk(DIRECTORY))).toBe(false)
    expect(target.name).toBe("oc-review-api")
  })

  test("a read never uploads: a machine without the helper answers GUEST_FAILED with no copy", async () => {
    const error = await fail(runtime.guest.serve(await readTarget(), {}, context()))
    expect(error?.code).toBe("GUEST_FAILED")
    expect(error?.what).toContain("a read never uploads one")
    expect(verbs()).not.toContain("machine cp")
  })

  test("a read on a hibernated machine runs nothing and wakes nothing", async () => {
    await setup()
    fake.update((state) => { state.machines[0]!.status = "hibernated" })
    fake.update((state) => { state.log = [] })
    expect((await fail(runtime.guest.serve(await readTarget(), {}, context())))?.code).toBe("MACHINE_ASLEEP")
    expect(verbs()).toEqual(["machine list"])
    expect(fake.read().wokenByExec ?? []).toEqual([])
  })

  test("serve reports the server and the release, and starts nothing", async () => {
    await setup()
    expect(await runtime.guest.serve(await readTarget(), {}, context())).toEqual({ server: "up", opencode: "2.4.1" })
  })

  test("two identical reads in flight share one exec", async () => {
    await setup()
    fake.update((state) => { state.log = [] })
    const target = await readTarget()
    await Promise.all([runtime.guest.serve(target, {}, context()), runtime.guest.serve(target, {}, context())])
    expect(verbs().filter((verb) => verb === "machine exec")).toHaveLength(1)
  })
})

describe("sessions", () => {
  /**
   * A tree larger than one /api/session page: 57 children with increasing times, and the oldest child running. Page
   * one holds the newest 50 children; the busy oldest child and the root are on page two.
   */
  function largeTree(): number {
    const base = 1_700_000_000_000
    guestServer.sessions.set("ses_root", { id: "ses_root", busy: false, directory: DIRECTORY, messages: [], inbox: [], updated: base })
    for (let index = 1; index <= 57; index += 1) {
      guestServer.sessions.set(`ses_child_${index}`, { id: `ses_child_${index}`, parentID: "ses_root", busy: index === 1, directory: DIRECTORY, messages: [], inbox: [], updated: base + index * 1000 })
    }
    return base
  }

  test("prompt makes the session, then steers, queues or interrupts a running one", async () => {
    await setup()
    guestServer.next("ses_root")
    const started = await change((target) => runtime.guest.prompt(target, { directory: DIRECTORY, sessionId: null, title: "review-api", text: "Add a health check.", delivery: "steer" }, context()))
    expect(started).toMatchObject({ sessionId: "ses_root", delivery: "started", interrupted: false, waitingBefore: 0 })
    const steered = await change((target) => runtime.guest.prompt(target, { directory: DIRECTORY, sessionId: "ses_root", title: "x", text: "Also log it.", delivery: "steer" }, context()))
    expect(steered).toMatchObject({ delivery: "steer", waitingBefore: 0, inboxId: "msg_inbox_0" })
    const queued = await change((target) => runtime.guest.prompt(target, { directory: DIRECTORY, sessionId: "ses_root", title: "x", text: "Then docs.", delivery: "queue" }, context()))
    expect(queued).toMatchObject({ delivery: "queue", waitingBefore: 1 })
    const phase = await runtime.guest.phase(await readTarget(), { sessionId: "ses_root" }, context())
    expect(phase).toMatchObject({ phase: "busy", waiting: { steer: 1, queue: 1 }, guestVersion: "2.4.1" })
    const interrupted = await change((target) => runtime.guest.prompt(target, { directory: DIRECTORY, sessionId: "ses_root", title: "x", text: "Stop and do this.", delivery: "interrupt" }, context()))
    expect(interrupted).toMatchObject({ interrupted: true, delivery: "started" })
    expect(guestServer.interrupts).toEqual(["ses_root"])
  })

  test("a model switch on a running session is SESSION_BUSY unless it interrupts", async () => {
    await setup()
    guestServer.next("ses_root")
    await change((target) => runtime.guest.prompt(target, { directory: DIRECTORY, sessionId: null, title: "t", text: "go", delivery: "steer" }, context()))
    const refused = await fail(change((target) => runtime.guest.prompt(target, { directory: DIRECTORY, sessionId: "ses_root", title: "t", text: "go", delivery: "steer", model: "anthropic/claude-sonnet-4-5" }, context())))
    expect(refused?.code).toBe("SESSION_BUSY")
    const switched = await change((target) => runtime.guest.prompt(target, { directory: DIRECTORY, sessionId: "ses_root", title: "t", text: "go", delivery: "interrupt", model: "anthropic/claude-sonnet-4-5" }, context()))
    expect(switched.model).toBe("anthropic/claude-sonnet-4-5")
    expect(guestServer.switches.at(-1)).toEqual({ sessionID: "ses_root", model: { providerID: "anthropic", id: "claude-sonnet-4-5" } })
  })

  test("a staged file moves into the work tree with the prompt; one outside the staging folder is refused", async () => {
    await setup()
    mkdirSync(onDisk("/home/boxd/.boxd-plugin/staging"), { recursive: true })
    writeFileSync(onDisk("/home/boxd/.boxd-plugin/staging/f1"), "data")
    guestServer.next("ses_files")
    await change((target) => runtime.guest.prompt(target, { directory: DIRECTORY, sessionId: null, title: "t", text: "use it", delivery: "steer", files: [{ staged: "/home/boxd/.boxd-plugin/staging/f1", to: "data/input.json" }] }, context()))
    expect(readFileSync(onDisk(`${DIRECTORY}/data/input.json`), "utf8")).toBe("data")
    const refused = await fail(change((target) => runtime.guest.prompt(target, { directory: DIRECTORY, sessionId: "ses_files", title: "t", text: "x", delivery: "steer", files: [{ staged: "/home/boxd/elsewhere", to: "x" }] }, context())))
    expect(refused?.code).toBe("NAME_INVALID")
  })

  test("phase: the outcome, the failed run's error line, needs-input, and the model's words redacted and cut", async () => {
    await setup()
    guestServer.next("ses_done")
    await change((target) => runtime.guest.prompt(target, { directory: DIRECTORY, sessionId: null, title: "t", text: "go", delivery: "steer" }, context()))
    guestServer.say("ses_done", `Done. The key is sk-abcdefghijklmnopqrstuvwx. ${"word ".repeat(200)}`, 1_763_200_000_000)
    guestServer.fail("ses_done", { type: "provider.auth", message: "401 Unauthorized\nbody with token=abc" })
    guestServer.pending.set("ses_done", "permission")
    const phase = await runtime.guest.phase(await readTarget(), { sessionId: "ses_done", tail: 2 }, context())
    expect(phase).toMatchObject({ phase: "idle", outcome: "failed", error: "provider.auth: 401 Unauthorized body with token=[redacted]", needsInput: "permission", lastActivityAt: "2025-11-15T09:46:40.000Z" })
    expect(phase.lastText).toStartWith("Done. The key is [redacted].")
    expect(Array.from(phase.lastText!).length).toBeLessThanOrEqual(300)
    expect(phase.tail).toHaveLength(1)
    // The helper reads /proc, which only the guest's Linux has; elsewhere the reading is there, at zero.
    if (process.platform === "linux") expect(phase.reading?.residentGiB).toBeGreaterThan(0)
    else expect(phase.reading).toEqual({ residentGiB: 0, load1: 0 })
    expect(await runtime.guest.phase(await readTarget(), { sessionId: "ses_none" }, context())).toMatchObject({ phase: "missing", outcome: null })
  })

  test("phase: full returns a message over the helper's 2,000-character cap whole, with its lines; the default still cuts to 300", async () => {
    await setup()
    guestServer.next("ses_report")
    await change((target) => runtime.guest.prompt(target, { directory: DIRECTORY, sessionId: null, title: "t", text: "go", delivery: "steer" }, context()))
    const report = Array.from({ length: 300 }, (_, index) => `row ${index}: ${"value ".repeat(3).trim()}`).join("\n")
    expect(report.length).toBeGreaterThan(2000)
    guestServer.say("ses_report", report, 1_763_200_000_000)
    guestServer.complete("ses_report")
    const target = await readTarget()
    const cut = await runtime.guest.phase(target, { sessionId: "ses_report" }, context())
    expect(Array.from(cut.lastText!).length).toBe(300)
    expect(cut.lastText!.endsWith("…")).toBe(true)
    const full = await runtime.guest.phase(target, { sessionId: "ses_report", full: true }, context())
    expect(full.lastText).toBe(report)
    // The helper's own cap: a message over it comes back cut at 64,000 characters.
    const huge = `start\n${"word ".repeat(14000).trim()}`
    expect(huge.length).toBeGreaterThan(64_000)
    guestServer.say("ses_report", huge, 1_763_200_001_000)
    const capped = await runtime.guest.phase(target, { sessionId: "ses_report", full: true }, context())
    expect(Array.from(capped.lastText!).length).toBe(64_000)
  })

  test("phase is busy while a child session runs, and lastActivityAt is the tree's newest time", async () => {
    await setup()
    guestServer.sessions.set("ses_root", { id: "ses_root", busy: false, directory: DIRECTORY, messages: [], inbox: [], updated: 1_700_000_000_000 })
    guestServer.sessions.set("ses_child", { id: "ses_child", parentID: "ses_root", busy: true, directory: DIRECTORY, messages: [], inbox: [], updated: 1_700_000_000_000 })
    guestServer.say("ses_root", "The coordinator's report.", 1_700_000_000_500)
    guestServer.say("ses_child", "The subagent's own words.", 1_763_200_000_000)
    const phase = await runtime.guest.phase(await readTarget(), { sessionId: "ses_root" }, context())
    expect(phase).toMatchObject({ phase: "busy", lastActivityAt: "2025-11-15T09:46:40.000Z", lastText: "The coordinator's report." })
    expect(phase.outcome).toBeNull()
  })

  test("phase stays idle when every session in the tree is idle, with the tree's newest time", async () => {
    await setup()
    guestServer.sessions.set("ses_root", { id: "ses_root", busy: false, directory: DIRECTORY, messages: [], inbox: [], updated: 1_700_000_000_000 })
    guestServer.sessions.set("ses_child", { id: "ses_child", parentID: "ses_root", busy: false, directory: DIRECTORY, messages: [], inbox: [], updated: 1_763_200_000_000 })
    guestServer.complete("ses_root")
    const phase = await runtime.guest.phase(await readTarget(), { sessionId: "ses_root" }, context())
    expect(phase).toMatchObject({ phase: "idle", outcome: "completed", lastActivityAt: "2025-11-15T09:46:40.000Z" })
  })

  test("phase stays busy when the root runs, whatever the children say", async () => {
    await setup()
    guestServer.sessions.set("ses_root", { id: "ses_root", busy: true, directory: DIRECTORY, messages: [], inbox: [], updated: 1_700_000_000_000 })
    guestServer.sessions.set("ses_child", { id: "ses_child", parentID: "ses_root", busy: false, directory: DIRECTORY, messages: [], inbox: [], updated: 1_700_000_000_000 })
    expect(await runtime.guest.phase(await readTarget(), { sessionId: "ses_root" }, context())).toMatchObject({ phase: "busy" })
  })

  test("phase ignores a busy child of another root, and a child that vanishes while the tree is read", async () => {
    await setup()
    guestServer.sessions.set("ses_root", { id: "ses_root", busy: false, directory: DIRECTORY, messages: [], inbox: [], updated: 1_700_000_000_000 })
    guestServer.sessions.set("ses_other", { id: "ses_other", busy: false, directory: DIRECTORY, messages: [], inbox: [], updated: 1_700_000_000_000 })
    guestServer.sessions.set("ses_stranger", { id: "ses_stranger", parentID: "ses_other", busy: true, directory: DIRECTORY, messages: [], inbox: [], updated: 1_763_200_000_000 })
    expect(await runtime.guest.phase(await readTarget(), { sessionId: "ses_root" }, context())).toMatchObject({ phase: "idle", lastActivityAt: "2023-11-14T22:13:20.000Z" })
    // A list without times reads each child; one that disappears in between is skipped, not failed.
    guestServer.sessions.set("ses_gone", { id: "ses_gone", parentID: "ses_root", busy: true, directory: DIRECTORY, messages: [], inbox: [], updated: 1_763_200_000_000 })
    guestServer.quirks.listTimes = false
    guestServer.quirks.vanished.add("ses_gone")
    expect(await runtime.guest.phase(await readTarget(), { sessionId: "ses_root" }, context())).toMatchObject({ phase: "idle", lastActivityAt: "2023-11-14T22:13:20.000Z" })
  })

  test("a failed tree listing fails the phase read instead of reporting an idle tree", async () => {
    await setup()
    guestServer.sessions.set("ses_root", { id: "ses_root", busy: true, directory: DIRECTORY, messages: [], inbox: [], updated: 1_700_000_000_000 })
    guestServer.quirks.listFails = true
    expect((await fail(runtime.guest.phase(await readTarget(), { sessionId: "ses_root" }, context())))?.code).toBe("GUEST_FAILED")
  })

  test("phase follows every page: a busy child older than the newest 50 sessions still makes the work busy", async () => {
    await setup()
    const base = largeTree()
    const phase = await runtime.guest.phase(await readTarget(), { sessionId: "ses_root" }, context())
    expect(phase).toMatchObject({ phase: "busy", lastActivityAt: new Date(base + 57_000).toISOString() })
  })

  test("a later page that fails fails the phase read instead of reporting an idle tree", async () => {
    await setup()
    largeTree()
    guestServer.quirks.listFailsAtPage = 2
    expect((await fail(runtime.guest.phase(await readTarget(), { sessionId: "ses_root" }, context())))?.code).toBe("GUEST_FAILED")
  })

  test("export writes each session of the tree on the guest with its marks; the copy back matches its digest", async () => {
    await setup()
    guestServer.next("ses_parent")
    await change((target) => runtime.guest.prompt(target, { directory: DIRECTORY, sessionId: null, title: "t", text: "go", delivery: "steer" }, context()))
    guestServer.complete("ses_parent")
    guestServer.sessions.set("ses_child", { id: "ses_child", parentID: "ses_parent", busy: false, directory: DIRECTORY, messages: [{ type: "user", text: "sub" }], inbox: [], updated: 5 })
    const answer = await change((target) => runtime.guest.export(target, { rootId: "ses_parent" }, context()))
    if (answer.outcome !== "exported") throw new Error(answer.reason)
    const exported = answer
    expect(exported).toMatchObject({ busy: false, run: { outcome: "completed" } })
    expect(exported.sessions.map((session) => [session.id, session.parentId, session.messages, session.lastMessageId])).toEqual([
      ["ses_parent", null, 2, "msg_1"],
      ["ses_child", "ses_parent", 1, "msg_0"],
    ])
    const local = join(fake.dir, "parent.json")
    await change((target) => runtime.boxd.copyFrom(target, exported.sessions[0]!.file, local, context()))
    expect(createHash("sha256").update(readFileSync(local)).digest("hex")).toBe(exported.sessions[0]!.sha256)
    expect(exported.guestVersion).toBe("2.4.1")
    expect((await fail(change((target) => runtime.guest.export(target, { rootId: "ses_missing" }, context()))))?.code).toBe("SESSION_MISSING")
  })

  test("export checks the tree is idle in the same exec: a running tree is busy and writes nothing, unless partial", async () => {
    await setup()
    guestServer.next("ses_parent")
    await change((target) => runtime.guest.prompt(target, { directory: DIRECTORY, sessionId: null, title: "t", text: "go", delivery: "steer" }, context()))
    fake.update((state) => { state.log = [] })
    const busy = await change((target) => runtime.guest.export(target, { rootId: "ses_parent" }, context()))
    expect(busy).toMatchObject({ outcome: "busy", guestVersion: "2.4.1" })
    expect(existsSync(onDisk("/home/boxd/.boxd-plugin/exports/ses_parent.json"))).toBe(false)
    expect(verbs()).toEqual(["machine get", "machine exec"])
    const partial = await change((target) => runtime.guest.export(target, { rootId: "ses_parent", partial: true }, context()))
    // A live run has no outcome yet: a partial export never reports it as aborted.
    expect(partial).toMatchObject({ outcome: "exported", busy: true, run: { outcome: null } })
  })

  test("import puts a tree back, parents first, and answers its root", async () => {
    await setup()
    mkdirSync(onDisk("/home/boxd/.boxd-plugin/imports"), { recursive: true })
    writeFileSync(onDisk("/home/boxd/.boxd-plugin/imports/child.json"), JSON.stringify({ info: { id: "ses_kid", parentID: "ses_top" }, messages: [] }))
    writeFileSync(onDisk("/home/boxd/.boxd-plugin/imports/top.json"), JSON.stringify({ info: { id: "ses_top" }, messages: [] }))
    const answer = await change((target) =>
      runtime.guest.import(target, { directory: DIRECTORY, files: ["/home/boxd/.boxd-plugin/imports/child.json", "/home/boxd/.boxd-plugin/imports/top.json"] }, context()),
    )
    expect(answer).toEqual({ rootId: "ses_top" })
    expect(guestServer.imports.map((item) => item.id)).toEqual(["ses_top", "ses_kid"])
  })
})

describe("the work tree", () => {
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", onDisk(DIRECTORY), ...args])

  test("git: the tree's state, a patch file on the guest, untracked and ignored paths with digests, the remote without userinfo, and the session marks", async () => {
    await setup()
    git("init", "--quiet")
    writeFileSync(onDisk(`${DIRECTORY}/README.md`), "one\n")
    writeFileSync(onDisk(`${DIRECTORY}/.gitignore`), "build/\n")
    git("add", ".")
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "init")
    git("remote", "add", "origin", "https://x-access-token:secret@github.com/o/r")
    writeFileSync(onDisk(`${DIRECTORY}/README.md`), "two\n")
    writeFileSync(onDisk(`${DIRECTORY}/notes.txt`), "notes")
    mkdirSync(onDisk(`${DIRECTORY}/build`))
    writeFileSync(onDisk(`${DIRECTORY}/build/out.bin`), "1234")
    guestServer.next("ses_g")
    await change((target) => runtime.guest.prompt(target, { directory: DIRECTORY, sessionId: null, title: "t", text: "go", delivery: "steer" }, context()))
    const answer = await change((target) => runtime.guest.git(target, { directory: DIRECTORY, rootId: "ses_g" }, context()))
    expect(answer).toMatchObject({ known: true, dirty: true, remote: "https://github.com/o/r", branch: expect.any(String) })
    expect(answer.untracked).toEqual([{ path: "notes.txt", bytes: 5, sha256: createHash("sha256").update("notes").digest("hex") }])
    expect(answer.ignored).toEqual([{ path: "build/", bytes: 4, sha256: "" }])
    // The only commit is on no remote ref: the work would lose it if the machine went (#39).
    expect(answer.unpushedCount).toBe(1)
    expect(answer.unpushedKnown).toBe(true)
    expect(answer.unpushed).toEqual([expect.stringMatching(/^[0-9a-f]{7,} init$/)])
    expect(answer.patch?.file).toBe("/home/boxd/.boxd-plugin/harvest/patch.diff")
    expect(readFileSync(onDisk(answer.patch!.file), "utf8")).toContain("+two")
    expect(answer.sessions).toEqual([{ id: "ses_g", parentId: null, lastMessageId: "msg_0", messages: 1, updated: 1 }])
  })

  test("git never reads an enclosing repository: a work folder nested in another repo, with no repo of its own, is not known", async () => {
    await setup()
    const outer = onDisk("/home/boxd")
    Bun.spawnSync(["git", "init", "--quiet", outer])
    writeFileSync(join(outer, "outer.txt"), "outer")
    Bun.spawnSync(["git", "-C", outer, "add", "outer.txt"])
    Bun.spawnSync(["git", "-C", outer, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "outer"])
    writeFileSync(join(outer, "outer.txt"), "changed")
    writeFileSync(onDisk(`${DIRECTORY}/inner.txt`), "inner")
    expect(await change((target) => runtime.guest.git(target, { directory: DIRECTORY }, context()))).toEqual({ known: false, remote: null, branch: null, sha: null, dirty: false, untracked: [], ignored: [], unpushed: [], unpushedCount: 0, unpushedKnown: true })
    // Its own repository, inside the outer one, is read alone: the outer change is not its state.
    git("init", "--quiet")
    const own = await change((target) => runtime.guest.git(target, { directory: DIRECTORY }, context()))
    expect(own).toMatchObject({ known: true, dirty: false, untracked: [{ path: "inner.txt", bytes: 5 }] })
  })

  test("git refuses a work folder whose repository's top is elsewhere", async () => {
    await setup()
    const outer = onDisk("/home/boxd")
    Bun.spawnSync(["git", "init", "--quiet", outer])
    Bun.spawnSync(["git", "-C", outer, "config", "core.worktree", outer])
    writeFileSync(onDisk(`${DIRECTORY}/.git`), `gitdir: ${join(outer, ".git")}\n`)
    const error = await fail(change((target) => runtime.guest.git(target, { directory: DIRECTORY }, context())))
    expect([error?.code, error?.what]).toEqual(["GIT_UNKNOWN", "The guest helper's git failed (the work folder is not the top of its own git repository)."])
  })

  test("git ignores every inherited GIT_* variable: the work's own repository is read, never another, and nothing fails", async () => {
    await setup()
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", onDisk(DIRECTORY), ...args])
    const outer = onDisk("/home/boxd")
    Bun.spawnSync(["git", "init", "--quiet", outer])
    git("init", "--quiet")
    writeFileSync(onDisk(`${DIRECTORY}/a.txt`), "a")
    git("add", "a.txt")
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "a")
    const inherited = {
      GIT_DIR: join(outer, ".git"),
      GIT_WORK_TREE: outer,
      GIT_COMMON_DIR: join(outer, ".git"),
      GIT_INDEX_FILE: join(fake.dir, "no-such-index"),
      GIT_OBJECT_DIRECTORY: join(fake.dir, "no-such-objects"),
      GIT_CEILING_DIRECTORIES: "",
    }
    const saved = Object.fromEntries(Object.keys(inherited).map((name) => [name, process.env[name]]))
    Object.assign(process.env, inherited)
    try {
      const answer = await change((target) => runtime.guest.git(target, { directory: DIRECTORY }, context()))
      expect(answer).toMatchObject({ known: true, dirty: false, untracked: [] })
      expect(answer.sha).toMatch(/^[0-9a-f]{40}$/)
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  test("git refuses a .git link to another repository's git data, as a file or a symlink: works are plain clones", async () => {
    await setup()
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", onDisk(DIRECTORY), ...args])
    const other = join(fake.dir, "other")
    Bun.spawnSync(["git", "init", "--quiet", other])
    writeFileSync(onDisk(`${DIRECTORY}/.git`), `gitdir: ${join(other, ".git")}\n`)
    const linked = await fail(change((target) => runtime.guest.git(target, { directory: DIRECTORY }, context())))
    expect([linked?.code, linked?.what]).toEqual([
      "GIT_UNKNOWN",
      "The guest helper's git failed (the work folder's git data lies outside it (a .git link to another repository); works are plain clones).",
    ])
    rmSync(onDisk(`${DIRECTORY}/.git`))
    symlinkSync(join(other, ".git"), onDisk(`${DIRECTORY}/.git`))
    expect((await fail(change((target) => runtime.guest.git(target, { directory: DIRECTORY }, context()))))?.code).toBe("GIT_UNKNOWN")
    // Its own plain repository is read as before.
    rmSync(onDisk(`${DIRECTORY}/.git`))
    git("init", "--quiet")
    expect(await change((target) => runtime.guest.git(target, { directory: DIRECTORY }, context()))).toMatchObject({ known: true })
  })

  test("git on a folder that is not a repository says so", async () => {
    await setup()
    expect(await change((target) => runtime.guest.git(target, { directory: DIRECTORY }, context()))).toMatchObject({ known: false, dirty: false, untracked: [], ignored: [] })
  })

  test("read: a text file, a binary file, the server log, and a symlink out of the tree refused", async () => {
    await setup()
    writeFileSync(onDisk(`${DIRECTORY}/a.txt`), "line1\nline2\nline3\n")
    writeFileSync(onDisk(`${DIRECTORY}/b.bin`), Buffer.from([0xff, 0xfe, 0x00, 0x01]))
    symlinkSync("/etc/hostname", onDisk(`${DIRECTORY}/out`))
    const target = await readTarget()
    expect(await runtime.guest.read(target, { directory: DIRECTORY, path: "a.txt", maxBytes: 100 }, context())).toEqual({ binary: false, path: "a.txt", bytes: 18, truncated: false, text: "line1\nline2\nline3\n" })
    expect(await runtime.guest.read(target, { directory: DIRECTORY, path: "a.txt", maxBytes: 100, tail: 1 }, context())).toMatchObject({ text: "line3" })
    expect(await runtime.guest.read(target, { directory: DIRECTORY, path: "a.txt", maxBytes: 4 }, context())).toMatchObject({ text: "line", truncated: true })
    expect(await runtime.guest.read(target, { directory: DIRECTORY, path: "b.bin", maxBytes: 100 }, context())).toEqual({ binary: true, path: "b.bin", bytes: 4, sha256: createHash("sha256").update(Buffer.from([0xff, 0xfe, 0x00, 0x01])).digest("hex") })
    expect(await runtime.guest.read(target, { directory: DIRECTORY, log: "server", maxBytes: 100 }, context())).toMatchObject({ binary: false, path: "server.log" })
    expect((await fail(runtime.guest.read(target, { directory: DIRECTORY, path: "out", maxBytes: 100 }, context())))?.code).toBe("PATH_REFUSED")
    expect((await fail(runtime.guest.read(target, { directory: DIRECTORY, path: "../x", maxBytes: 100 }, context())))?.code).toBe("NAME_INVALID")
  })

  test("a clone runs detached: setup answers cloning, serve reports it, and the next setup joins it", async () => {
    const origin = join(fake.dir, "origin")
    Bun.spawnSync(["git", "init", "--quiet", origin])
    writeFileSync(join(origin, "f"), "x")
    Bun.spawnSync(["git", "-C", origin, "add", "."])
    Bun.spawnSync(["git", "-C", origin, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "c"])
    const first = await setup({ repo: { url: `file://${origin}` }, git: { name: "Work", email: "work@example.invalid" } })
    expect(first.workspace).toBe("cloning")
    expect(await cloneEnds(DIRECTORY)).toBe("done")
    expect(existsSync(onDisk(`${DIRECTORY}/.git`))).toBe(true)
    expect(readFileSync(onDisk(`${DIRECTORY}/f`), "utf8")).toBe("x")
    expect((await setup({ repo: { url: `file://${origin}` } })).workspace).toBe("ready")
  })

  test("a failed clone answers GUEST_WORKSPACE once, and the next setup tries again", async () => {
    const repo = { url: `file://${join(fake.dir, "no-such-repo")}` }
    expect((await setup({ repo })).workspace).toBe("cloning")
    expect(await cloneEnds(DIRECTORY)).toBe("failed")
    expect((await fail(setup({ repo })))?.code).toBe("GUEST_WORKSPACE")
    expect((await setup({ repo })).workspace).toBe("cloning")
  })
})

describe("machine care", () => {
  // The guest is Linux: health reads /proc, which a macOS test machine does not have.
  test.skipIf(process.platform !== "linux")("health: memory, load and the heaviest processes by name", async () => {
    await setup()
    const health = await runtime.guest.health(await readTarget(), context())
    expect(health.memory.totalMb).toBeGreaterThan(0)
    expect(health.top.length).toBeGreaterThan(0)
    // A process is named by its command name, at most 32 characters: never its arguments.
    expect(health.top.every((item) => Array.from(item.name).length <= 32 && Number.isInteger(item.rssMb))).toBe(true)
  })

  test("upgrade moves the guest to the laptop's release and restarts its server", async () => {
    await setup()
    expect(await change((target) => runtime.guest.upgrade(target, { version: "2.4.2" }, context()))).toEqual({ opencode: "2.4.2" })
    expect(readFileSync(onDisk("/.opencode-version"), "utf8").trim()).toBe("2.4.2")
  })

  test("scrub refuses a base with model credentials or a session, and otherwise removes what must not reach an image", async () => {
    await setup()
    mkdirSync(onDisk("/home/boxd/.local/share/opencode"), { recursive: true })
    writeFileSync(onDisk("/home/boxd/.local/share/opencode/auth.json"), "{}")
    expect(await change((target) => runtime.guest.scrub(target, context()))).toEqual({ removed: [], refused: "has-credential" })
    rmSync(onDisk("/home/boxd/.local/share/opencode/auth.json"))
    guestServer.sessions.set("ses_used", { id: "ses_used", busy: false, directory: "", messages: [], inbox: [], updated: 1 })
    expect(await change((target) => runtime.guest.scrub(target, context()))).toEqual({ removed: [], refused: "has-session" })
    guestServer.sessions.clear()
    mkdirSync(onDisk("/etc/profile.d"), { recursive: true })
    writeFileSync(onDisk("/etc/profile.d/boxd-env.sh"), "export KEY=x")
    // The boxd CLI's own file in ~/.boxd is not the helper's, and a scrub must never remove it.
    mkdirSync(onDisk("/home/boxd/.boxd"), { recursive: true })
    writeFileSync(onDisk("/home/boxd/.boxd/password"), "cli")
    const scrubbed = await change((target) => runtime.guest.scrub(target, context()))
    expect(scrubbed.removed).toEqual(expect.arrayContaining(["/etc/profile.d/boxd-env.sh", "/home/boxd/.boxd-plugin/password", "/home/boxd/work"]))
    expect(scrubbed.removed).not.toContain("/home/boxd/.boxd/password")
    expect(existsSync(onDisk(GUEST_HELPER_PATH))).toBe(true)
    expect(existsSync(onDisk("/home/boxd/.boxd-plugin/password"))).toBe(false)
    expect(existsSync(onDisk("/home/boxd/.boxd/password"))).toBe(true)
  })
})
