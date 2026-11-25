// The plugin on the public @opencode/sdk host: it loads, registers every manifest method as a tool and one RPC id, the
// contract's status and probe answers validate, the access rules are generated for each level, a read runs at every
// level, a change asks at ask-changes and is denied at read-only, and the one RPC id carries every method.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, sep } from "node:path"
import { agentRules, attempt, cleanup, effect, HOST_VERSION, session, startHost, statusThroughRpc, until } from "./harness.js"

setDefaultTimeout(120_000)
afterAll(cleanup)

const PACKAGE_VERSION: string = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")).version
const MANIFEST: {
  exports: Record<string, string>
  capabilities: { plugin: { name: string }; accounts: { via: string }; methods: Record<string, { class: string; effect?: string }>; options: { properties: Record<string, unknown> }; sources: { id: string; kind: string }[] }
} = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"))
const METHODS = Object.keys(MANIFEST.capabilities.methods)
/** The twelve tools v0.1.4 gave a user; every one must still be reachable as a boxd tool. */
const OLD_TOOLS = ["status", "job", "read", "ensure", "submit", "harvest", "sleep", "resume", "reassign", "golden", "exec", "drop"] as const
const SKILLS = join(import.meta.dir, "..", "..", "skills")

/** Every skills/<id>/SKILL.md on disk, with the id and description a real YAML parser reads from its frontmatter. */
function skillFiles(): { id: string; path: string; description: string }[] {
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS, entry.name, "SKILL.md")))
    .map((entry) => {
      const path = join(SKILLS, entry.name, "SKILL.md")
      const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n")
      const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)?.[1]
      const parsed = front === undefined ? undefined : (Bun.YAML.parse(front) as unknown)
      const fields = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
      return {
        id: typeof fields.name === "string" ? fields.name : entry.name,
        path,
        description: typeof fields.description === "string" ? fields.description : "",
      }
    })
}

/** A description that is absent, or a bare YAML block-scalar indicator, is not a skill description. */
const badDescription = (description: string): boolean => description === "" || description === ">" || description === "|"

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
      expect(status["accounts"]).toEqual([{ alias: "default", state: "ready", owner: expect.objectContaining({ id: expect.stringMatching(/^os-user:/) }) }])
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

  test("registers every skills/<id>/SKILL.md with its description, path and content", async () => {
    const host = await startHost()
    try {
      // An empty temp project: the host's own skills/ discovery cannot supply the plugin's skill.
      expect(host.location.directory.startsWith(SKILLS)).toBe(false)
      expect(existsSync(join(host.location.directory, "skills"))).toBe(false)
      const files = skillFiles()
      expect(files.length).toBeGreaterThan(0)
      const listed = await until("every skill file is registered", async () => {
        const { data } = await host.client.skill.list({ location: host.location })
        const ids = new Set(data.map((skill) => String(skill.id)))
        return files.every((file) => ids.has(file.id)) ? data : false
      })
      const byId = new Map(listed.map((skill) => [String(skill.id), skill]))
      for (const file of files) {
        const skill = byId.get(file.id)
        expect(skill).toBeDefined()
        const description = String(skill!.description ?? "")
        expect(badDescription(description)).toBe(false)
        expect(badDescription(file.description)).toBe(false)
        expect(description).toBe(file.description)
        expect(String(skill!.path)).toBe(file.path)
        expect(String(skill!.content).trim().length).toBeGreaterThan(0)
        expect(existsSync(file.path)).toBe(true)
      }
      // A registered skill whose path is under the plugin's skills/ tree must have its file; a file that is not
      // registered already failed the `until` above.
      const fileIds = new Set(files.map((file) => file.id))
      const ours = listed.filter((skill) => fileIds.has(String(skill.id)) || String(skill.path).includes(`${sep}skills${sep}`))
      for (const skill of ours) expect(existsSync(String(skill.path))).toBe(true)
      expect(ours.filter((skill) => fileIds.has(String(skill.id))).map((skill) => String(skill.id)).sort()).toEqual(files.map((file) => file.id).sort())
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
      expect(MANIFEST.capabilities.accounts.via).toBe("local")
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
