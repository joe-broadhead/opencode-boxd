// The plugin on the public @opencode/sdk host, at the v0.1.0 registry skeleton: it loads, registers the twelve tools,
// inserts the default rules for each access value, asks for every change and never for a read, answers describe and
// the status RPC, and runs nothing when a prompt is declined or a rule denies. Each tool's own behaviour is its
// package's host suite (design §7.2); until a package fills a tool, the tool answers NOT_IMPLEMENTED and runs no CLI.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SUPPORTED_HOST } from "../../src/constants.js"
import { defaultRules, type Rule } from "../../src/permissions.js"
import { TOOLS, CHANGING_TOOLS, READ_TOOLS } from "../../src/tools.js"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { agentRules, attempt, cleanup, effect, HOST_VERSION, session, startHost, statusThroughRpc, until } from "./harness.js"

/** The released version, from package.json: status reports it. */
const PACKAGE_VERSION: string = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")).version

setDefaultTimeout(120_000)
afterAll(cleanup)

const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect })

const NOT_IMPLEMENTED = { state: "failed", error: "NOT_IMPLEMENTED" }

type Host = Awaited<ReturnType<typeof startHost>>

/** One tools RPC call, as a script makes it: the output, or the error the envelope carries. */
const rpcCall = (host: Host, method: string, input: unknown) => {
  const rpc = host.client.rpc as unknown as { call: (request: object) => Promise<Record<string, any>> }
  return rpc.call({ rpcID: TOOLS_RPC_ID, method, input, location: host.location })
}

const refusedCode = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: { data?: { code?: string } }) => error?.data?.code,
  )

/** The status text /boxd-status posts. */
async function statusText(host: Host, sessionID: string) {
  await host.client.sessions.command({ sessionID, name: "boxd-status", text: "" })
  return until("/boxd-status posts its text", async () => {
    const inbox = await host.client.session.inbox.list({ sessionID })
    const posted = inbox.findLast((item) => item.type === "synthetic")
    return posted?.type === "synthetic" ? posted.payload.text : undefined
  })
}

describe("the plugin on a stock host", () => {
  test("loads, registers the twelve tools, adds the default rules, and answers status", async () => {
    const host = await startHost()
    try {
      const tools = (await host.probe().tool.list()).map((tool) => tool.id).filter((id) => id.startsWith("boxd_"))
      expect(tools.sort()).toEqual(TOOLS.map((tool) => tool.id).sort())
      expect(tools).toHaveLength(12)

      const rules = (await agentRules(host)).get("build")!
      const block = defaultRules()
      expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "allow" })
      expect(rules.slice(1, 1 + block.length)).toEqual(block)
      expect(await effect(host, "build", "boxd_ensure")).toBe("allow")
      expect(await effect(host, "build", "boxd_read")).toBe("allow")

      // The ledger is package B's: until it lands, status says it cannot read one, and still reports the posture.
      const status = await statusThroughRpc(host)
      expect(status).toMatchObject({ version: PACKAGE_VERSION, state: "failed", access: "all", host: { version: HOST_VERSION, range: SUPPORTED_HOST, tested: true }, tools: 12, unknownCount: 0, unguardedAgents: [] })
      expect(String(status.error)).toContain("not built yet")

      const text = await statusText(host, await session(host))
      expect(text).toContain("- Connection: failed")
      expect(text.split("\n").filter((line) => line.startsWith("- Next step:"))).toHaveLength(1)
    } finally {
      await host.close()
    }
  })

  test("a read and a change run without asking by default; each answers NOT_IMPLEMENTED and runs no CLI", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      const before = host.boxd.calls().length
      for (const tool of TOOLS) {
        const input = tool.name === "reassign" ? { from: "spare-1", to: "review-api" } : tool.name === "exec" ? { workId: "review-api", command: ["true"] } : { workId: "review-api", text: "Add a health check." }
        const result = await attempt(host, build, "build", tool.id, "reject", input)
        expect({ tool: tool.id, asked: result.asked, output: result.output }).toMatchObject({ tool: tool.id, asked: undefined, output: NOT_IMPLEMENTED })
      }
      expect(host.boxd.calls().slice(before)).toEqual([])
    } finally {
      await host.close()
    }
  })

  test("an agent that asks gets the prompt for a change, and a decline runs nothing", async () => {
    const host = await startHost()
    try {
      const asking = await session(host, "build", [rule("boxd_drop", "ask")])
      const declined = await attempt(host, asking, "build", "boxd_drop", "reject", { works: [{ workId: "a" }, { workId: "b" }] })
      expect(declined.asked).toBe("boxd_drop")
      expect(declined.ok).toBe(false)
      const allowed = await attempt(host, asking, "build", "boxd_drop", "once", { workId: "a" })
      expect(allowed).toMatchObject({ asked: "boxd_drop", ok: true, output: NOT_IMPLEMENTED })
      expect(host.boxd.calls()).toEqual([])
    } finally {
      await host.close()
    }
  })

  test("describe lists every method with its class; a change runs by default over RPC and is refused under a deny", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      const listing = (await rpcCall(host, "describe", { sessionID: build })).output as { methods: Array<Record<string, any>>; unclassified: string[] }
      expect(listing.methods.map((method) => method.name)).toEqual(TOOLS.map((tool) => tool.id))
      expect(listing.unclassified ?? []).toEqual([])
      for (const method of listing.methods) {
        const spec = TOOLS.find((tool) => tool.id === method.name)!
        expect({ name: method.name, kind: method.kind, class: method.class, action: method.action }).toEqual({ name: method.name, kind: "plugin", class: spec.class, action: spec.id })
      }

      expect((await rpcCall(host, "boxd_ensure", { sessionID: build, input: { workId: "review-api" } })).output).toMatchObject(NOT_IMPLEMENTED)

      const denied = await session(host, "build", [rule("boxd_drop", "deny")])
      expect(await refusedCode(rpcCall(host, "boxd_drop", { sessionID: denied, input: { workId: "review-api" } }))).toBe("PERMISSION_DENIED")
      // An unknown name is not a method of this RPC.
      const unknown = await rpcCall(host, "boxd_no_such_tool", { sessionID: build, input: {} }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(unknown).toBeDefined()
      expect(host.boxd.calls()).toEqual([])
    } finally {
      await host.close()
    }
  })
})

describe("cost and cleanup's surfaces (design §C)", () => {
  test("the session hooks and the session-events subscription register on this host, and /boxd-cleanup changes nothing yet", async () => {
    const host = await startHost()
    try {
      // A hook the host refused would be a status problem.
      expect((await statusThroughRpc(host)).problems).toEqual([])
      const sessionID = await session(host)
      await host.client.sessions.command({ sessionID, name: "boxd-cleanup", text: "" })
      const text = await until("/boxd-cleanup posts its report", async () => {
        const inbox = await host.client.session.inbox.list({ sessionID })
        const posted = inbox.findLast((item) => item.type === "synthetic")
        return posted?.type === "synthetic" ? posted.payload.text : undefined
      })
      expect(text).toContain("Nothing was changed.")
      expect(host.boxd.calls()).toEqual([])
      // The command's own action asks at every access level, so each cleanup action is a person's prompt.
      expect(await effect(host, "build", "boxd_cleanup")).toBe("ask")
    } finally {
      await host.close()
    }
  })
})

describe("the access option (OD-29)", () => {
  test("ask-changes runs the read-only tools and refuses a change on the RPC path", async () => {
    const host = await startHost({ options: { access: "ask-changes" } })
    try {
      const build = await session(host)
      for (const id of READ_TOOLS) expect((await rpcCall(host, id, { sessionID: build, input: { workId: "review-api" } })).output).toMatchObject(NOT_IMPLEMENTED)
      for (const id of CHANGING_TOOLS) expect({ id, code: await refusedCode(rpcCall(host, id, { sessionID: build, input: { workId: "review-api" } })) }).toEqual({ id, code: "PERMISSION_DENIED" })
      expect(await effect(host, "build", "boxd_exec")).toBe("ask")
      expect(await effect(host, "build", "boxd_read")).toBe("allow")
      expect((await statusThroughRpc(host)).access).toBe("ask-changes")
    } finally {
      await host.close()
    }
  })

  test("a select on a change tool still asks at ask-changes, and a decline runs nothing", async () => {
    const host = await startHost({ options: { access: "ask-changes" } })
    try {
      const build = await session(host)
      const declined = await attempt(host, build, "build", "boxd_sleep", "reject", { select: "finished" })
      expect(declined).toMatchObject({ asked: "boxd_sleep", ok: false })
      const dry = await attempt(host, build, "build", "boxd_drop", "reject", { select: "saved-finished", dryRun: true })
      expect(dry).toMatchObject({ asked: "boxd_drop", ok: false })
      // A script cannot answer a prompt, so its select is refused.
      expect(await refusedCode(rpcCall(host, "boxd_harvest", { sessionID: build, input: { select: "unsaved-finished" } }))).toBe("PERMISSION_DENIED")
      expect(host.boxd.calls()).toEqual([])
    } finally {
      await host.close()
    }
  })

  test("read-only denies every change and allows the reads", async () => {
    const host = await startHost({ options: { access: "read-only" } })
    try {
      for (const id of CHANGING_TOOLS) expect({ id, effect: await effect(host, "build", id) }).toEqual({ id, effect: "deny" })
      for (const id of READ_TOOLS) expect({ id, effect: await effect(host, "build", id) }).toEqual({ id, effect: "allow" })
      const build = await session(host)
      expect(await refusedCode(rpcCall(host, "boxd_golden", { sessionID: build, input: {} }))).toBe("PERMISSION_DENIED")
      // A select is denied like any other change.
      for (const [method, select] of [["boxd_sleep", "idle"], ["boxd_harvest", "unsaved-finished"], ["boxd_drop", "saved-finished"]] as const) {
        expect({ method, code: await refusedCode(rpcCall(host, method, { sessionID: build, input: { select, dryRun: true } })) }).toEqual({ method, code: "PERMISSION_DENIED" })
      }
      expect(host.boxd.calls()).toEqual([])
    } finally {
      await host.close()
    }
  })

  test("a removed option stops the plugin with OPTIONS_INVALID", async () => {
    await expect(startHost({ options: { snapshot: "opencode-golden" } })).rejects.toThrow(/OPTIONS_INVALID/)
  })
})

describe("the status RPC", () => {
  test("names an agent that lacks the default rules", async () => {
    const host = await startHost({ config: { agents: { lonely: { description: "No rules of its own", mode: "subagent" } } } })
    try {
      expect((await statusThroughRpc(host)).unguardedAgents).toContain("lonely")
    } finally {
      await host.close()
    }
  })

  test("an agent whose own rules already stop boxd needs no fix", async () => {
    const host = await startHost({ config: { agents: { locked: { description: "Stops boxd", mode: "subagent", permissions: [rule("boxd_*", "deny")] } } } })
    try {
      expect((await statusThroughRpc(host)).unguardedAgents).toEqual([])
      expect(await effect(host, "locked", "boxd_drop")).toBe("deny")
    } finally {
      await host.close()
    }
  })
})
