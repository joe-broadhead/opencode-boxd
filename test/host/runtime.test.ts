// The runtime inside a stock host (design §7.2, F2): a tool that runs a long remote command through the runtime is
// stopped by the call's own signal, on the model path, on every tested host. The stop answers at once, the CLI and the
// command it started are killed, and nothing is left running. The boxd tools themselves come with their packages; this
// test registers a probe tool on the same runtime so the host's Stop is what ends it.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { BoxdError } from "../../src/errors.js"
import { createRuntime } from "../../src/exec/runtime.js"
import type { MachineId } from "../../src/ports.js"
import { cleanup, startHost, until } from "./harness.js"

setDefaultTimeout(120_000)
afterAll(cleanup)

describe("the runtime on a stock host", () => {
  test("Stop on the model path ends the tool call and kills the boxd child and the remote command it started", async () => {
    const host = await startHost()
    const runtime = createRuntime({ boxdBin: host.boxd.bin, opencodeBin: host.boxd.fake.opencodeBin })
    try {
      const machine = host.boxd.fake.machine({ name: "oc-stop", region: "fra" })
      // A command no other process on this machine runs, so every check below is about this test's own tree.
      const marker = `sleep 60.${String(process.pid).padStart(7, "0")}${Math.floor(Math.random() * 1e6)}`
      const ctx = host.probe()
      const registration = await ctx.tool.transform((editor) => {
        editor.add({
          name: "runtime_stop_probe",
          description: "Runs a long command on a machine through the plugin's runtime.",
          input: { type: "object" },
          output: { type: "object" },
          execute: async (_value, context) => {
            const op = { call: { callId: context.id, source: "boxd_exec" as const }, signal: context.signal, pool: "exec" as const }
            try {
              await runtime.runner.withMachineLock({ id: machine.id as MachineId }, op, async () => {
                const target = (await runtime.boxd.checkOwned("fra", "oc-stop", machine.id as MachineId, op)).target
                return runtime.boxd.exec(target, marker, { timeoutSeconds: 120, json: false }, op)
              })
              return { output: { state: "ran" }, content: "ran" }
            } catch (error) {
              if (error instanceof BoxdError) return { output: { state: error.state, error: error.code, uncertain: error.details.uncertain }, content: error.message }
              throw error
            }
          },
        })
      })
      const executor = await until("the probe tool is registered", async () => (await ctx.tool.list()).find((item) => item.id === "runtime_stop_probe"))
      const stop = new AbortController()
      const run = executor.execute({}, { sessionID: "ses_probe", agent: "build", messageID: "msg_probe", id: "call_probe", signal: stop.signal, progress: async () => {} } as never)
      await until("the remote command runs", async () => runtime.runner.health().pools.exec.running === 1 && host.boxd.fake.spawns().some((spawn) => spawn.argv.includes(marker)))
      const stoppedAt = Date.now()
      stop.abort()
      // The host may end the call itself on Stop (an interruption), or return what the tool answered.
      const result = await run.then(
        (value) => (value as { output: Record<string, unknown> }).output,
        (error: unknown) => (error instanceof Error && /interrupt/i.test(error.message) ? "interrupted by the host" : error),
      )
      expect(Date.now() - stoppedAt).toBeLessThan(5_000)
      expect([{ state: "cancelled", error: "CANCELLED", uncertain: true }, "interrupted by the host"]).toContainEqual(result as never)
      // Either way the tool saw the signal: the runner killed its child.
      await until("the runner has no child", async () => runtime.runner.health().children.now === 0, 5_000)
      // Nothing the call started is left: the runner killed the CLI's process group (its pid is the group's id), and
      // the remote command with it. Only this test's own processes are looked at.
      const groups = host.boxd.fake.spawns().filter((spawn) => spawn.argv.includes(marker)).map((spawn) => spawn.pid)
      expect(groups.length).toBeGreaterThan(0)
      const left = () => [...groups.map((group) => Bun.spawnSync(["pgrep", "-g", String(group)]).stdout.toString().trim()), Bun.spawnSync(["pgrep", "-fx", marker]).stdout.toString().trim()].join("")
      await until("the call's process tree is gone", async () => left() === "", 5_000)
      await registration.dispose()
    } finally {
      await runtime.dispose()
      await host.close()
    }
  })
})
