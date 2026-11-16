// The runtime's dispose (design §9.1, "Disposal"): the plugin calls it last on disposal or reload, bounded at 5 s. A
// running boxd_exec-length command dies with its CLI, queued children and lock waiters answer CANCELLED, no machine
// lock survives, nothing new starts, and it resolves well within the bound.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BoxdError } from "../../src/errors.js"
import { createRuntime, type PluginRuntime } from "../../src/exec/runtime.js"
import { CAPS, type MachineId, type OpContext } from "../../src/ports.js"
import { DISPOSE_BOUND_MS } from "../../src/services.js"
import { startFakeCli, type FakeCli } from "../host/fake-cli.js"

let fake: FakeCli
let runtime: PluginRuntime
const context = (callId: string): OpContext => ({ call: { callId, source: "boxd_exec" }, pool: "exec" })
const outcome = (promise: Promise<unknown>) => promise.then(() => "ran", (error: unknown) => (error instanceof BoxdError ? error.code : String(error)))
const sleeping = () => Bun.spawnSync(["pgrep", "-f", "^sleep 597$"]).stdout.toString().trim()

beforeEach(() => {
  fake = startFakeCli()
  runtime = createRuntime({ boxdBin: fake.bin, opencodeBin: fake.opencodeBin })
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
      return outcome(runtime.boxd.exec(target, "sleep 597", { timeoutSeconds: 600, json: false }, context(`long_${index}`)))
    })
    const holder = outcome(
      runtime.runner.withMachineLock({ id }, context("holder"), async () => {
        const target = (await runtime.boxd.checkOwned("fra", "oc-a", id, context("holder"))).target
        return runtime.boxd.exec(target, "sleep 597", { timeoutSeconds: 600, json: false }, { ...context("holder"), pool: "foreground" })
      }),
    )
    const waiter = outcome(runtime.runner.withMachineLock({ id }, context("waiter"), async () => "ran"))
    const queued = outcome(runtime.boxd.exec({ region: "fra", name: "oc-a", listing: { takenAt: Date.now() + 60_000, fresh: true, machines: [] }, machineId: null }, "true", { timeoutSeconds: 5, json: false }, context("queued")))
    for (let tries = 0; tries < 200 && sleeping().split("\n").filter(Boolean).length < CAPS.exec + 1; tries++) await Bun.sleep(25)
    expect(sleeping().split("\n").filter(Boolean)).toHaveLength(CAPS.exec + 1)
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
    for (let tries = 0; tries < 40 && sleeping() !== ""; tries++) await Bun.sleep(25)
    expect(sleeping()).toBe("")
    // Nothing starts after a dispose.
    expect(await outcome(runtime.boxd.list({ maxAgeMs: 0 }, context("after")))).toBe("CANCELLED")
    expect(await outcome(runtime.runner.withMachineLock({ id }, context("after"), async () => "ran"))).toBe("CANCELLED")
  }, 30_000)

  test("a second dispose is harmless", async () => {
    await runtime.dispose()
    await runtime.dispose()
    expect(runtime.runner.health().children.now).toBe(0)
  })
})
