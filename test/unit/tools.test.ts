// The tool table is the plugin's contract: names, classes, schemas and the permission each declares. The architecture
// test here is the one BUILD-LESSONS requires: every tool that changes, sends, exports or destroys asserts inside its
// own execute, and a read never asks.
import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { CHANGING_TOOLS, READ_TOOLS, TOOLS, ownedMethods, runTool, toolSpec, toolTransform, type ToolName } from "../../src/tools.js"
import { defaultRules } from "../../src/permissions.js"
import { world } from "./fake.js"

const CLASSES = { status: "read", job: "read", ensure: "write", submit: "write", harvest: "export", sleep: "write", resume: "write", image: "write", drop: "destructive" } as const

/** A permission check that records, and refuses nothing. */
function recorder() {
  const calls: Array<{ action: string; sessionID: string; agent: string; resources: readonly string[] }> = []
  const assert: Plugin.Context["permission"]["assert"] = (async (input: { action: string; sessionID: string; agent: string; resources: readonly string[] }) => {
    calls.push({ action: input.action, sessionID: input.sessionID, agent: input.agent, resources: input.resources })
  }) as Plugin.Context["permission"]["assert"]
  return { calls, assert }
}

const call = { sessionID: "ses_test", agent: "build", messageID: "msg_test", id: "call_test" }

describe("the tool table", () => {
  test("has the nine tools, in order, each named boxd_<name> and classed as the design says", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual(["status", "job", "ensure", "submit", "harvest", "sleep", "resume", "image", "drop"])
    for (const tool of TOOLS) {
      expect(tool.id).toBe(`boxd_${tool.name}`)
      expect(tool.class).toBe(CLASSES[tool.name])
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.input).toMatchObject({ type: "object", additionalProperties: false })
    }
  })

  test("splits the reads from the machine changes exactly once each", () => {
    expect(READ_TOOLS).toEqual(["boxd_status", "boxd_job"])
    expect(CHANGING_TOOLS).toEqual(["boxd_ensure", "boxd_submit", "boxd_harvest", "boxd_sleep", "boxd_resume", "boxd_image", "boxd_drop"])
    expect([...READ_TOOLS, ...CHANGING_TOOLS].sort()).toEqual(TOOLS.map((tool) => tool.id).sort())
  })

  test("every tool is allowed by default, and each access value narrows that", () => {
    const rules = defaultRules()
    expect(rules[0]).toEqual({ action: "boxd_*", resource: "*", effect: "allow" })
    for (const id of [...READ_TOOLS, ...CHANGING_TOOLS]) expect(rules).toContainEqual({ action: id, resource: "*", effect: "allow" })
    // The reads always run; the changes follow the option.
    for (const id of READ_TOOLS) expect(defaultRules("read-only")).toContainEqual({ action: id, resource: "*", effect: "allow" })
    for (const id of CHANGING_TOOLS) {
      expect(defaultRules("ask-changes")).toContainEqual({ action: id, resource: "*", effect: "ask" })
      expect(defaultRules("read-only")).toContainEqual({ action: id, resource: "*", effect: "deny" })
    }
  })

  test("a coded error's result keeps the code, what happened and the next step, so a program can read all three", async () => {
    const { fleet } = await world()
    const answer = await runTool("job", fleet, { workId: "never-opened" })
    expect(answer.output).toEqual({
      error: "NOT_OURS",
      message: 'No open work "never-opened".',
      next: "Call boxd_ensure for this work id, and act only on the machine the ledger records for it.",
    })
    expect(answer.text).toBe(`NOT_OURS: No open work "never-opened". Next step: Call boxd_ensure for this work id, and act only on the machine the ledger records for it.`)
  })

  test("input is checked by the tool, so a missing or empty string is a coded error, not a crash", async () => {
    const { fleet } = await world()
    for (const name of ["ensure", "job", "submit", "harvest", "sleep", "resume", "image", "drop"] as ToolName[]) {
      const answer = await runTool(name, fleet, {})
      expect(answer.text).toStartWith("NAME_INVALID: ")
      expect(answer.text).toContain(" Next step: ")
    }
  })
})

describe("every write tool asserts inside its own execute", () => {
  test("the model path asks for every change and never for a read", async () => {
    const { fleet } = await world()
    const { calls, assert } = recorder()
    const added: Array<{ name: string; execute: (input: unknown, context: unknown) => Promise<unknown> }> = []
    const editor = {
      namespace: () => {},
      add: (spec: { name: string; execute: (input: unknown, context: unknown) => Promise<unknown> }) => added.push(spec),
    }
    toolTransform(fleet, assert)(editor as never)
    // Inside the `boxd` namespace the host prefixes the tool's id, so the model path adds the short name.
    expect(added.map((spec) => spec.name)).toEqual(TOOLS.map((tool) => tool.name))
    for (const spec of added) {
      const tool = TOOLS.find((item) => item.name === spec.name)!
      calls.length = 0
      const input = inputFor(tool.name)
      await spec.execute(input, call).catch(() => undefined)
      if (tool.class === "read") {
        expect({ name: tool.name, asked: calls.length }).toEqual({ name: tool.name, asked: 0 })
      } else {
        expect({ name: tool.name, asked: calls.map((entry) => entry.action) }).toEqual({ name: tool.name, asked: [tool.id] })
        expect(calls[0]).toMatchObject({ sessionID: "ses_test", agent: "build" })
      }
    }
  })

  test("the tools RPC's methods assert the same way, so a script's ask is refused rather than left waiting", async () => {
    const { fleet } = await world()
    const { calls, assert } = recorder()
    for (const method of ownedMethods(fleet, assert)) {
      const tool = toolSpec(method.name.replace("boxd_", "") as ToolName)
      calls.length = 0
      await method.run(inputFor(tool.name), { ...call, signal: new AbortController().signal, progress: async () => {} }).catch(() => undefined)
      expect({ name: tool.name, asked: calls.map((entry) => entry.action) }).toEqual({ name: tool.name, asked: tool.class === "read" ? [] : [tool.id] })
    }
  })
})

/** A valid input for each tool, so a call reaches the work instead of failing its own validation. */
function inputFor(name: ToolName): Record<string, unknown> {
  switch (name) {
    case "status":
      return {}
    case "submit":
      return { workId: "review-api", text: "Add a health check." }
    case "harvest":
      return { workId: "review-api", localDirectory: "/work/example" }
    case "image":
      return { machine: "oc-review-api", name: "opencode-next" }
    default:
      return { workId: "review-api" }
  }
}
