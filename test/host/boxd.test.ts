// The plugin on the public @opencode/sdk host: it loads, registers the thirteen tools, inserts the default rules for each
// access value, asks for every change and never for a read, answers describe and the status RPC, and runs nothing when a
// prompt is declined or a rule denies. The machine tools (ensure, golden, reassign, resume) are in `machines.test.ts`.
// For a work the ledger does not hold, the session tools answer NOT_OURS and run no CLI; boxd_status answers the
// fleet, and boxd_job refuses the work.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { SUPPORTED_HOST } from "../../src/constants.js"
import { defaultRules, type Rule } from "../../src/permissions.js"
import { TOOLS, CHANGING_TOOLS, READ_TOOLS } from "../../src/tools.js"
import { TOOLS_RPC_ID } from "../../src/tools-rpc.js"
import { agentRules, attempt, cleanup, effect, HOST_VERSION, session, startHost, statusThroughRpc, until } from "./harness.js"

/** The released version, from package.json: status reports it. */
const PACKAGE_VERSION: string = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")).version

setDefaultTimeout(120_000)
afterAll(cleanup)

const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect })

/** The tools this file runs: every tool but the machine tools, which `machines.test.ts` covers. */
const MACHINE_TOOLS = new Set(["boxd_ensure", "boxd_golden", "boxd_reassign", "boxd_resume"])
const RUN_HERE = TOOLS.filter((tool) => !MACHINE_TOOLS.has(tool.id))
const NOT_OURS = { state: "refused", error: "NOT_OURS" }
/** What the reads that are not about one work answer: the fleet, and the local ledger's events. */
const FLEET_READS: Readonly<Record<string, object>> = {
  boxd_status: { state: "ok", counts: {}, attention: [] },
  boxd_job: { state: "refused", error: "NOT_OURS", workId: "review-api" },
  boxd_events_list: { state: "ok", source: "works", events: [] },
}
/** What a tool answers here for review-api, a work the ledger does not hold. */
const unknownWork = (id: string, input: Record<string, unknown>) => {
  if (FLEET_READS[id]) return FLEET_READS[id]
  // boxd_read checks its input first: it needs a path or the log.
  return id === "boxd_read" && input.path === undefined && input.log === undefined ? { state: "refused", error: "NAME_INVALID" } : NOT_OURS
}

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
  test("loads, registers the thirteen tools, adds the default rules, and answers status", async () => {
    const host = await startHost()
    try {
      const tools = (await host.probe().tool.list()).map((tool) => tool.id).filter((id) => id.startsWith("boxd_"))
      expect(tools.sort()).toEqual(TOOLS.map((tool) => tool.id).sort())
      expect(tools).toHaveLength(13)

      const rules = (await agentRules(host)).get("build")!
      const block = defaultRules()
      expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "allow" })
      expect(rules.slice(1, 1 + block.length)).toEqual(block)
      expect(await effect(host, "build", "boxd_ensure")).toBe("allow")
      expect(await effect(host, "build", "boxd_read")).toBe("allow")

      // An empty ledger and a signed-in CLI: connected, nothing open, and the posture.
      const status = await statusThroughRpc(host)
      expect(status).toMatchObject({ version: PACKAGE_VERSION, state: "connected", signedIn: true, openWorks: 0, access: "all", host: { version: HOST_VERSION, range: SUPPORTED_HOST, tested: true }, tools: 13, unknownCount: 0, unguardedAgents: [] })
      expect(status.regions).toEqual([
        { region: "fra", limit: 300, inUse: 0, free: 300 },
        { region: "nyc", limit: 300, inUse: 0, free: 300 },
      ])

      const text = await statusText(host, await session(host))
      expect(text).toContain("- Connection: connected (the ledger is readable; 0 open works)")
      expect(text).toContain("- Cost: ")
      expect(text.split("\n").filter((line) => line.startsWith("- Next step:"))).toHaveLength(1)
    } finally {
      await host.close()
    }
  })

  test("a read and a change run without asking by default; each answers NOT_OURS for an unknown work and runs no CLI", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      for (const tool of RUN_HERE) {
        const input =
          tool.name === "status"
            ? {}
            : tool.name === "events_list"
              ? { source: "works" }
              : tool.name === "job"
                ? { workId: "review-api" }
                : tool.name === "reassign"
                  ? { from: "spare-1", to: "review-api" }
                  : tool.name === "exec"
                    ? { workId: "review-api", command: ["true"] }
                    : { workId: "review-api", text: "Add a health check." }
        const before = host.boxd.calls().length
        const result = await attempt(host, build, "build", tool.id, "reject", input)
        expect({ tool: tool.id, asked: result.asked, output: result.output }).toMatchObject({ tool: tool.id, asked: undefined, output: unknownWork(tool.id, input) })
        if (!FLEET_READS[tool.id]) expect({ tool: tool.id, calls: host.boxd.calls().slice(before) }).toEqual({ tool: tool.id, calls: [] })
      }
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
      expect(allowed).toMatchObject({ asked: "boxd_drop", ok: true, output: NOT_OURS })
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
      // The thirteen tools, then the boxd.works source's two reads.
      expect(listing.methods.map((method) => method.name)).toEqual([...TOOLS.map((tool) => tool.id), "events_list", "probe"])
      expect(listing.unclassified ?? []).toEqual([])
      for (const method of listing.methods) {
        const spec = TOOLS.find((tool) => tool.id === method.name)
        const want = spec ? { class: spec.class, action: spec.id } : { class: "read", action: `boxd_${method.name}` }
        expect({ name: method.name, kind: method.kind, class: method.class, action: method.action }).toEqual({ name: method.name, kind: "plugin", ...want })
      }

      expect((await rpcCall(host, "boxd_submit", { sessionID: build, input: { workId: "review-api", text: "Add a health check." } })).output).toMatchObject(NOT_OURS)

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

describe("the boxd.works source on a stock host", () => {
  test("probe and events_list answer over the tools RPC from the local ledger, with no boxd call, at every access value", async () => {
    for (const access of ["all", "ask-changes", "read-only"] as const) {
      const host = await startHost({ options: { access } })
      try {
        const build = await session(host)
        const probed = (await rpcCall(host, "probe", { sessionID: build, input: { source: "works" } })).output as Record<string, any>
        expect(probed).toMatchObject({ source: "works", trust: "untrusted" })
        expect(probed.owner.id).toStartWith("os-user:")
        // The ledger is readable once the start's import check is done; until then the source answers UNAVAILABLE.
        const page = await until("events_list answers a page", async () => {
          const answer = await rpcCall(host, "events_list", { sessionID: build, input: { source: "works", since: "2026-01-01T00:00:00Z" } }).then(
            (result) => result.output as Record<string, any>,
            (error: { data?: { code?: string } }) => (error?.data?.code === "UNAVAILABLE" ? undefined : Promise.reject(error)),
          )
          return answer
        })
        expect(page).toMatchObject({ source: "works", account: probed.account, owner: probed.owner, events: [], more: false, trust: "untrusted", plugin: "@we-the-rebel-alliance/boxd-plugin" })
        expect(typeof page.cursor).toBe("string")
        // Once the ledger is published, the source's reads make no boxd call at all.
        const before = host.boxd.calls().length
        const again = (await rpcCall(host, "events_list", { sessionID: build, input: { cursor: page.cursor } })).output as Record<string, any>
        expect(again).toMatchObject({ events: [], cursor: page.cursor, more: false })
        await rpcCall(host, "probe", { sessionID: build, input: {} })
        expect(await refusedCode(rpcCall(host, "events_list", { sessionID: build, input: { account: "another-computer" } }))).toBe("ACCOUNT_MISMATCH")
        expect(host.boxd.calls().slice(before)).toEqual([])
      } finally {
        await host.close()
      }
    }
  })
})

describe("the boxd.works.list snapshot on a stock host", () => {
  // The host validates a tools-RPC method's answer against the method's declared output; `boxd_status` declares an
  // object, so a list answer is accepted, and this is the read that proves it on every tested release.
  test("a consumer reads the works list over the tools RPC, and the model's status keeps its own answer", async () => {
    const host = await startHost({ options: { access: "all" } })
    try {
      const build = await session(host)
      const probed = (await rpcCall(host, "probe", { sessionID: build, input: { source: "works" } })).output as Record<string, any>
      expect(probed.account).toBeString()
      // Two works through boxd_ensure, so the list validates real items on every host, newest first.
      for (const id of ["alpha", "zulu"]) {
        const ensured = (await rpcCall(host, "boxd_ensure", { sessionID: build, input: { workId: id, region: "fra", size: "1x4" } })).output as Record<string, any>
        expect(ensured).toBeDefined()
      }
      const listed = (await rpcCall(host, "boxd_status", { sessionID: build, input: { list: "works", account: probed.account } })).output as Record<string, any>
      expect(listed.account).toBe(probed.account)
      expect(listed.data.editable).toBe(false)
      expect(listed.trust).toBe("untrusted")
      // Seeded works are listed, not an empty answer.
      expect(Array.isArray(listed.data.items)).toBe(true)
      expect(listed.data.items.length).toBeGreaterThan(0)
      expect(Number.isNaN(Date.parse(String(listed.asOf)))).toBe(false)
      // Another computer's account is refused before anything is read.
      expect(await refusedCode(rpcCall(host, "boxd_status", { sessionID: build, input: { list: "works", account: "another-computer" } }))).toBe("ACCOUNT_MISMATCH")
      // The model's own status is unchanged: the status object, not a list.
      const status = (await rpcCall(host, "boxd_status", { sessionID: build, input: {} })).output as Record<string, any>
      expect(status).not.toHaveProperty("data")
      expect(status).toHaveProperty("counts")
      expect(status.state).toBe("ok")
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
      const before = host.boxd.calls().length
      const sessionID = await session(host)
      await host.client.sessions.command({ sessionID, name: "boxd-cleanup", text: "" })
      const text = await until("/boxd-cleanup posts its report", async () => {
        const inbox = await host.client.session.inbox.list({ sessionID })
        const posted = inbox.findLast((item) => item.type === "synthetic")
        return posted?.type === "synthetic" ? posted.payload.text : undefined
      })
      expect(text).toContain("Nothing was changed.")
      expect(host.boxd.calls().slice(before)).toEqual([])
      // The command's own action asks at every access level, so each cleanup action is a person's prompt.
      expect(await effect(host, "build", "boxd_cleanup")).toBe("ask")

      // The view the TUI renders for /boxd-cleanup answers over its own RPC (package E builds it, package D renders it).
      const { CleanupViewRpc } = await import("../../src/services.js")
      const rpc = host.client.rpc as unknown as (definition: object) => { view: (input: object, options: object) => Promise<Record<string, unknown>> }
      expect(await rpc(CleanupViewRpc).view({}, { location: host.location })).toMatchObject({ confirm: "cleanup-action", command: "/boxd-cleanup", works: [], actions: [] })
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
      for (const id of READ_TOOLS) {
        const input = id === "boxd_status" ? {} : id === "boxd_events_list" ? { source: "works" } : { workId: "review-api" }
        expect((await rpcCall(host, id, { sessionID: build, input })).output).toMatchObject(unknownWork(id, input))
      }
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
      // A select is resolved before the prompt, so the prompt names the works: that read is the only CLI call.
      expect(host.boxd.calls().filter((line) => !line.startsWith("machine list --region all"))).toEqual([])
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
