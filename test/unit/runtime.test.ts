// The runtime's dispose (design §9.1, "Disposal"): the plugin calls it last on disposal or reload, bounded at 5 s. A
// running boxd_exec-length command dies with its CLI, queued children and lock waiters answer CANCELLED, no machine
// lock survives, nothing new starts, and it resolves well within the bound.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BoxdError } from "../../src/errors.js"
import { createProvider, type PluginProvider } from "../../src/provider/index.js"
import { CAPS, TIMEOUTS, type MachineId, type OpContext } from "../../src/ports.js"
import { DISPOSE_BOUND_MS } from "../../src/services.js"
import { startFakeCli, type FakeCli } from "../host/fake-cli.js"
import { running } from "../support/processes.js"

let fake: FakeCli
let runtime: PluginProvider
const context = (callId: string): OpContext => ({ call: { callId, source: "boxd_exec" }, pool: "exec" })
const outcome = (promise: Promise<unknown>) => promise.then(() => "ran", (error: unknown) => (error instanceof BoxdError ? error.code : String(error)))
/** This process's own long command: another copy of the suite running at once has its own, so the counts never mix. */
const LONG = `sleep 597.${process.pid}`
/** The running copies, a zombie not yet reaped counting as gone (test/support/processes.ts). */
const sleeping = () =>
  Bun.spawnSync(["pgrep", "-f", `^${LONG.replace(".", "\\.")}$`])
    .stdout.toString()
    .split("\n")
    .filter((line) => line.trim() !== "" && running(Number(line)))
    .join("\n")
const count = () => sleeping().split("\n").filter(Boolean).length

beforeEach(() => {
  fake = startFakeCli()
  runtime = createProvider({ boxdBin: fake.bin, opencodeBin: fake.opencodeBin })
})
afterEach(async () => {
  await runtime.dispose()
  fake.dispose()
})

describe("dispose", () => {
  test("kills a running boxd_exec, cancels the queue and the lock waiters, leaves no lock, and resolves within the bound", async () => {
    const machine = fake.machine({ name: "oc-a", region: "fra" })
    const id = machine.id as MachineId
    await runtime.boxd.assertLaptopCli(context("warm"))
    // Four boxd_execs (the exec pool, no machine lock), and a change that holds oc-a's lock while it runs one more.
    const long = Array.from({ length: CAPS.exec }, async (_, index) => {
      const target = (await runtime.boxd.checkOwned("fra", "oc-a", id, context(`long_${index}`))).target
      return outcome(runtime.boxd.exec(target, LONG, { timeoutSeconds: 600, json: false }, context(`long_${index}`)))
    })
    const holder = outcome(
      runtime.runner.withMachineLock({ id }, context("holder"), async () => {
        const target = (await runtime.boxd.checkOwned("fra", "oc-a", id, context("holder"))).target
        return runtime.boxd.exec(target, LONG, { timeoutSeconds: 600, json: false }, { ...context("holder"), pool: "foreground" })
      }),
    )
    const waiter = outcome(runtime.runner.withMachineLock({ id }, context("waiter"), async () => "ran"))
    const queued = outcome(runtime.boxd.exec({ region: "fra", name: "oc-a", listing: { takenAt: Date.now() + 60_000, fresh: true, machines: [] }, machineId: null }, "true", { timeoutSeconds: 5, json: false }, context("queued")))
    // Every long command runs before the dispose: wait for the event, not for a count of ticks.
    while (count() < CAPS.exec + 1) await Bun.sleep(25)
    expect(count()).toBe(CAPS.exec + 1)
    expect(runtime.runner.lockedMachines()).toBeGreaterThan(0)

    const started = Date.now()
    await runtime.dispose()
    expect(Date.now() - started).toBeLessThan(DISPOSE_BOUND_MS)
    expect(await Promise.all(long)).toEqual(Array.from({ length: CAPS.exec }, () => "CANCELLED"))
    expect(await holder).toBe("CANCELLED")
    expect(await waiter).toBe("CANCELLED")
    expect(await queued).not.toBe("ran")
    expect(runtime.runner.health().children.now).toBe(0)
    expect(runtime.runner.lockedMachines()).toBe(0)
    // The children die with their CLI: SIGTERM, then SIGKILL after the grace, so a slow kill fails here too.
    const killedBy = Date.now() + TIMEOUTS.killGraceMs + 3_000
    while (sleeping() !== "" && Date.now() < killedBy) await Bun.sleep(25)
    expect(sleeping()).toBe("")
    // Nothing starts after a dispose.
    expect(await outcome(runtime.boxd.list({ maxAgeMs: 0 }, context("after")))).toBe("CANCELLED")
    expect(await outcome(runtime.runner.withMachineLock({ id }, context("after"), async () => "ran"))).toBe("CANCELLED")
  }, 120_000)

  test("a second dispose is harmless", async () => {
    await runtime.dispose()
    await runtime.dispose()
    expect(runtime.runner.health().children.now).toBe(0)
  })
})
