// The tool table is the plugin's contract (design §3.14): names, classes, `readOnly`, schemas and the permission each
// declares. The architecture test here is the one BUILD-LESSONS requires: every tool that changes, exports or destroys
// asserts inside its own execute, with every work id it names, and a read never asks.
import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { BoxdError, boxdError, CODES } from "../../src/errors.js"
import { DEFAULT_OPTIONS } from "../../src/options.js"
import { CHANGING_TOOLS, READ_TOOLS, TOOLS, ownedMethods, refusal, resourcesOf, runTool, toolSpec, toolTransform, type CallContext, type ToolDeps, type ToolName, type ToolSpec } from "../../src/tools.js"
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

const deps: ToolDeps = { options: DEFAULT_OPTIONS, hostVersion: "2.2.6", projectDirectory: "/work/example" }
const call = { sessionID: "ses_test", agent: "build", messageID: "msg_test", id: "call_test" }
const context = (via: CallContext["via"] = "model"): CallContext => ({ ...call, signal: new AbortController().signal, via, assert: async () => {} })

/** A permission check that records, and refuses nothing. */
function recorder() {
  const calls: Array<{ action: string; sessionID: string; agent: string; resources: readonly string[] }> = []
  const assert: Plugin.Context["permission"]["assert"] = (async (input: { action: string; sessionID: string; agent: string; resources: readonly string[] }) => {
    calls.push({ action: input.action, sessionID: input.sessionID, agent: input.agent, resources: input.resources })
  }) as Plugin.Context["permission"]["assert"]
  return { calls, assert }
}

/** Swaps one tool's run for the length of `body`, so a test can see what the registry passes it. */
async function withRun(name: ToolName, run: ToolSpec["run"], body: () => Promise<void>) {
  const spec = toolSpec(name) as { run: ToolSpec["run"] }
  const original = spec.run
  spec.run = run
  try {
    await body()
  } finally {
    spec.run = original
  }
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
      const items = properties.works!.items as Record<string, unknown>
      // A list item is the single form: a work id string for job, an object with the same fields otherwise.
      if (tool.name === "job") expect(items).toMatchObject({ type: "string" })
      else expect(Object.keys(items.properties as object).sort()).toEqual(Object.keys(properties).filter((key) => !["works", "select", "dryRun"].includes(key)).sort())
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
      const answer = await runTool(tool, deps, {}, context())
      expect(answer.output).toEqual({ state: "failed", error: "NOT_IMPLEMENTED", message: `This tool is not built yet on this branch (package ${tool.owner}).`, next: "Use a released version of the plugin." })
      expect(JSON.parse(answer.text)).toEqual(answer.output)
    }
  })

  test("a coded error becomes a result in the shape of any answer: the work, its state, the code, the sentence, the next step and its facts", async () => {
    await withRun("drop", async () => {
      throw boxdError("UNTRACKED", "Two untracked paths were not harvested.", { paths: ["a.txt", "b.txt"], count: 2, kind: "untracked" })
    }, async () => {
      const answer = await runTool(toolSpec("drop"), deps, { workId: "review-api" }, context())
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
    })
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
    await withRun("submit", async (_deps, _input, received) => {
      seen.push(received)
      return { state: "admitted" }
    }, async () => {
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
    })
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

  test("a select call is asserted by its run, once its match is known, with the tool's own action and the call's source", async () => {
    const { calls, assert } = recorder()
    let given: CallContext | undefined
    await withRun("sleep", async (_deps, _input, received) => {
      given = received
      await received.assert(["a", "b"])
      return { state: "done" }
    }, async () => {
      const method = ownedMethods(deps, assert).find((entry) => entry.name === "boxd_sleep")!
      await method.run({ select: "finished" }, { ...call, signal: new AbortController().signal, progress: async () => {} })
    })
    expect(given?.via).toBe("rpc")
    expect(calls).toEqual([{ action: "boxd_sleep", sessionID: "ses_test", agent: "build", resources: ["a", "b"] }])
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
