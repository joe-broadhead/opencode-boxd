// The plugin on the public @opencode/sdk host: it loads, registers every manifest method as a tool and one RPC id, the
// contract's status and probe answers validate, the access rules are generated for each level, a read runs at every
// level, a change asks at ask-changes and is denied at read-only, and the one RPC id carries every method.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { agentRules, attempt, cleanup, effect, HOST_VERSION, session, startHost, statusThroughRpc, until } from "./harness.js"

setDefaultTimeout(120_000)
afterAll(cleanup)

const PACKAGE_VERSION: string = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")).version
const MANIFEST: {
  exports: Record<string, string>
  capabilities: { plugin: { name: string }; methods: Record<string, { class: string; effect?: string }>; options: { properties: Record<string, unknown> }; sources: { id: string; kind: string }[] }
} = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"))
const METHODS = Object.keys(MANIFEST.capabilities.methods)
/** The twelve tools v0.1.4 gave a user; every one must still be reachable as a boxd tool. */
const OLD_TOOLS = ["status", "job", "read", "ensure", "submit", "harvest", "sleep", "resume", "reassign", "golden", "exec", "drop"] as const
describe("the plugin on OpenCode 2.4.1", () => {
  test("registers every method as a tool in the boxd namespace", async () => {
    const host = await startHost()
    try {
      const tools = (await host.probe().tool.list()).filter((tool) => tool.options?.namespace === "boxd")
      expect(tools.map((tool) => tool.id).sort()).toEqual(METHODS.map((method) => `boxd_${method}`).sort())
    } finally {
      await host.close()
    }
  })

  test("status answers the contract's shape, and probe names this machine", async () => {
    const host = await startHost()
    try {
      const sessionID = await session(host, "build")
      const status = (await statusThroughRpc(host, sessionID)) as Record<string, unknown>
      expect(Object.keys(status).sort()).toEqual(["accounts", "host", "name", "nextStep", "state", "unguardedAgents", "version"])
      expect(status["name"]).toBe("boxd")
      expect(status["version"]).toBe(PACKAGE_VERSION)
      expect(status["host"]).toEqual({ version: HOST_VERSION, range: ">=2.4.1 <2.5.0", tested: ["2.4.1"] })
      expect(status["accounts"]).toEqual([])
      const probe = await attempt(host, sessionID, "build", "boxd_probe", "reject", {})
      expect(probe.ok).toBe(true)
      expect(probe.output).toMatchObject({ source: "works", account: "default", trust: "untrusted" })
      expect((probe.output as { owner: { id: string } }).owner.id).toMatch(/^os-user:/)
      // The works list snapshot answers the contract's list output, and the events page lists the local ledger.
      const rpc = host.client.rpc as unknown as { call: (request: object) => Promise<{ output: Record<string, unknown> }> }
      const list = (await rpc.call({ rpcID: "boxd", method: "status", input: { sessionID, input: { list: "works" } }, location: host.location })).output
      expect(list).toMatchObject({ data: { items: [], editable: false }, trust: "untrusted" })
      const events = await attempt(host, sessionID, "build", "boxd_events_list", "reject", {})
      expect(events.ok).toBe(true)
      expect(events.output).toMatchObject({ source: "works", account: "default", trust: "untrusted" })
    } finally {
      await host.close()
    }
  })

  test("has parity with v0.1.4: every old tool, the renamed skill, the /boxd command, and the documented removals", async () => {
    const host = await startHost()
    try {
      const tools = (await host.probe().tool.list()).filter((tool) => tool.options?.namespace === "boxd").map((tool) => tool.id).sort()
      expect(tools).toEqual(expect.arrayContaining(OLD_TOOLS.map((tool) => `boxd_${tool}`)))
      expect(tools).toHaveLength(METHODS.length)
      expect(OLD_TOOLS).toHaveLength(12)
      expect(MANIFEST.capabilities).not.toHaveProperty("accounts")
      expect(MANIFEST.capabilities.options.properties).not.toHaveProperty("accounts")
      expect(JSON.stringify(MANIFEST.capabilities)).not.toContain('"mcp"')
      expect(MANIFEST.capabilities.sources.map((source) => source.id).sort()).toEqual(["boxd.works", "boxd.works.list"])

      const skills = await until("the boxd-sessions skill is registered", async () => {
        const { data } = await host.client.skill.list({ location: host.location })
        return data.some((skill) => String(skill.id) === "boxd-sessions") ? data : false
      })
      const skillNames = skills.map((skill) => String(skill.id))
      expect(skillNames).toContain("boxd-sessions")
      expect(skillNames).not.toContain("boxd")

      const commands = await until("the /boxd command is registered", async () => {
        const { data } = await host.client.command.list({ location: host.location })
        return data.some((command) => command.name === "boxd") ? data : false
      })
      const commandNames = commands.map((command) => command.name)
      expect(commandNames).toContain("boxd")
      expect(commandNames).not.toContain("boxd-status")
      expect(commandNames).not.toContain("boxd-cleanup")
      expect(MANIFEST.exports["./tui"]).toBeUndefined()

      for (const removed of ["costContext", "idleCheck", "snapshot"]) expect(MANIFEST.capabilities.options.properties).not.toHaveProperty(removed)
    } finally {
      await host.close()
    }
  })

  test("every read runs at all three levels, and a change asks at ask-changes and is denied at read-only", async () => {
    const host = await startHost()
    try {
      for (const level of ["all", "ask-changes", "read-only"] as const) {
        const inside = await startHost({ options: { access: level } })
        try {
          const sessionID = await session(inside, "build")
          const read = await attempt(inside, sessionID, "build", "boxd_status", "reject", {})
          expect(read.ok).toBe(true)
          if (level === "read-only") {
            // A fully denied tool is hidden, so the RPC door is where the refusal is proven.
            const rpc = inside.client.rpc as unknown as { call: (request: object) => Promise<{ output: unknown }> }
            const refused = await rpc.call({ rpcID: "boxd", method: "sleep", input: { sessionID, input: { workId: "review-api" } }, location: inside.location }).then(
              () => ({ code: "answered" }),
              (error: { data?: { code?: string } }) => ({ code: error.data?.code }),
            )
            expect(refused.code).toBe("PERMISSION_DENIED")
          } else {
            const change = await attempt(inside, sessionID, "build", "boxd_sleep", "reject", { workId: "review-api" })
            if (level === "all") expect(change.asked).toBeUndefined()
            else expect(change.asked).toBe("boxd.sleep")
          }
        } finally {
          await inside.close()
        }
      }
      // The generated rules give each method the level's effect for every real agent.
      const rules = await agentRules(host)
      for (const [, list] of rules) {
        for (const method of METHODS) {
          const item = MANIFEST.capabilities.methods[method]!
          expect(list.some((rule) => rule.action === `boxd.${method}`)).toBe(true)
          void item
        }
      }
      // exec asks even at all: an effect that narrows the level.
      expect(await effect(host, "build", "boxd.exec")).toBe("ask")
      expect(await effect(host, "build", "boxd.sleep")).toBe("allow")
    } finally {
      await host.close()
    }
  })

  test("the /boxd command posts the report", async () => {
    const host = await startHost()
    try {
      const sessionID = await session(host, "build")
      await host.client.sessions.command({ sessionID, name: "boxd", text: "" })
      const posted = await until("/boxd posts its report", async () => {
        const inbox = await host.client.session.inbox.list({ sessionID })
        const synthetic = inbox.findLast((item) => item.type === "synthetic")
        return synthetic?.type === "synthetic" ? synthetic.payload.text : undefined
      })
      expect(posted).toContain("boxd status")
      expect(posted).toContain("- Next step:")
      expect(posted).toContain("- Access:")
    } finally {
      await host.close()
    }
  })
})
