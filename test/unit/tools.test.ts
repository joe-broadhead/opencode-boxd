// The tool table is the plugin's contract (design §3.14): names, classes, `readOnly`, schemas and the permission each
// declares. The architecture test here is the one BUILD-LESSONS requires: every tool that changes, exports or destroys
// asserts inside its own execute, with every work id it names, and a read never asks.
import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { BoxdError, boxdError, CODES } from "../../src/errors.js"
import { notBuiltRun, type Run, type Selectors, type ToolRuns } from "../../src/services.js"
import { CHANGING_TOOLS, READ_TOOLS, TOOLS, ownedMethods, refusal, resourcesOf, runTool, selectionOf, toolSpec, toolTransform, type CallContext, type RegistryDeps, type ToolName, type ToolSpec } from "../../src/tools.js"
import { defaultRules } from "../../src/permissions.js"

/** Design §3.14, row for row: the tool, its readOnly, its class, and whether it asserts. */
const TABLE: ReadonlyArray<readonly [ToolName, boolean, ToolSpec["class"]]> = [
  ["status", true, "read"],
  ["job", true, "read"],
  ["read", true, "read"],
  ["ensure", false, "write"],
  ["submit", false, "write"],
  ["harvest", false, "export"],
  ["sleep", false, "write"],
  ["resume", false, "write"],
  ["reassign", false, "write"],
  ["golden", false, "write"],
  ["exec", false, "write"],
  ["drop", false, "destructive"],
]

/** Design §4.2: the tools that take `works: [...]`. */
const LIST_FORMS: readonly ToolName[] = ["ensure", "submit", "job", "harvest", "sleep", "resume", "drop"]

/** Every run is the scaffold's, and every selector matches `a` and `b`, unless a test swaps one in. */
function registry(runs: Partial<Record<keyof ToolRuns, Run<{ readonly state: string }>>> = {}): RegistryDeps {
  const all = Object.fromEntries(TOOLS.map((tool) => [tool.id, runs[tool.id] ?? notBuiltRun(tool.owner)])) as unknown as ToolRuns
  const both = async () => ["a", "b"] as const
  return { runs: all, selectors: { boxd_sleep: both, boxd_harvest: both, boxd_drop: both } as Selectors }
}
const deps = registry()
const call = { sessionID: "ses_test", agent: "build", messageID: "msg_test", id: "call_test" }
const context = (via: CallContext["via"] = "model"): CallContext => ({ ...call, signal: new AbortController().signal, via })

/** A permission check that records, and refuses nothing. */
function recorder() {
  const calls: Array<{ action: string; sessionID: string; agent: string; resources: readonly string[] }> = []
  const assert: Plugin.Context["permission"]["assert"] = (async (input: { action: string; sessionID: string; agent: string; resources: readonly string[] }) => {
    calls.push({ action: input.action, sessionID: input.sessionID, agent: input.agent, resources: input.resources })
  }) as Plugin.Context["permission"]["assert"]
  return { calls, assert }
}

describe("the tool table", () => {
  test("has the twelve tools of design §3.14, in order, each with its class and readOnly", () => {
    expect(TOOLS.map((tool) => [tool.name, tool.readOnly, tool.class])).toEqual(TABLE.map((row) => [...row]))
    for (const tool of TOOLS) {
      expect(tool.id).toBe(`boxd_${tool.name}`)
      expect(tool.readOnly).toBe(tool.class === "read")
      expect(tool.description.length).toBeGreaterThan(40)
      expect(tool.input).toMatchObject({ type: "object", additionalProperties: false })
    }
  })

  test("splits the reads from the changes exactly once each", () => {
    expect(READ_TOOLS).toEqual(["boxd_status", "boxd_job", "boxd_read"])
    expect(CHANGING_TOOLS).toEqual(["boxd_ensure", "boxd_submit", "boxd_harvest", "boxd_sleep", "boxd_resume", "boxd_reassign", "boxd_golden", "boxd_exec", "boxd_drop"])
    expect([...READ_TOOLS, ...CHANGING_TOOLS].sort()).toEqual(TOOLS.map((tool) => tool.id).sort())
  })

  test("the list forms take works: 1 to 300 items, beside the single form", () => {
    expect(TOOLS.filter((tool) => tool.list).map((tool) => tool.name).sort()).toEqual([...LIST_FORMS].sort())
    for (const tool of TOOLS) {
      const properties = tool.input.properties as Record<string, Record<string, unknown>>
      if (!tool.list) {
        expect({ tool: tool.name, works: "works" in properties }).toEqual({ tool: tool.name, works: false })
        continue
      }
      expect(properties.works).toMatchObject({ type: "array", minItems: 1, maxItems: 300 })
      expect(tool.input.required).toEqual([])
      const raw = properties.works!.items as Record<string, unknown>
      // A list item is the single form: a work id string for job; an object with the same fields otherwise, which
      // sleep, resume, harvest and drop also take as a bare work id (design review LOW-5).
      if (tool.name === "job") {
        expect(raw).toMatchObject({ type: "string" })
        continue
      }
      const shorthand = ["sleep", "resume", "harvest", "drop"].includes(tool.name)
      expect({ tool: tool.name, shorthand: "anyOf" in raw }).toEqual({ tool: tool.name, shorthand })
      const items = shorthand ? (raw.anyOf as Array<Record<string, unknown>>)[1]! : raw
      if (shorthand) expect((raw.anyOf as unknown[])[0]).toMatchObject({ type: "string" })
      expect(Object.keys(items.properties as object).sort()).toEqual(Object.keys(properties).filter((key) => !["works", "select", "dryRun"].includes(key)).sort())
    }
  })

  test("each input names the design's fields and requires what the single form needs", () => {
    const fields = (name: ToolName) => Object.keys(toolSpec(name).input.properties as object).sort()
    expect(fields("status")).toEqual(["include", "limit", "region", "since", "view", "workIds"])
    expect(fields("job")).toEqual(["cost", "tail", "workId", "works"])
    expect(fields("read")).toEqual(["log", "maxBytes", "path", "tail", "workId"])
    expect(fields("ensure")).toEqual(["adopt", "directory", "git", "model", "ref", "region", "repair", "repo", "size", "title", "wait", "workId", "works"])
    expect(fields("submit")).toEqual(["files", "mode", "model", "notify", "text", "title", "workId", "works"])
    expect(fields("harvest")).toEqual(["dryRun", "files", "localDirectory", "partial", "select", "to", "workId", "works"])
    expect(fields("sleep")).toEqual(["dryRun", "select", "workId", "works"])
    expect(fields("resume")).toEqual(["workId", "works"])
    expect(fields("drop")).toEqual(["confirmGone", "dryRun", "select", "workId", "works"])
    expect(fields("reassign")).toEqual(["directory", "from", "git", "model", "ref", "repo", "title", "to"])
    expect(fields("golden")).toEqual(["from", "prune", "rebuild", "region", "size"])
    expect(fields("exec")).toEqual(["command", "timeout", "wake", "workId"])
    expect(toolSpec("read").input.required).toEqual(["workId"])
    expect(toolSpec("reassign").input.required).toEqual(["from", "to"])
    expect(toolSpec("exec").input.required).toEqual(["workId", "command"])
    const submitItem = (toolSpec("submit").input.properties as Record<string, { items: { required: string[] } }>).works!.items
    expect(submitItem.required).toEqual(["workId", "text"])
  })

  test("the selectors are exactly design §C.4's table, on sleep, harvest and drop only", () => {
    const selectors = TOOLS.flatMap((tool) => {
      const select = (tool.input.properties as Record<string, { enum?: string[] }>).select
      return select ? [[tool.name, select.enum]] : []
    })
    expect(selectors).toEqual([
      ["harvest", ["unsaved-finished"]],
      ["sleep", ["idle", "finished"]],
      ["drop", ["saved-finished"]],
    ])
  })

  test("every tool is allowed at all; ask-changes allows only the read-only tools; read-only denies the changes (OD-29)", () => {
    expect(defaultRules()[0]).toEqual({ action: "boxd_*", resource: "*", effect: "allow" })
    for (const tool of TOOLS) {
      expect(defaultRules("all")).toContainEqual({ action: tool.id, resource: "*", effect: "allow" })
      expect(defaultRules("ask-changes")).toContainEqual({ action: tool.id, resource: "*", effect: tool.readOnly ? "allow" : "ask" })
      expect(defaultRules("read-only")).toContainEqual({ action: tool.id, resource: "*", effect: tool.readOnly ? "allow" : "deny" })
    }
  })
})

describe("the registry runs a tool", () => {
  test("every tool answers the scaffold's typed NOT_IMPLEMENTED until its package fills it", async () => {
    for (const tool of TOOLS) {
      const answer = await runTool(tool, deps, recorder().assert, inputFor(tool.name), context())
      expect(answer.output).toEqual({ state: "failed", error: "NOT_IMPLEMENTED", message: `This tool is not built yet on this branch (package ${tool.owner}).`, next: "Use a released version of the plugin." })
      expect(JSON.parse(answer.text)).toEqual(answer.output)
    }
  })

  test("a coded error becomes a result in the shape of any answer: the work, its state, the code, the sentence, the next step and its facts", async () => {
    {
      const failing = registry({
        boxd_drop: async () => {
          throw boxdError("UNTRACKED", "Two untracked paths were not harvested.", { paths: ["a.txt", "b.txt"], count: 2, kind: "untracked" })
        },
      })
      const answer = await runTool(toolSpec("drop"), failing, recorder().assert, { workId: "review-api" }, context())
      expect(answer.output).toEqual({
        workId: "review-api",
        machine: "oc-review-api",
        state: "refused",
        error: "UNTRACKED",
        message: "Two untracked paths were not harvested.",
        next: CODES.UNTRACKED.next,
        paths: ["a.txt", "b.txt"],
        count: 2,
        kind: "untracked",
      })
      expect(answer.text).toBe(`UNTRACKED: Two untracked paths were not harvested. Next step: ${CODES.UNTRACKED.next}`)
    }
  })

  test("a refusal's state is the code's own, and an invalid work id is not echoed as a work", () => {
    expect(refusal(new BoxdError("SESSION_BUSY"), { workId: "review-api" }).state).toBe("busy")
    expect(refusal(new BoxdError("MACHINE_ASLEEP"), {}).state).toBe("asleep")
    expect(refusal(new BoxdError("CANCELLED"), {}).state).toBe("cancelled")
    expect(refusal(new BoxdError("NAME_INVALID"), { workId: "Not An Id" })).not.toHaveProperty("workId")
  })

  test("a change names every work it touches, once each, in input order", () => {
    expect(resourcesOf({ workId: "a" })).toEqual(["a"])
    expect(resourcesOf({ works: [{ workId: "b" }, { workId: "a" }, { workId: "b" }] })).toEqual(["b", "a"])
    expect(resourcesOf({ works: ["c", "d"] })).toEqual(["c", "d"])
    expect(resourcesOf({ from: "a", to: "b" })).toEqual(["a", "b"])
    expect(resourcesOf({ region: "fra" })).toEqual(["*"])
  })

  test("the model path passes the call's signal and says it came by the model; the RPC says rpc (F2, §3.5)", async () => {
    const seen: CallContext[] = []
    const deps = registry({
      boxd_submit: async (_input, received) => {
        seen.push(received)
        return { state: "admitted" }
      },
    })
    {
      const added: Array<{ name: string; execute: (input: unknown, context: unknown) => Promise<unknown> }> = []
      toolTransform(deps, recorder().assert)({ namespace: () => {}, add: (spec: (typeof added)[number]) => added.push(spec) } as never)
      const stop = new AbortController()
      await added.find((spec) => spec.name === "submit")!.execute({ workId: "a", text: "go" }, { ...call, signal: stop.signal })
      const method = ownedMethods(deps, recorder().assert).find((entry) => entry.name === "boxd_submit")!
      const rpcStop = new AbortController()
      await method.run({ workId: "a", text: "go" }, { ...call, signal: rpcStop.signal, progress: async () => {} })
      expect(seen.map((entry) => entry.via)).toEqual(["model", "rpc"])
      expect(seen[0]!.signal).toBe(stop.signal)
      expect(seen[1]!.signal).toBe(rpcStop.signal)
    }
  })
})

describe("every change asserts inside its own execute", () => {
  test("the model path asks for every change, with its work ids, and never for a read", async () => {
    const { calls, assert } = recorder()
    const added: Array<{ name: string; execute: (input: unknown, context: unknown) => Promise<unknown> }> = []
    toolTransform(deps, assert)({ namespace: () => {}, add: (spec: (typeof added)[number]) => added.push(spec) } as never)
    // Inside the `boxd` namespace the host prefixes the tool's id, so the model path adds the short name.
    expect(added.map((spec) => spec.name)).toEqual(TOOLS.map((tool) => tool.name))
    for (const spec of added) {
      const tool = toolSpec(spec.name as ToolName)
      calls.length = 0
      await spec.execute(inputFor(tool.name), { ...call, signal: new AbortController().signal })
      if (tool.readOnly) expect({ name: tool.name, asked: calls }).toEqual({ name: tool.name, asked: [] })
      else expect({ name: tool.name, asked: calls }).toEqual({ name: tool.name, asked: [{ action: tool.id, sessionID: "ses_test", agent: "build", resources: resourcesOf(inputFor(tool.name)) }] })
    }
  })

  test("a select call asserts the tool's action with exactly the ids its selector matched, and the run acts on those", async () => {
    const { calls, assert } = recorder()
    const given: CallContext[] = []
    const deps = registry({
      boxd_sleep: async (_input, received) => {
        given.push(received)
        return { state: "done" }
      },
    })
    const method = ownedMethods(deps, assert).find((entry) => entry.name === "boxd_sleep")!
    for (const input of [{ select: "finished" }, { select: "idle", dryRun: true }]) {
      await method.run(input, { ...call, signal: new AbortController().signal, progress: async () => {} })
    }
    // A dryRun is still asserted: an input key never skips the permission check.
    expect(calls).toEqual([
      { action: "boxd_sleep", sessionID: "ses_test", agent: "build", resources: ["a", "b"] },
      { action: "boxd_sleep", sessionID: "ses_test", agent: "build", resources: ["a", "b"] },
    ])
    expect(given.map((entry) => entry.matched)).toEqual([["a", "b"], ["a", "b"]])
  })

  test("a select that matches nothing still asserts, with resource *", async () => {
    const { calls, assert } = recorder()
    const deps = { ...registry(), selectors: { ...registry().selectors, boxd_drop: async () => [] } } as RegistryDeps
    await runTool(toolSpec("drop"), deps, assert, { select: "saved-finished" }, context())
    expect(calls.map((entry) => entry.resources)).toEqual([["*"]])
  })

  test("a declined or denied assert stops the call before its run", async () => {
    let ran = false
    const deps = registry({
      boxd_sleep: async () => {
        ran = true
        return { state: "done" }
      },
    })
    const refuse = (async () => {
      throw new Error("PermissionDeniedError")
    }) as unknown as Plugin.Context["permission"]["assert"]
    await expect(runTool(toolSpec("sleep"), deps, refuse, { select: "finished" }, context())).rejects.toThrow("PermissionDeniedError")
    expect(ran).toBe(false)
  })

  test("an ambiguous or wrong selection is refused before anything is asserted or run (NAME_INVALID, with its field)", async () => {
    const { calls, assert } = recorder()
    const cases: Array<[ToolName, Record<string, unknown>, string]> = [
      ["ensure", { workId: "a", select: "idle" }, "select"],
      ["exec", { workId: "a", command: ["true"], select: "idle" }, "select"],
      ["sleep", { workId: "a", select: "finished" }, "select"],
      ["sleep", { works: ["a"], select: "finished" }, "select"],
      ["sleep", { workId: "a", works: ["b"] }, "works"],
      ["sleep", { select: "saved-finished" }, "select"],
      ["drop", { workId: "a", dryRun: true }, "dryRun"],
      ["drop", { select: "saved-finished", dryRun: "yes" }, "dryRun"],
      ["harvest", {}, "workId"],
    ]
    for (const [name, input, field] of cases) {
      const answer = await runTool(toolSpec(name), deps, assert, input, context())
      expect({ name, input, output: answer.output }).toMatchObject({ name, input, output: { state: "refused", error: "NAME_INVALID", field } })
    }
    expect(calls).toEqual([])
    expect(selectionOf(toolSpec("sleep"), { select: "idle" })).toBe("idle")
    expect(selectionOf(toolSpec("status"), {})).toBeUndefined()
  })

  test("a list call asserts once, with every work id as a resource", async () => {
    const { calls, assert } = recorder()
    const method = ownedMethods(deps, assert).find((entry) => entry.name === "boxd_drop")!
    await method.run({ works: [{ workId: "a" }, { workId: "b" }] }, { ...call, signal: new AbortController().signal, progress: async () => {} })
    expect(calls).toEqual([{ action: "boxd_drop", sessionID: "ses_test", agent: "build", resources: ["a", "b"] }])
  })

  test("the tools RPC's methods assert the same way, so a script's ask is refused rather than left waiting", async () => {
    const { calls, assert } = recorder()
    for (const method of ownedMethods(deps, assert)) {
      const tool = toolSpec(method.name.replace("boxd_", "") as ToolName)
      expect({ name: method.name, class: method.class, action: method.action }).toEqual({ name: tool.id, class: tool.class, action: tool.id })
      calls.length = 0
      await method.run(inputFor(tool.name), { ...call, signal: new AbortController().signal, progress: async () => {} })
      expect({ name: tool.name, asked: calls.map((entry) => entry.action) }).toEqual({ name: tool.name, asked: tool.readOnly ? [] : [tool.id] })
    }
  })
})

/** A valid input for each tool. */
function inputFor(name: ToolName): Record<string, unknown> {
  switch (name) {
    case "status":
      return {}
    case "golden":
      return { region: "fra" }
    case "submit":
      return { workId: "review-api", text: "Add a health check." }
    case "reassign":
      return { from: "spare-1", to: "review-api" }
    case "exec":
      return { workId: "review-api", command: ["git", "status"] }
    default:
      return { workId: "review-api" }
  }
}
