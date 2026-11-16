// Package C2's runs against the real runtime (the runner, the CLI port, the guest port and the real guest helper) on
// the fake boxd CLI and the fake guest server, with the real ledger in a temp root (design §7.1): submit's modes,
// harvest (F1, the last good export, partial, git), drop's guard against the guest and the gone rule, acting by id,
// sleep, exec's own pool and quoting, read's read rule, the list forms, the selectors, package E's actions, Stop, and
// the spawn budget rows of §4.4.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BoxdError, boxdError } from "../../src/errors.js"
import { createRuntime, type PluginRuntime } from "../../src/exec/runtime.js"
import { sessionRuns } from "../../src/fleet/sessions.js"
import { quote } from "../../src/fleet/exec.js"
import { rootOf } from "../../src/fleet/submit.js"
import { ledgerPort } from "../../src/ledger/index.js"
import { Ledger } from "../../src/ledger/store.js"
import type { WorkRecord } from "../../src/ledger/types.js"
import { parseOptions } from "../../src/options.js"
import { CAPS, type ChangeTarget, type ImportV0Port, type LedgerPort, type MachineId, type OpContext, type WorkEvent, type WorkSnapshot } from "../../src/ports.js"
import type { CostPort, FleetActions, FleetServices, Selectors } from "../../src/services.js"
import type { CallContext } from "../../src/tools.js"
import { startFakeGuest, type FakeGuest } from "../host/fake-guest.js"
import type { FakeMachine } from "../host/fake-cli.js"
import { startSpawnCounter, type CountingFake } from "../host/spawn-counter.js"
import { budgetProblems, SPAWN_BUDGETS, type BudgetRow } from "../support/spawn-count.js"
import { removeRoot, tempRoot } from "../support/ledger-fakes.js"

const VERSION = "2.2.6"
let guest: FakeGuest
let counter: CountingFake
let runtime: PluginRuntime
let root: string
let project: string
let ledger: LedgerPort
let services: FleetServices
let runs: ReturnType<typeof sessionRuns>["runs"]
let selectors: Selectors
let actions: FleetActions
let problems: Map<string, string>
let budget: { calls: number; refuse: boolean }
let adopted: string[]
let snapshot: WorkSnapshot[]
/** The host's sessions: id → parent. */
let hostSessions: Map<string, string | undefined>

beforeAll(() => {
  guest = startFakeGuest({ version: VERSION })
})
afterAll(async () => {
  await guest.close()
})

beforeEach(async () => {
  guest.sessions.clear()
  guest.interrupts.length = 0
  guest.prompts.length = 0
  guest.switches.length = 0
  counter = await startSpawnCounter({ guestPort: guest.port, version: VERSION })
  runtime = createRuntime({ boxdBin: counter.boxdBin }, { opencodeBin: counter.opencodeBin })
  root = tempRoot("boxd-c2-")
  project = join(root, "project")
  mkdirSync(project)
  const complete = { state: "complete" as const, works: 0, blocked: [] }
  ledger = ledgerPort(new Ledger(join(root, "ledger")), { state: () => complete, run: async () => complete })
  problems = new Map()
  budget = { calls: 0, refuse: false }
  adopted = []
  snapshot = []
  hostSessions = new Map([["ses_coord", undefined]])
  const cost: CostPort = {
    block: async () => {
      throw new Error("not used")
    },
    cleanup: async () => [],
    automation: () => "on",
    budget: async () => undefined,
    assertBudget: async () => {
      budget.calls += 1
      if (budget.refuse) throw boxdError("BUDGET_REACHED", "Today's machine cost reached the budget.", { today: 10, daily: 5, currency: "EUR" })
    },
  }
  const importV0 = {
    state: () => complete,
    run: async () => complete,
    readPhase: async () => {
      throw new Error("not used")
    },
    adopt: async (target: ChangeTarget) => void adopted.push(target.name),
    dispose: async () => {},
  } satisfies ImportV0Port
  services = {
    options: parseOptions({}),
    hostVersion: VERSION,
    projectDirectory: project,
    ledgerRoot: join(root, "ledger"),
    boxdBin: counter.boxdBin,
    opencodeBin: counter.opencodeBin,
    clock: { now: () => new Date() },
    sessions: {
      get: (async (input: { sessionID: string }) => {
        if (!hostSessions.has(input.sessionID)) throw new Error("not found")
        const parentID = hostSessions.get(input.sessionID)
        return { id: input.sessionID, ...(parentID ? { parentID } : {}) }
      }) as never,
      synthetic: (async () => undefined) as never,
      context: (async () => []) as never,
    },
    report: (area, problem) => void (problem ? problems.set(area, problem) : problems.delete(area)),
    runner: runtime.runner,
    boxd: runtime.boxd,
    guest: runtime.guest,
    laptop: runtime.laptop,
    dispose: () => runtime.dispose(),
    ledger,
    importV0,
    watch: { subscribe: () => () => {}, snapshot: () => ({ asOf: new Date().toISOString(), works: snapshot }) },
    cost,
  }
  ;({ runs, selectors, actions } = sessionRuns(services))
})

afterEach(async () => {
  await runtime.dispose()
  await counter.dispose()
  removeRoot(root)
})

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────

let calls = 0
const call = (over: Partial<CallContext> = {}): CallContext => ({ sessionID: "ses_coord", agent: "build", messageID: "msg_test", id: `call_${++calls}`, signal: new AbortController().signal, via: "rpc", ...over })
const op = (callId = `seed_${++calls}`): OpContext => ({ call: { callId, source: "boxd_ensure" } })
const row = (callName: string, scenario: string): BudgetRow => SPAWN_BUDGETS.find((entry) => entry.call === callName && entry.scenario.startsWith(scenario))!
const guestDir = (workId: string) => `/home/boxd/work/${workId}`
const record = (workId: string) => ledger.get(workId, op())
const sid = (workId: string) => `ses_${workId.replace(/-/g, "_")}`

function change<T>(machine: FakeMachine, fn: (target: ChangeTarget) => Promise<T>): Promise<T> {
  const context = op()
  return runtime.runner.withMachineLock({ id: machine.id as MachineId }, context, async () => fn(await runtime.boxd.checkOwned(machine.region, machine.name as `oc-${string}`, machine.id as MachineId, context)))
}

/** The work's folder on the fake machine's disk, as a git repository with one commit. */
function treeOf(machine: FakeMachine, workId: string): string {
  return join(counter.fake.disk(machine), guestDir(workId))
}
const git = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args])

/** A work as `boxd_ensure` leaves it: the machine, the helper installed, a clean git tree, and an open record. */
async function openWork(workId: string, over: Partial<WorkRecord> = {}): Promise<FakeMachine> {
  const machine = counter.fake.machine({ name: `oc-${workId}`, region: "fra", labels: { owner: "opencode-boxd", role: "session", work: workId } })
  await change(machine, (target) => runtime.guest.setup(target, { directory: guestDir(workId), opencode: VERSION }, op()))
  const dir = treeOf(machine, workId)
  git(dir, "init", "--quiet")
  writeFileSync(join(dir, "README.md"), "# work\n")
  git(dir, "add", ".")
  git(dir, "commit", "--quiet", "-m", "init")
  const value: WorkRecord = {
    format: 1,
    workId,
    state: "open",
    region: "fra",
    machine: `oc-${workId}`,
    machineId: machine.id as MachineId,
    size: "2x8",
    image: { name: `oc-golden-${VERSION}-2x8`, opencode: VERSION },
    laptopDirectory: project,
    guestDirectory: guestDir(workId),
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    guestHelper: "v1",
    ...over,
  }
  await ledger.update([workId], async () => ({ write: [value], value: undefined }), op())
  counter.reset()
  return machine
}

/** A work with a session whose first run completed. */
async function ranWork(workId: string, over: Partial<WorkRecord> = {}): Promise<FakeMachine> {
  const machine = await openWork(workId, over)
  guest.next(sid(workId))
  expect(await runs.boxd_submit({ workId, text: "Start." }, call())).toMatchObject({ state: "admitted", delivery: "started" })
  guest.say(sid(workId), "Done.", Date.now())
  guest.complete(sid(workId))
  counter.reset()
  return machine
}

async function savedWork(workId: string): Promise<FakeMachine> {
  const machine = await ranWork(workId)
  expect(await runs.boxd_harvest({ workId }, call())).toMatchObject({ state: "saved" })
  counter.reset()
  return machine
}

/** Changes a machine behind the plugin's back, as boxd would, and lets the shared listing see it. */
async function setMachine(machine: FakeMachine, change: (item: FakeMachine) => void): Promise<void> {
  counter.fake.update((state) => change(state.machines.find((item) => item.id === machine.id)!))
  await runtime.boxd.list({ maxAgeMs: 0 }, op())
  counter.reset()
}
const machineState = (machine: FakeMachine) => counter.fake.read().machines.find((item) => item.id === machine.id)!
const errorOf = async (promise: Promise<unknown>): Promise<BoxdError> => {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(caught).toBeInstanceOf(BoxdError)
  return caught as BoxdError
}
const countOf = (id: string) => counter.count(id)
const noHelp = (counts: Record<string, number | undefined>) => Object.fromEntries(Object.entries(counts).filter(([verb]) => verb !== "help"))

// ── boxd_submit ───────────────────────────────────────────────────────────────────────────────────────────────────

describe("boxd_submit", () => {
  test("steer starts an idle session, reaches a busy one at its next step, queue waits for the run, and interrupt stops the run first", async () => {
    await openWork("modes")
    guest.next("ses_modes")
    expect(await runs.boxd_submit({ workId: "modes", text: "Start." }, call())).toMatchObject({ state: "admitted", sessionId: "ses_modes", delivery: "started", waitingBefore: 0 })
    // The fake session is now running: a steer waits in its inbox for the next step, a queue for the run's end.
    expect(await runs.boxd_submit({ workId: "modes", text: "Also check the tests." }, call())).toMatchObject({ delivery: "steer", waitingBefore: 0 })
    expect(await runs.boxd_submit({ workId: "modes", text: "Then write a summary.", mode: "queue" }, call())).toMatchObject({ delivery: "queue", waitingBefore: 1 })
    expect(guest.sessions.get("ses_modes")!.inbox.map((item) => item.delivery ?? "steer")).toEqual(["steer", "queue"])
    // A session blocked inside one long tool call: only interrupt reaches it now.
    const interrupted = await runs.boxd_submit({ workId: "modes", text: "Stop that and do this.", mode: "interrupt" }, call())
    expect(interrupted).toMatchObject({ state: "admitted", delivery: "started", interrupted: true })
    expect(guest.interrupts).toEqual(["ses_modes"])
    const stored = (await record("modes"))!
    expect(stored.session?.rootId).toBe("ses_modes")
    expect(stored.lastSubmit?.delivery).toBe("interrupt")
  })

  test("a model switch on a running session is refused unless it interrupts", async () => {
    await ranWork("models")
    await runs.boxd_submit({ workId: "models", text: "Go on." }, call())
    const refused = await errorOf(runs.boxd_submit({ workId: "models", text: "Faster.", model: "anthropic/claude-haiku-4-5" }, call()))
    expect(refused.code).toBe("SESSION_BUSY")
    expect(await runs.boxd_submit({ workId: "models", text: "Faster.", model: "anthropic/claude-haiku-4-5", mode: "interrupt" }, call())).toMatchObject({ interrupted: true, model: "anthropic/claude-haiku-4-5" })
    expect(guest.switches.at(-1)).toMatchObject({ sessionID: sid("models") })
  })

  test("a running work costs one listing, the by-id get and one prompt exec (§4.4)", async () => {
    await ranWork("budget-submit")
    const context = call()
    await runs.boxd_submit({ workId: "budget-submit", text: "Next." }, context)
    expect(budgetProblems(row("boxd_submit", "a running work"), countOf(context.id))).toEqual([])
    expect(counter.untagged()).toEqual([])
  })

  test("files are copied up and moved into the tree; a file outside the project is refused before the guest is touched", async () => {
    const machine = await openWork("files")
    writeFileSync(join(project, "input.json"), '{"a":1}\n')
    guest.next("ses_files")
    const answer = await runs.boxd_submit({ workId: "files", text: "Read data/input.json.", files: [{ from: join(project, "input.json"), to: "data/input.json" }] }, call())
    expect(answer).toMatchObject({ state: "admitted", files: [{ path: "data/input.json", bytes: 8 }] })
    expect(readFileSync(join(treeOf(machine, "files"), "data", "input.json"), "utf8")).toBe('{"a":1}\n')
    expect((await record("files"))!.files?.in.map((file) => file.path)).toEqual(["data/input.json"])
    counter.reset()
    const refused = await errorOf(runs.boxd_submit({ workId: "files", text: "x", files: [{ from: "/etc/hostname", to: "h" }] }, call()))
    expect(refused).toMatchObject({ code: "PATH_REFUSED", details: { field: "files[0].from" } })
    expect(counter.spawns().filter((spawn) => spawn.verb !== "help")).toEqual([])
  })

  test("a hibernated machine is woken after the budget check; a reached refuse budget wakes nothing", async () => {
    const machine = await ranWork("sleepy")
    await setMachine(machine, (item) => void (item.status = "hibernated"))
    budget.refuse = true
    expect((await errorOf(runs.boxd_submit({ workId: "sleepy", text: "Wake up." }, call()))).code).toBe("BUDGET_REACHED")
    expect(machineState(machine).status).toBe("hibernated")
    budget.refuse = false
    expect(await runs.boxd_submit({ workId: "sleepy", text: "Wake up." }, call())).toMatchObject({ state: "admitted" })
    expect(machineState(machine).status).toBe("running")
    expect(budget.calls).toBe(2)
    expect(counter.fake.calls().some((line: string) => line.startsWith(`machine wake ${machine.id}`))).toBe(true)
  })

  test("a running machine is never budget-checked", async () => {
    await ranWork("awake")
    budget.refuse = true
    expect(await runs.boxd_submit({ workId: "awake", text: "Go." }, call())).toMatchObject({ state: "admitted" })
    expect(budget.calls).toBe(0)
  })

  test("notices go to the root of the calling session on the model path; a script keeps the earlier one unless it names one", async () => {
    await openWork("notify")
    hostSessions.set("ses_sub", "ses_coord")
    guest.next("ses_notify")
    await runs.boxd_submit({ workId: "notify", text: "Go." }, call({ sessionID: "ses_sub", via: "model" }))
    expect((await record("notify"))!.session?.notify).toBe("ses_coord")
    await runs.boxd_submit({ workId: "notify", text: "More." }, call({ sessionID: "ses_script", via: "rpc" }))
    expect((await record("notify"))!.session?.notify).toBe("ses_coord")
    hostSessions.set("ses_other", undefined)
    await runs.boxd_submit({ workId: "notify", text: "More.", notify: "ses_other" }, call())
    expect((await record("notify"))!.session?.notify).toBe("ses_other")
    await runs.boxd_submit({ workId: "notify", text: "More.", notify: false }, call())
    expect((await record("notify"))!.session?.notify).toBeUndefined()
    // A session the host cannot read keeps the subscription, and status says why.
    await runs.boxd_submit({ workId: "notify", text: "More.", notify: "ses_missing" }, call())
    expect((await record("notify"))!.session?.notify).toBeUndefined()
    expect(problems.get("notices")).toContain("ses_missing")
    expect(await rootOf(services, "ses_sub")).toBe("ses_coord")
  })

  test("an unknown work is NOT_OURS and spawns nothing; a bad field is NAME_INVALID", async () => {
    expect((await errorOf(runs.boxd_submit({ workId: "nobody", text: "x" }, call()))).code).toBe("NOT_OURS")
    expect((await errorOf(runs.boxd_submit({ workId: "nobody", text: "" }, call()))).details.field).toBe("text")
    expect((await errorOf(runs.boxd_submit({ workId: "nobody", text: "x", mode: "later" }, call()))).details.field).toBe("mode")
    expect(counter.spawns()).toEqual([])
  })

  test("a v0 guest is taken over once, by its first change", async () => {
    await openWork("old", { guestHelper: "v0" })
    guest.next("ses_old")
    await runs.boxd_submit({ workId: "old", text: "Go." }, call())
    expect(adopted).toEqual(["oc-old"])
    expect((await record("old"))!.guestHelper).toBe("v1")
  })
})

// ── boxd_harvest ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("boxd_harvest", () => {
  test("stores the verified export, replaces the laptop's copy on every harvest (F1), and records saved", async () => {
    await ranWork("f1")
    const first = await runs.boxd_harvest({ workId: "f1" }, call())
    expect(first).toMatchObject({ state: "saved", outcome: "completed", sessions: [{ id: "ses_f1" }], git: { known: true, dirty: false } })
    const laptop = () => counter.fake.read().laptopSessions?.ses_f1
    const before = laptop()!.messages
    const stored = (await record("f1"))!
    expect(ledger.saved(stored)).toBe("fresh")
    expect(stored.saved?.sessions).toEqual([expect.objectContaining({ id: "ses_f1", messages: before })])
    // A second run, then a second harvest: the laptop's copy changes (a plain import would keep the first).
    await runs.boxd_submit({ workId: "f1", text: "And more." }, call())
    guest.say("ses_f1", "More done.", Date.now())
    guest.complete("ses_f1")
    await runs.boxd_harvest({ workId: "f1" }, call())
    expect(laptop()!.messages).toBeGreaterThan(before)
    const exported = JSON.parse(readFileSync(join(ledger.workFolder("f1"), "exports", "ses_f1.json"), "utf8")) as { messages: unknown[] }
    expect(exported.messages.length).toBe(laptop()!.messages)
  })

  test("a running session is refused unless partial, and a partial copy leaves the work not saved", async () => {
    await ranWork("busy")
    await runs.boxd_submit({ workId: "busy", text: "Long task." }, call())
    expect((await errorOf(runs.boxd_harvest({ workId: "busy" }, call()))).code).toBe("SESSION_BUSY")
    const partial = await runs.boxd_harvest({ workId: "busy", partial: true }, call())
    expect(partial).toMatchObject({ state: "partial" })
    expect((partial as { next: string }).next).toContain("partial copy")
    expect(ledger.saved((await record("busy"))!)).toBe("stale")
  })

  test("a copy cut off half-way leaves the stored export byte for byte, no temp file, and saved as it was", async () => {
    await savedWork("cut")
    const file = join(ledger.workFolder("cut"), "exports", "ses_cut.json")
    const good = readFileSync(file)
    const saved = (await record("cut"))!.saved
    await runs.boxd_submit({ workId: "cut", text: "More." }, call())
    guest.say("ses_cut", "More done.", Date.now())
    guest.complete("ses_cut")
    counter.fake.update((state) => void (state.cutCopies = [true]))
    expect((await errorOf(runs.boxd_harvest({ workId: "cut" }, call()))).code).toBe("EXPORT_INVALID")
    expect(readFileSync(file).equals(good)).toBe(true)
    expect(readdirSync(join(ledger.workFolder("cut"), "exports")).filter((name) => name.endsWith(".tmp"))).toEqual([])
    expect((await record("cut"))!.saved).toEqual(saved!)
  })

  test("stores tracked changes as a patch and untracked files as files, and drop then accepts the tree", async () => {
    const machine = await ranWork("dirty")
    const tree = treeOf(machine, "dirty")
    writeFileSync(join(tree, "README.md"), "# work\nchanged\n")
    mkdirSync(join(tree, "notes"))
    writeFileSync(join(tree, "notes", "todo.txt"), "one\n")
    const answer = await runs.boxd_harvest({ workId: "dirty", files: ["notes/todo.txt"], to: join(project, "out") }, call())
    expect(answer).toMatchObject({ state: "saved", git: { dirty: true, patchStored: true, untracked: 1 }, files: [{ path: "notes/todo.txt", bytes: 4 }] })
    expect(readFileSync(join(ledger.workFolder("dirty"), "patch.diff"), "utf8")).toContain("+changed")
    expect(readFileSync(join(ledger.workFolder("dirty"), "untracked", "notes", "todo.txt"), "utf8")).toBe("one\n")
    expect(readFileSync(join(project, "out", "notes", "todo.txt"), "utf8")).toBe("one\n")
    expect(await runs.boxd_drop({ workId: "dirty" }, call())).toMatchObject({ state: "dropped" })
  })

  test("a file edited on the laptop since the last harvest is kept (FILE_CONFLICT), and the transcript is still saved", async () => {
    const machine = await ranWork("conflict")
    writeFileSync(join(treeOf(machine, "conflict"), "SUMMARY.md"), "v1\n")
    git(treeOf(machine, "conflict"), "add", ".")
    git(treeOf(machine, "conflict"), "commit", "--quiet", "-m", "summary")
    await runs.boxd_harvest({ workId: "conflict", files: ["SUMMARY.md"] }, call())
    writeFileSync(join(project, "SUMMARY.md"), "my local edit\n")
    writeFileSync(join(treeOf(machine, "conflict"), "SUMMARY.md"), "v2\n")
    const refused = await errorOf(runs.boxd_harvest({ workId: "conflict", files: ["SUMMARY.md"] }, call()))
    expect(refused.code).toBe("FILE_CONFLICT")
    expect(refused.message).toContain("transcript and git state were saved")
    expect(readFileSync(join(project, "SUMMARY.md"), "utf8")).toBe("my local edit\n")
    expect(readdirSync(project).filter((name) => name.endsWith(".tmp"))).toEqual([])
    expect(ledger.saved((await record("conflict"))!)).toBe("fresh")
  })

  test("a guest on another OpenCode release is refused before a transcript moves", async () => {
    await ranWork("version")
    guest.setVersion("2.2.5")
    try {
      expect((await errorOf(runs.boxd_harvest({ workId: "version" }, call()))).code).toBe("GUEST_VERSION")
      expect(counter.fake.read().laptopSessions?.ses_version).toBeUndefined()
    } finally {
      guest.setVersion(VERSION)
    }
  })

  test("spawns: a partial harvest fits its §4.4 row; the idle check adds one listing and one phase read", async () => {
    const machine = await ranWork("budget-harvest")
    writeFileSync(join(treeOf(machine, "budget-harvest"), "README.md"), "# changed\n")
    const partial = call()
    await runs.boxd_harvest({ workId: "budget-harvest", partial: true }, partial)
    expect(budgetProblems(row("boxd_harvest", "an idle work"), countOf(partial.id))).toEqual([])
    const full = call()
    await runs.boxd_harvest({ workId: "budget-harvest" }, full)
    // The listing is shared for 2 s, so the idle check's listing may be the one the partial call took.
    const { "machine list": lists = 0, ...rest } = noHelp(countOf(full.id))
    expect(lists).toBeLessThanOrEqual(1)
    expect(rest).toEqual({ "machine get": 1, "machine exec": 3, "machine cp": 2, "opencode session delete": 1, "opencode session import": 1 })
  })
})

// ── boxd_drop ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("boxd_drop", () => {
  test("a saved work with a clean tree is removed by id and closed, within its §4.4 row", async () => {
    const machine = await savedWork("clean")
    const context = call()
    expect(await runs.boxd_drop({ workId: "clean" }, context)).toEqual({ state: "dropped", workId: "clean", machine: "oc-clean" })
    expect(machineState(machine).status).toBe("destroyed")
    expect((await record("clean"))!).toMatchObject({ state: "closed", closed: { how: "dropped" } })
    expect(budgetProblems(row("boxd_drop", "a saved work"), countOf(context.id))).toEqual([])
    expect(counter.fake.calls().some((line: string) => line.startsWith(`machine remove ${machine.id} `))).toBe(true)
  })

  test("refuses a work that is not saved, and removes nothing", async () => {
    const machine = await ranWork("unsaved")
    expect((await errorOf(runs.boxd_drop({ workId: "unsaved" }, call()))).code).toBe("NOT_SAVED")
    expect(machineState(machine).status).toBe("running")
  })

  test("refuses when the guest's session moved on since the harvest, or has a new session; a new title alone does not refuse (M3, L-d)", async () => {
    const machine = await savedWork("moved")
    const session = guest.sessions.get("ses_moved")!
    session.messages.push({ type: "user", text: "A prompt from boxd connect." })
    expect((await errorOf(runs.boxd_drop({ workId: "moved" }, call()))).code).toBe("NOT_SAVED")
    session.messages.pop()
    guest.sessions.set("ses_moved_child", { id: "ses_moved_child", parentID: "ses_moved", busy: false, directory: guestDir("moved"), messages: [], inbox: [], updated: 1 })
    expect((await errorOf(runs.boxd_drop({ workId: "moved" }, call()))).message).toContain("ses_moved_child")
    guest.sessions.delete("ses_moved_child")
    session.updated = Date.now() + 60_000
    expect(machineState(machine).status).toBe("running")
    expect(await runs.boxd_drop({ workId: "moved" }, call())).toMatchObject({ state: "dropped" })
  })

  test("refuses untracked, ignored and changed files the laptop does not hold", async () => {
    const machine = await savedWork("files-drop")
    const tree = treeOf(machine, "files-drop")
    writeFileSync(join(tree, "new.txt"), "fresh\n")
    expect(await errorOf(runs.boxd_drop({ workId: "files-drop" }, call()))).toMatchObject({ code: "UNTRACKED", details: { kind: "untracked", paths: ["new.txt"], count: 1 } })
    await runs.boxd_harvest({ workId: "files-drop" }, call())
    writeFileSync(join(tree, "new.txt"), "changed after the harvest\n")
    expect((await errorOf(runs.boxd_drop({ workId: "files-drop" }, call()))).code).toBe("UNTRACKED")
    await runs.boxd_harvest({ workId: "files-drop" }, call())
    writeFileSync(join(tree, "README.md"), "# edited after the harvest\n")
    expect((await errorOf(runs.boxd_drop({ workId: "files-drop" }, call()))).code).toBe("DIRTY")
    expect(machineState(machine).status).toBe("running")
  })

  test("acts by id: an oc-<id> that now has another id is NOT_OURS, and nothing is removed", async () => {
    const machine = await savedWork("repointed")
    await setMachine(machine, (item) => void (item.id = "vm_someone_else"))
    expect((await errorOf(runs.boxd_drop({ workId: "repointed" }, call()))).code).toBe("NOT_OURS")
    expect(counter.fake.read().machines.find((item) => item.id === "vm_someone_else")!.status).toBe("running")
    expect(counter.fake.calls().some((line: string) => line.startsWith("machine remove"))).toBe(false)
    expect((await record("repointed"))!.state).toBe("open")
  })

  test("a machine gone from every region closes the work, from a fresh listing and a get of the id in each region", async () => {
    const machine = await ranWork("gone")
    await setMachine(machine, (item) => void (item.status = "destroyed"))
    const context = call()
    const answer = await runs.boxd_drop({ workId: "gone" }, context)
    expect(answer).toMatchObject({ state: "closed", workId: "gone", lost: expect.stringContaining("never harvested") })
    expect((await record("gone"))!.closed?.how).toBe("gone")
    // The name in its region, then the fresh all-region listing, then the id in each region.
    expect(noHelp(countOf(context.id))).toEqual({ "machine get": 3, "machine list": 1 })
    expect(counter.fake.calls().filter((line: string) => line.startsWith(`machine get ${machine.id}`)).map((line: string) => line.split("--region ")[1]?.split(" ")[0]).sort()).toEqual(["fra", "nyc"])
  })

  test("never reads an error as gone: a failed listing keeps the work open", async () => {
    const machine = await ranWork("flaky")
    await setMachine(machine, (item) => void (item.status = "destroyed"))
    counter.fake.fault("machine list", { stderr: "error: service unavailable" })
    expect((await errorOf(runs.boxd_drop({ workId: "flaky" }, call()))).code).toBe("BOXD_FAILED")
    expect((await record("flaky"))!.state).toBe("open")
  })

  test("a machine found under another name, or in another region, is NOT_OURS and keeps the work open", async () => {
    const renamed = await ranWork("renamed")
    await setMachine(renamed, (item) => void (item.name = "oc-by-hand"))
    expect(await errorOf(runs.boxd_drop({ workId: "renamed" }, call()))).toMatchObject({ code: "NOT_OURS", message: expect.stringContaining("oc-by-hand") })
    const moved = await ranWork("moved-region")
    await setMachine(moved, (item) => void (item.region = "nyc"))
    expect(await errorOf(runs.boxd_drop({ workId: "moved-region" }, call()))).toMatchObject({ code: "NOT_OURS", message: expect.stringContaining("nyc") })
    expect((await record("renamed"))!.state).toBe("open")
    expect((await record("moved-region"))!.state).toBe("open")
  })

  test("a work with no recorded id closes as gone only with confirmGone", async () => {
    await openWork("no-id", { machineId: null })
    counter.fake.update((state) => void state.machines.forEach((item) => item.name === "oc-no-id" && (item.status = "destroyed")))
    expect((await errorOf(runs.boxd_drop({ workId: "no-id" }, call()))).message).toContain("confirmGone")
    expect(await runs.boxd_drop({ workId: "no-id", confirmGone: true }, call())).toMatchObject({ state: "closed" })
  })
})

// ── boxd_sleep ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("boxd_sleep", () => {
  test("hibernates by id within its §4.4 row, and warns when the last prompt is not saved", async () => {
    const machine = await ranWork("nap")
    const context = call()
    expect(await runs.boxd_sleep({ workId: "nap" }, context)).toMatchObject({ state: "asleep", warning: "UNHARVESTED_SLEEP" })
    expect(machineState(machine).status).toBe("hibernated")
    expect(budgetProblems(row("boxd_sleep", "one running work"), countOf(context.id))).toEqual([])
    const stored = (await record("nap"))!
    expect(stored.slept?.by).toBe("boxd_sleep")
    expect(stored.warnings?.map((warning) => warning.code)).toEqual(["UNHARVESTED_SLEEP"])
    // An already hibernated machine still answers asleep.
    expect(await runs.boxd_sleep({ workId: "nap" }, call())).toMatchObject({ state: "asleep" })
  })

  test("a saved work sleeps with no warning; a re-pointed name is NOT_OURS", async () => {
    const machine = await savedWork("rest")
    expect(await runs.boxd_sleep({ workId: "rest" }, call())).not.toHaveProperty("warning")
    await setMachine(machine, (item) => void (item.id = "vm_other"))
    expect((await errorOf(runs.boxd_sleep({ workId: "rest" }, call()))).code).toBe("NOT_OURS")
  })
})

// ── boxd_exec ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("boxd_exec", () => {
  test("each argument arrives exactly as given", async () => {
    await openWork("quoting")
    const answer = await runs.boxd_exec({ workId: "quoting", command: ["printf", "%s|", "a b", "f;rm", "it's", "$HOME", "`x`"] }, call())
    expect(answer).toMatchObject({ state: "ran", exitCode: 0, stdout: "a b|f;rm|it's|$HOME|`x`|", truncated: false })
    expect(quote("it's")).toBe(`'it'\\''s'`)
  })

  test("keeps stdout and stderr apart, keeps their tails, and redacts token shapes", async () => {
    await openWork("streams")
    const answer = (await runs.boxd_exec({ workId: "streams", command: ["sh", "-c", "echo out; echo ghp_abcdefghijklmnop123456 >&2; exit 3"] }, call())) as { exitCode: number; stdout: string; stderr: string }
    expect(answer).toMatchObject({ exitCode: 3, stdout: "out\n" })
    expect(answer.stderr).toContain("[redacted]")
    expect(answer.stderr).not.toContain("ghp_abcdefghijklmnop123456")
  })

  test("refuses a hibernated machine unless wake is true, and the wake is budget-checked", async () => {
    const machine = await openWork("asleep-exec")
    await setMachine(machine, (item) => void (item.status = "hibernated"))
    expect((await errorOf(runs.boxd_exec({ workId: "asleep-exec", command: ["true"] }, call()))).code).toBe("MACHINE_ASLEEP")
    expect(machineState(machine).status).toBe("hibernated")
    expect(counter.fake.read().wokenByExec ?? []).toEqual([])
    budget.refuse = true
    expect((await errorOf(runs.boxd_exec({ workId: "asleep-exec", command: ["true"], wake: true }, call()))).code).toBe("BUDGET_REACHED")
    expect(machineState(machine).status).toBe("hibernated")
    budget.refuse = false
    expect(await runs.boxd_exec({ workId: "asleep-exec", command: ["true"], wake: true }, call())).toMatchObject({ state: "ran", exitCode: 0 })
    expect(machineState(machine).status).toBe("running")
  })

  test("runs in its own pool (M4): four long commands do not delay the work's interrupt, and a fifth waits", async () => {
    await ranWork("pool")
    await runs.boxd_submit({ workId: "pool", text: "Block in a long tool call." }, call())
    const stop = new AbortController()
    const long = Array.from({ length: 5 }, () => runs.boxd_exec({ workId: "pool", command: ["sleep", "20"] }, call({ signal: stop.signal })).catch((error: unknown) => error))
    const until = async (check: () => boolean) => {
      for (let tries = 0; tries < 200 && !check(); tries++) await Bun.sleep(25)
      return check()
    }
    expect(await until(() => runtime.runner.health().pools.exec.running === CAPS.exec)).toBe(true)
    expect(await until(() => runtime.runner.health().pools.exec.queued === 1)).toBe(true)
    const started = Date.now()
    expect(await runs.boxd_submit({ workId: "pool", text: "Stop and do this.", mode: "interrupt" }, call())).toMatchObject({ interrupted: true })
    expect(Date.now() - started).toBeLessThan(5_000)
    // Stop ends every one of them: the four in flight and the one still queued.
    stop.abort()
    const answers = await Promise.all(long)
    expect(answers.every((answer) => answer instanceof BoxdError && answer.code === "CANCELLED")).toBe(true)
    expect(answers.filter((answer) => (answer as BoxdError).details.uncertain === true)).toHaveLength(CAPS.exec)
    expect(await until(() => runtime.runner.health().children.now === 0)).toBe(true)
  }, 30_000)
})

// ── boxd_read ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("boxd_read", () => {
  test("reads a file under the read rule: one listing and one exec, no copy, no ledger write, redacted", async () => {
    const machine = await openWork("reader")
    writeFileSync(join(treeOf(machine, "reader"), "notes.md"), "line one\ntoken ghp_abcdefghijklmnop123456\n")
    const file = join(ledger.workFolder("reader"), "work.json")
    const before = readFileSync(file)
    const context = call()
    const answer = await runs.boxd_read({ workId: "reader", path: "notes.md" }, context)
    expect(answer).toMatchObject({ state: "read", workId: "reader", path: "notes.md", truncated: false })
    expect((answer as { text: string }).text).toBe("line one\ntoken [redacted]\n")
    expect(noHelp(countOf(context.id))).toEqual({ "machine list": 1, "machine exec": 1 })
    expect(readFileSync(file).equals(before)).toBe(true)
  })

  test("never wakes a hibernated machine, and refuses a path that leaves the tree", async () => {
    const machine = await openWork("dark")
    await setMachine(machine, (item) => void (item.status = "hibernated"))
    const context = call()
    expect((await errorOf(runs.boxd_read({ workId: "dark", log: "server" }, context))).code).toBe("MACHINE_ASLEEP")
    // At most the listing: no exec, so nothing could wake it.
    expect(Object.keys(noHelp(countOf(context.id))).filter((verb) => verb !== "machine list")).toEqual([])
    expect(counter.fake.read().wokenByExec ?? []).toEqual([])
    expect((await errorOf(runs.boxd_read({ workId: "dark", path: "../../etc/passwd" }, call()))).details.field).toBe("path")
    expect((await errorOf(runs.boxd_read({ workId: "dark" }, call()))).code).toBe("NAME_INVALID")
  })

  test("a v0 guest has no read action, and nothing is uploaded to it", async () => {
    await openWork("legacy", { guestHelper: "v0" })
    expect((await errorOf(runs.boxd_read({ workId: "legacy", log: "server" }, call()))).code).toBe("GUEST_FAILED")
    expect(counter.spawns()).toEqual([])
  })
})

// ── List forms, Stop, selectors and package E's actions ───────────────────────────────────────────────────────────

describe("list forms", () => {
  test("results keep input order, each with its own answer, and a bad item refuses the call before anything runs", async () => {
    await ranWork("one")
    await ranWork("two")
    const answer = (await runs.boxd_sleep({ works: ["two", "ghost", { workId: "one" }] }, call())) as unknown as { results: Array<{ workId: string; state: string }> }
    expect(answer).toMatchObject({ state: "partial", counts: { asleep: 2, refused: 1 } })
    expect(answer.results.map((item) => [item.workId, item.state])).toEqual([
      ["two", "asleep"],
      ["ghost", "refused"],
      ["one", "asleep"],
    ])
    counter.reset()
    expect((await errorOf(runs.boxd_submit({ works: [{ workId: "one", text: "ok" }, { workId: "two", text: "" }] }, call()))).details.field).toBe("works[1].text")
    expect(counter.spawns()).toEqual([])
  })

  test("a stopped call: items in flight answer cancelled and uncertain, the rest cancelled and not started", async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `w${index}`)
    for (const id of ids) await ranWork(id)
    counter.fake.update((state) => void (state.latencyMs = [400, 400]))
    const stop = new AbortController()
    const pending = runs.boxd_sleep({ works: ids }, call({ signal: stop.signal }))
    await Bun.sleep(200)
    stop.abort()
    const answer = (await pending) as unknown as { state: string; results: Array<{ state: string; started?: boolean; uncertain?: boolean }> }
    expect(answer.state).toBe("cancelled")
    expect(answer.results.every((item) => item.state === "cancelled")).toBe(true)
    expect(answer.results.filter((item) => item.started === false)).toHaveLength(ids.length - 8)
    expect(answer.results.filter((item) => item.uncertain === true)).toHaveLength(8)
  }, 30_000)
})

describe("selectors and dryRun (§C.4)", () => {
  test("each select matches its row of the table, dryRun changes nothing, and a select acts on exactly the matched ids", async () => {
    await savedWork("done-saved")
    await ranWork("done-unsaved")
    await openWork("fresh-ready")
    const asleep = await ranWork("asleep-unsaved")
    await setMachine(asleep, (item) => void (item.status = "hibernated"))
    const busy = await ranWork("running")
    await runs.boxd_submit({ workId: "running", text: "Busy." }, call())
    // The watcher's last look: it saw the finished works go idle, and the busy one busy.
    const seen = (workId: string, phase: WorkSnapshot["phase"], machineId: string): WorkSnapshot => ({ workId, region: "fra", machineId: machineId as MachineId, size: "2x8", phase, outcome: "completed", saved: "stale" })
    snapshot = [seen("running", "busy", busy.id), seen("done-unsaved", "idle", "vm_x"), seen("asleep-unsaved", "idle", asleep.id)]

    expect(await selectors.boxd_sleep("idle", call())).toEqual(["done-saved", "done-unsaved", "fresh-ready"])
    expect(await selectors.boxd_sleep("finished", call())).toEqual(["done-saved", "done-unsaved"])
    expect(await selectors.boxd_harvest("unsaved-finished", call())).toEqual(["asleep-unsaved", "done-unsaved"])
    expect(await selectors.boxd_drop("saved-finished", call())).toEqual(["done-saved"])

    counter.reset()
    const dry = await runs.boxd_drop({ select: "saved-finished", dryRun: true }, call({ matched: ["done-saved"] }))
    expect(dry).toMatchObject({ state: "done", dryRun: true, select: "saved-finished", results: [{ state: "matched", workId: "done-saved", saved: "fresh", outcome: "completed", phase: "idle" }] })
    expect(counter.spawns().filter((spawn) => spawn.verb !== "help" && spawn.verb !== "machine list")).toEqual([])

    const slept = await runs.boxd_sleep({ select: "finished" }, call({ matched: ["done-unsaved"] }))
    expect(slept).toMatchObject({ state: "done", select: "finished", results: [{ state: "asleep", workId: "done-unsaved" }] })
    expect((await record("done-saved"))!.slept).toBeUndefined()
  })

  test("package E's actions run the same code: automation's sleep is recorded as automation, and drop keeps its guard", async () => {
    const auto = await ranWork("auto")
    await savedWork("auto-saved")
    snapshot = [{ workId: "auto", region: "fra", machineId: auto.id as MachineId, size: "2x8", phase: "idle", outcome: "completed", saved: "stale" }]
    const context = { by: "automation" as const, call: { callId: "automation_1", source: "automation" as const } }
    expect(await actions.match("boxd_sleep", "finished", context)).toEqual(["auto", "auto-saved"])
    expect(await actions.sleep(["auto"], context)).toMatchObject({ state: "done", results: [{ state: "asleep", warning: "UNHARVESTED_SLEEP" }] })
    expect((await record("auto"))!.slept?.by).toBe("automation")
    const cleanup = { by: "cleanup-command" as const, call: { callId: "cleanup_1", source: "cleanup-command" as const } }
    expect(await actions.drop(["auto", "auto-saved"], cleanup)).toMatchObject({ state: "partial", results: [{ state: "refused", error: "NOT_SAVED" }, { state: "dropped" }] })
    expect(await actions.harvest(["auto"], context)).toMatchObject({ state: "done", results: [{ state: "saved" }] })
  })
})

describe("events", () => {
  test("a change tool records the phase changes it causes", async () => {
    await ranWork("evented")
    await runs.boxd_sleep({ workId: "evented" }, call())
    const page = await ledger.eventsSince(0, op())
    const mine: Array<Pick<WorkEvent, "workId" | "to" | "asleepBy">> = page.events.filter((event) => event.workId === "evented").map(({ workId, to, asleepBy }) => ({ workId, to, ...(asleepBy ? { asleepBy } : {}) }))
    expect(mine).toEqual([
      { workId: "evented", to: "busy" },
      { workId: "evented", to: "asleep", asleepBy: "boxd_sleep" },
    ])
    expect(existsSync(join(ledger.workFolder("evented"), "work.json"))).toBe(true)
  })
})
