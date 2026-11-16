// The spawn-count harness (design §4.4, §7.1) and what the runtime costs. The harness counts each call's children by
// verb from the fake CLI's own log, finds a child that bypassed the runner, and measures how many were alive at once.
// The steady-state sequences below are the port calls each row of SPAWN_BUDGETS is built from: every one fits its row,
// and every tool's owner asserts its own row against its run.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { createRuntime, type PluginRuntime } from "../../src/exec/runtime.js"
import { CAPS, type ChangeTarget, type MachineId, type OpContext, type ReadTarget } from "../../src/ports.js"
import { startFakeGuest, type FakeGuest } from "../host/fake-guest.js"
import { startSpawnCounter, type CountingFake } from "../host/spawn-counter.js"
import { stillRunning } from "../support/processes.js"
import { budgetProblems, SPAWN_BUDGETS, type BudgetRow } from "../support/spawn-count.js"

let guestServer: FakeGuest
let counter: CountingFake
let runtime: PluginRuntime
const DIRECTORY = "/home/boxd/work/review-api"

beforeAll(() => {
  guestServer = startFakeGuest({ version: "2.2.6" })
})
afterAll(async () => {
  await runtime?.dispose()
  await counter?.dispose()
  await guestServer.close()
})
beforeEach(async () => {
  await runtime?.dispose()
  await counter?.dispose()
  counter = await startSpawnCounter({ guestPort: guestServer.port })
  runtime = createRuntime({ boxdBin: counter.boxdBin, opencodeBin: counter.opencodeBin })
})

const context = (callId: string, source: `boxd_${string}` = "boxd_submit"): OpContext => ({ call: { callId, source } })
const row = (call: string, scenario: string): BudgetRow => SPAWN_BUDGETS.find((entry) => entry.call === call && entry.scenario.startsWith(scenario))!

/** Puts a running work with the helper installed on the fake, as the steady state has it. */
async function work(name = "oc-review-api") {
  const machine = counter.fake.machine({ name, region: "fra", labels: { owner: "opencode-boxd", role: "session", work: name.slice(3) } })
  await change(machine.id, "setup", (target) => runtime.guest.setup(target, { directory: DIRECTORY, opencode: "2.2.6" }, context("setup")))
  guestServer.next(`ses_${name.slice(3).replace(/-/g, "_")}`)
  await change(machine.id, "setup", (target) => runtime.guest.prompt(target, { directory: DIRECTORY, sessionId: null, title: "t", text: "start", delivery: "steer" }, context("setup")))
  guestServer.complete(`ses_${name.slice(3).replace(/-/g, "_")}`)
  counter.reset()
  return machine
}

function change<T>(id: string, callId: string, fn: (target: ChangeTarget) => Promise<T>, name = "oc-review-api"): Promise<T> {
  return runtime.runner.withMachineLock({ id: id as MachineId }, context(callId), async () => fn((await runtime.boxd.checkOwned("fra", name as `oc-${string}`, id as MachineId, context(callId))).target))
}

async function readTarget(callId: string): Promise<ReadTarget> {
  return { region: "fra", name: "oc-review-api", listing: await runtime.boxd.list({ maxAgeMs: 2_000 }, context(callId)), machineId: null }
}

describe("the harness", () => {
  test("counts a call's children by verb, finds none untagged, and measures the peak", async () => {
    await runtime.boxd.list({ maxAgeMs: 0 }, context("call_a"))
    await runtime.boxd.machineLimit(context("call_a"))
    expect(counter.count("call_a")).toEqual({ help: 1, "machine list": 1, "manage machine-limit": 1 })
    expect(counter.untagged()).toEqual([])
    expect(counter.peak()).toBe(1)
    counter.reset()
    expect(counter.spawns()).toEqual([])
  })
})

describe("the steady-state sequences fit their rows", () => {
  test("boxd_submit on a running work: listing, by-id check, one prompt exec", async () => {
    const machine = await work()
    const call = "call_submit"
    await readTarget(call)
    await change(machine.id, call, (target) => runtime.guest.prompt(target, { directory: DIRECTORY, sessionId: "ses_review_api", title: "t", text: "next", delivery: "steer" }, context(call)))
    expect(budgetProblems(row("boxd_submit", "a running work"), counter.count(call))).toEqual([])
  })

  test("boxd_job on one running work: a listing and one read exec", async () => {
    await work()
    const call = "call_job"
    const target = await readTarget(call)
    await runtime.guest.phase(target, { sessionId: "ses_review_api" }, context(call, "boxd_job"))
    expect(budgetProblems(row("boxd_job", "one running work"), counter.count(call))).toEqual([])
  })

  test("boxd_sleep on one running work: the by-id check and one hibernate", async () => {
    const machine = await work()
    await change(machine.id, "call_sleep", (target) => runtime.boxd.hibernate(target, context("call_sleep", "boxd_sleep")))
    expect(budgetProblems(row("boxd_sleep", "one running work"), counter.count("call_sleep"))).toEqual([])
  })

  test("boxd_drop of a saved work: one git exec, the by-id check and one remove", async () => {
    const machine = await work()
    const call = "call_drop"
    await change(machine.id, call, async (target) => {
      await runtime.guest.git(target, { directory: DIRECTORY, rootId: "ses_review_api" }, context(call, "boxd_drop"))
      await runtime.boxd.remove(target, context(call, "boxd_drop"))
    })
    expect(budgetProblems(row("boxd_drop", "a saved work"), counter.count(call))).toEqual([])
  })

  test("boxd_drop of a gone machine: the by-id check's name get, one fresh listing, and a get of the id in each region", async () => {
    const call = "call_gone"
    await runtime.boxd.get("fra", "oc-gone", context(call, "boxd_drop")).catch(() => undefined)
    await runtime.boxd.list({ maxAgeMs: 0 }, context(call, "boxd_drop"))
    for (const region of ["fra", "nyc"] as const) await runtime.boxd.get(region, "vm_9999", context(call, "boxd_drop")).catch(() => undefined)
    expect(budgetProblems(row("boxd_drop", "a work whose machine is gone"), counter.count(call))).toEqual([])
  })

  test("boxd_harvest of one session: export, copy, git, patch copy, then delete and import on the laptop", async () => {
    const machine = await work()
    const call = "call_harvest"
    const exported = await change(machine.id, call, async (target) => {
      // The export checks the tree is idle itself, in the same exec: no phase read, no listing (a change, not a read).
      const answer = await runtime.guest.export(target, { rootId: "ses_review_api" }, context(call, "boxd_harvest"))
      if (answer.outcome !== "exported") throw new Error(answer.reason)
      await runtime.boxd.copyFrom(target, answer.sessions[0]!.file, `${counter.fake.dir}/export.json`, context(call, "boxd_harvest"))
      const git = await runtime.guest.git(target, { directory: DIRECTORY }, context(call, "boxd_harvest"))
      if (git.patch) await runtime.boxd.copyFrom(target, git.patch.file, `${counter.fake.dir}/patch.diff`, context(call, "boxd_harvest"))
      return answer
    })
    await runtime.laptop.deleteSession(exported.sessions[0]!.id, context(call, "boxd_harvest"))
    await runtime.laptop.importSession(`${counter.fake.dir}/export.json`, "/project", context(call, "boxd_harvest"))
    expect(budgetProblems(row("boxd_harvest", "an idle work"), counter.count(call))).toEqual([])
  })

  test("boxd_ensure of a new work from its image: one listing, the create, setup, and a fresh listing for one serve poll", async () => {
    counter.fake.snapshot({ region: "fra", name: "oc-golden-2.2.6-2x8" })
    // The image carries the helper, as a golden build installs it.
    const seed = counter.fake.machine({ name: "oc-seed", region: "fra" })
    await change(seed.id, "seed", (target) => runtime.guest.setup(target, { directory: "/home/boxd/work/seed", opencode: "2.2.6" }, context("seed")), "oc-seed")
    await change(seed.id, "seed", (target) => runtime.boxd.saveSnapshot(target, "oc-golden-2.2.6-2x8", context("seed")), "oc-seed")
    await runtime.boxd.snapshots(context("seed"))
    counter.reset()
    const call = "call_ensure"
    await runtime.boxd.list({ maxAgeMs: 0 }, context(call, "boxd_ensure"))
    const info = await runtime.runner.withMachineLock({ create: { region: "fra", name: "oc-fresh" } }, context(call), () =>
      runtime.boxd.create({ kind: "work", region: "fra", name: "oc-fresh", workId: "fresh", image: "oc-golden-2.2.6-2x8", autoSuspendSeconds: 0, autoHibernateSeconds: 7200 }, context(call, "boxd_ensure")),
    )
    // The create hands back its own target for the id boxd gave; the by-id check is not repeated in the same call.
    const target = info.owned.target
    const setup = await runtime.runner.withMachineLock({ id: info.id }, context(call), () => runtime.guest.setup(target, { directory: "/home/boxd/work/fresh", opencode: "2.2.6" }, context(call, "boxd_ensure")))
    expect(setup).toMatchObject({ server: "up", workspace: "ready", helperUploaded: false })
    // The wait's serve poll is a read: it needs a listing at most 2 s old that holds the new machine.
    const listing = await runtime.boxd.list({ maxAgeMs: 0 }, context(call, "boxd_ensure"))
    expect(await runtime.guest.serve({ region: "fra", name: "oc-fresh", listing, machineId: null }, { directory: "/home/boxd/work/fresh" }, context(call, "boxd_ensure"))).toMatchObject({ server: "up" })
    expect(budgetProblems(row("boxd_ensure", "a new work"), counter.count(call))).toEqual([])
    expect(counter.count(call)["machine cp"]).toBeUndefined()
  })
})

describe("under load", () => {
  test("120 changes on 40 machines at once, with 20 to 60 ms of CLI latency: never more than 12 boxd children, none untagged", async () => {
    counter.fake.update((state) => void (state.latencyMs = [20, 60]))
    const machines = Array.from({ length: 40 }, (_, index) => counter.fake.machine({ name: `oc-w${index}`, region: "fra" }))
    counter.reset()
    const stop = new AbortController()
    await Promise.all(
      Array.from({ length: 120 }, (_, index) => {
        const machine = machines[index % 40]!
        const call = `call_${index}`
        return runtime.runner.withMachineLock({ id: machine.id as MachineId }, { ...context(call), signal: stop.signal }, async () => {
          const target = (await runtime.boxd.checkOwned("fra", machine.name as `oc-${string}`, machine.id as MachineId, context(call))).target
          await runtime.boxd.hibernate(target, context(call))
          await runtime.boxd.wake(target, context(call))
        })
      }),
    )
    expect(counter.peak()).toBeLessThanOrEqual(CAPS.shared)
    expect(counter.peak()).toBeGreaterThan(1)
    expect(counter.untagged()).toEqual([])
    expect(counter.spawns().filter((spawn) => spawn.verb !== "help")).toHaveLength(360)
  }, 60_000)

  test("Stop mid-queue on real processes: the queued calls start no child, and no child outlives the call", async () => {
    await runtime.boxd.assertLaptopCli(context("warm"))
    // Long enough that no child finishes on its own, however slowly the machine starts processes.
    counter.fake.update((state) => void (state.latencyMs = [20_000, 20_000]))
    counter.reset()
    const stop = new AbortController()
    const calls = Array.from({ length: 40 }, (_, index) => runtime.boxd.list({ maxAgeMs: 0 }, { ...context(`call_stop_${index}`), signal: stop.signal }).then(() => "ran", (error: { code?: string }) => error.code))
    // Stop only once the runner holds its 12 shared slots and every one of those children is up (it logged its start).
    const deadline = Date.now() + 20_000
    while ((runtime.runner.health().pools.foreground.running < CAPS.shared || counter.spawns().length < CAPS.shared) && Date.now() < deadline) await Bun.sleep(20)
    expect(runtime.runner.health().pools.foreground).toMatchObject({ running: CAPS.shared, queued: 40 - CAPS.shared })
    stop.abort()
    const answers = await Promise.all(calls)
    expect(answers).toEqual(Array.from({ length: 40 }, () => "CANCELLED"))
    for (let tries = 0; tries < 250 && runtime.runner.health().children.now > 0; tries++) await Bun.sleep(20)
    expect(runtime.runner.health().children.now).toBe(0)
    await Bun.sleep(200)
    const spawns = counter.fake.spawns().filter((spawn) => spawn.call?.startsWith("call_stop_"))
    // No queued call started a child after the Stop, and every child that started is gone.
    expect(spawns).toHaveLength(CAPS.shared)
    expect(await stillRunning(spawns.map((spawn) => spawn.pid))).toEqual([])
  }, 60_000)
})
