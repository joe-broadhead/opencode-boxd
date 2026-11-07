import { describe, expect, test } from "bun:test"
import { parseMachine } from "../../src/cli-boxd.js"

// Shapes copied from the real `boxd` 0.2.29 output. `machine new --json` is not a machine: it is boot, id, name,
// paused_automations, source and url, so the CLI wrapper must read the machine back before anything uses it.
const CREATED = { boot: "11ms", id: "58ef0fa8", name: "oc-demo", paused_automations: 0, source: "snapshot/golden", url: "oc-demo.boxd.sh" }

const RUNNING = {
  name: "oc-demo",
  id: "58ef0fa8",
  status: "running",
  size: "2 vCPU · 8 GiB",
  url: "oc-demo.hosts.example",
  source: "snapshot/golden:1",
  auto_suspend: "off",
  auto_hibernate: "14400s",
  idle_ignore_outbound: "off",
  sharing: "private",
  isolated: "no",
}

describe("parseMachine", () => {
  test("a create answer is not a machine: no status, sharing or isolation is claimed", () => {
    expect(parseMachine(CREATED, "oc-demo")).toEqual({ name: "oc-demo", status: "other", sharing: "unknown", isolated: false, source: "snapshot/golden" })
  })

  test("a private running machine reads as running, private and not isolated", () => {
    expect(parseMachine(RUNNING, "oc-demo")).toEqual({ name: "oc-demo", status: "running", sharing: "private", isolated: false, source: "snapshot/golden:1" })
  })

  test("a shared machine reads as shared, and an isolated one reads as isolated from the string yes", () => {
    expect(parseMachine({ ...RUNNING, sharing: "shared" }, "oc-demo").sharing).toBe("shared")
    expect(parseMachine({ ...RUNNING, isolated: "yes" }, "oc-demo").isolated).toBe(true)
    expect(parseMachine({ ...RUNNING, isolated: "true" }, "oc-demo").isolated).toBe(true)
    expect(parseMachine({ ...RUNNING, isolated: true }, "oc-demo").isolated).toBe(true)
    expect(parseMachine({ ...RUNNING, isolated: "no" }, "oc-demo").isolated).toBe(false)
  })

  test("the lifecycle vocabulary boxd prints maps to the plugin's machine states", () => {
    const read = (status: string) => parseMachine({ ...RUNNING, status }, "oc-demo").status
    expect(read("running")).toBe("running")
    expect(read("starting")).toBe("starting")
    expect(read("standby")).toBe("standby")
    expect(read("hibernated")).toBe("hibernated")
    expect(read("stopped")).toBe("stopped")
    expect(read("destroyed")).toBe("destroyed")
    expect(read("hibernating")).toBe("starting")
    expect(read("rebooting")).toBe("starting")
    expect(read("something-new")).toBe("other")
  })

  test("a machine with no sharing field is unknown, never private", () => {
    expect(parseMachine({ ...RUNNING, sharing: undefined }, "oc-demo").sharing).toBe("unknown")
  })
})
