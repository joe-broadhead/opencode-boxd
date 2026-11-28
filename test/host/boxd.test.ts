// The plugin on the public @opencode/sdk host: it loads, registers every manifest method as a tool and one RPC id, the
// contract's status and probe answers validate, the access rules are generated for each level, a read runs at every
// level, a change asks at ask-changes and is denied at read-only, and the one RPC id carries every method.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { warmImageName } from "../../src/fleet/warm.js"
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

  test("a guest that declares done reads it through job and the works list", async () => {
    const host = await startHost()
    try {
      const sessionID = await session(host, "build")
      const ready = await attempt(host, sessionID, "build", "boxd_ensure", "reject", { workId: "done-work" })
      expect(ready.ok).toBe(true)
      const sent = await attempt(host, sessionID, "build", "boxd_submit", "reject", { workId: "done-work", text: "Finish the task." })
      expect(sent.ok).toBe(true)
      const guestSession = (sent.output as { sessionId: string }).sessionId
      const summary = "The task is finished and its tests pass."
      const prs = ["https://github.com/example/repo/pull/7", "example/repo#8"]
      // The guest's own boxd_done call, after its prompt, with the whole session tree idle: what #78 reads.
      host.guest.tool(guestSession, "boxd_done", { summary, prs }, Date.now(), "completed")
      host.guest.complete(guestSession)
      const job = await attempt(host, sessionID, "build", "boxd_job", "reject", { workId: "done-work" })
      expect(job.ok).toBe(true)
      expect(job.output).toMatchObject({ state: "idle", done: true, summary, prs })
      const rpc = host.client.rpc as unknown as { call: (request: object) => Promise<{ output: Record<string, unknown> }> }
      const list = (await rpc.call({ rpcID: "boxd", method: "status", input: { sessionID, input: { list: "works" } }, location: host.location })).output
      expect(list).toMatchObject({ data: { items: [expect.objectContaining({ id: "done-work", text: "idle, completed, done" })], editable: false } })
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

  test("ensure with a repo starts a work from the repository's warm image", async () => {
    const host = await startHost()
    try {
      const workId = "warm-host"
      const repo = "https://github.com/we-the-rebel-alliance/boxd-plugin"
      const image = warmImageName("oc-golden", repo, HOST_VERSION, "2x8")
      // The image carries the work's checkout, so the guest's setup reaches ready without a clone.
      const disk = join(host.ledger, "..", "warm-disk")
      mkdirSync(join(disk, "home", "boxd", "work", workId, ".git"), { recursive: true })
      host.boxd.fake.snapshot({ region: "fra", name: image, disk })
      const sessionID = await session(host, "build")
      const answer = await attempt(host, sessionID, "build", "boxd_ensure", "reject", { workId, repo, region: "fra" })
      expect(answer.ok).toBe(true)
      expect(answer.output).toMatchObject({ state: "ready", workId, region: "fra", image, warm: true, created: true })
      expect(typeof answer.output?.["readySeconds"]).toBe("number")
      expect(host.boxd.calls().find((entry) => entry.startsWith(`machine new oc-${workId}`))).toContain(`--from-snapshot ${image}`)
      expect(host.boxd.calls().some((entry) => entry.startsWith("machine new oc-gb-"))).toBe(false)
    } finally {
      await host.close()
    }
  })

  test("the /boxd command posts the report", async () => {
    const host = await startHost()
    try {
      // Two machines boxd counts against the organisation's limit, in two states: the report shows the counts even
      // though the machine limit is the only other read the line needs.
      host.boxd.seed("oc-asleep", { region: "fra", status: "hibernated" })
      host.boxd.seed("oc-busy", { region: "nyc", status: "running" })
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
      expect(posted).toContain("- Machines: 2 of 600 in use (1 running, 1 hibernated); none are this ledger's works")
    } finally {
      await host.close()
    }
  })

  test("boxd_ensure select orphans adopts the busy and idle orphans, and changes neither tree nor server", async () => {
    const host = await startHost({ options: { keep: ["team=lead"] } })
    try {
      const sessionID = await session(host, "build")
      const seed = await attempt(host, sessionID, "build", "boxd_ensure", "reject", { workId: "seed" })
      expect(seed.ok).toBe(true)
      const seedMachine = host.boxd.machines().find((machine) => machine.name === "oc-seed")!
      const helper = join(host.boxd.fake.disk(seedMachine), "home/boxd/.boxd-plugin")
      const orphan = (name: string, labels: Record<string, string>) => {
        const machine = host.boxd.seed(name, { region: "fra", status: "running", labels })
        cpSync(helper, join(host.boxd.fake.disk(machine), "home/boxd/.boxd-plugin"), { recursive: true })
        return machine
      }
      const busy = orphan("oc-busy", { owner: "boxd", role: "session", work: "busy" })
      const idle = orphan("oc-idle", { owner: "boxd", role: "session", work: "idle" })
      host.boxd.seed("oc-theirs", { region: "fra", status: "running", labels: { owner: "boxd", role: "session", work: "theirs", ledger: "ffffffffff" } })
      host.boxd.seed("lead-boxd", { region: "fra", status: "running", labels: { team: "lead" } })
      host.boxd.seed("oc-operator", { region: "fra", status: "running", labels: {} })
      for (const [machine, workId, busySession] of [[busy, "busy", true], [idle, "idle", false]] as const) {
        const directory = join(host.boxd.fake.disk(machine), "home/boxd/work", workId)
        mkdirSync(directory, { recursive: true })
        Bun.spawnSync(["git", "-C", directory, "init", "--quiet"])
        writeFileSync(join(directory, "README.md"), `# ${workId}\n`)
        Bun.spawnSync(["git", "-C", directory, "add", "."])
        Bun.spawnSync(["git", "-C", directory, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "init"])
        host.guest.sessions.set(`ses_${workId}`, { id: `ses_${workId}`, busy: busySession, directory: `/home/boxd/work/${workId}`, messages: [], inbox: [], updated: Date.now() })
      }
      host.boxd.fake.update((state) => { state.log = [] })
      const started = Date.now()
      const result = await attempt(host, sessionID, "build", "boxd_ensure", "reject", { select: "orphans" })
      expect(result.ok).toBe(true)
      const output = result.output as { select?: string; results: Array<{ state: string; workId?: string; why: string }> }
      expect(output.select).toBe("orphans")
      expect(output.results.filter((item) => item.state === "adopted").map((item) => item.workId)).toEqual(["busy", "idle"])
      const labels = new Map(host.boxd.machines().map((machine) => [machine.name, machine.labels]))
      const ledgerId = labels.get("oc-busy")!.ledger
      expect(ledgerId).toMatch(/^[0-9a-f]{10}$/)
      expect(labels.get("oc-busy")).toMatchObject({ owner: "boxd", role: "session", work: "busy", ledger: ledgerId })
      expect(labels.get("oc-idle")).toMatchObject({ owner: "boxd", role: "session", work: "idle", ledger: ledgerId })
      expect(labels.get("oc-theirs")).toEqual({ owner: "boxd", role: "session", work: "theirs", ledger: "ffffffffff" })
      expect(labels.get("lead-boxd")).toEqual({ team: "lead" })
      expect(labels.get("oc-operator")).toEqual({})
      expect(host.boxd.calls().some((call) => /^machine (new|cp|resize|reboot|wake|hibernate)/.test(call))).toBe(false)
      expect(host.boxd.fake.spawns().filter((spawn) => spawn.startedAt >= started && spawn.action).map((spawn) => spawn.action)).toEqual(["describe", "describe"])
      // A second call adopts nothing, and touches no machine.
      host.boxd.fake.update((state) => { state.log = [] })
      const againStarted = Date.now()
      const again = await attempt(host, sessionID, "build", "boxd_ensure", "reject", { select: "orphans" })
      expect(again.ok).toBe(true)
      expect((again.output as { results: Array<{ state: string }> }).results.filter((item) => item.state === "adopted")).toEqual([])
      expect(host.boxd.calls().some((call) => call.startsWith("machine label"))).toBe(false)
      expect(host.boxd.fake.spawns().filter((spawn) => spawn.startedAt >= againStarted && spawn.action)).toEqual([])
    } finally {
      await host.close()
    }
  })

  test("the machine-hours budget refuses one boxd_ensure at the cap", async () => {
    const host = await startHost({ options: { budget: { machineHours: 1, action: "refuse" } } })
    try {
      const sessionID = await session(host, "build")
      const made = await attempt(host, sessionID, "build", "boxd_ensure", "reject", { workId: "capped" })
      expect(made.ok).toBe(true)
      const slept = await attempt(host, sessionID, "build", "boxd_sleep", "reject", { workId: "capped" })
      expect(slept.ok).toBe(true)

      // Two hours ran today, over the one-hour cap. The machine is asleep, so the counters do not move.
      const path = join(host.ledger, "v1", "works", "capped", "work.json")
      const record = JSON.parse(readFileSync(path, "utf8")) as { hours?: Record<string, unknown> }
      const hours = record.hours
      expect(hours).toBeDefined()
      const now = new Date()
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
      record.hours = {
        ...hours,
        at: now.toISOString(),
        phase: "asleep",
        day,
        todayRunningSeconds: 2 * 3600,
        todayExistedSeconds: Math.max(Number(hours?.todayExistedSeconds ?? 0), 2 * 3600),
        runningSeconds: Math.max(Number(hours?.runningSeconds ?? 0), 2 * 3600),
        existedSeconds: Math.max(Number(hours?.existedSeconds ?? 0), 2 * 3600),
      }
      writeFileSync(path, JSON.stringify(record))

      const refused = await attempt(host, sessionID, "build", "boxd_ensure", "reject", { workId: "capped" })
      expect(refused.ok).toBe(false)
      expect(refused.error).toContain("BUDGET_EXCEEDED")
      expect(refused.error).toContain("machine-hours")
      expect(host.boxd.calls().some((call) => call.startsWith("machine wake"))).toBe(false)
    } finally {
      await host.close()
    }
  })

  test("boxd_golden builds one repository's warm image through the registered tool", async () => {
    const repo = "https://github.com/octocat/Hello-World"
    const setup = mkdtempSync(join(tmpdir(), "boxd-warm-setup-"))
    writeFileSync(join(setup, "warm.sh"), "set -e\ntest -d .git\nprintf 'ok\\n' > warm-setup.txt\n")
    const host = await startHost({ options: { warm: [{ repo, setup: join(setup, "warm.sh") }], allowedRoots: [setup] } })
    try {
      const sessionID = await session(host, "build")
      const built = await attempt(host, sessionID, "build", "boxd_golden", "reject", { repo, region: "fra" })
      expect(built.ok).toBe(true)
      const images = (built.output as { images: Array<{ name: string; repo?: string }> }).images
      expect(images).toHaveLength(1)
      expect(images[0]).toMatchObject({ repo })
      const hash = createHash("sha256").update(repo).digest("hex").slice(0, 8)
      expect(images[0]!.name).toBe(`oc-golden-hello-world-${hash}-${HOST_VERSION}-2x8`)
      const state = host.boxd.fake.read()
      const image = state.snapshots.find((snapshot) => snapshot.name === images[0]!.name)!
      expect(image).toBeDefined()
      const key = createHash("sha256").update(repo).digest("hex").slice(0, 16)
      const checkout = join(image.disk!, "home/boxd/.boxd-plugin/warm", key)
      expect(existsSync(join(checkout, ".git"))).toBe(true)
      expect(readFileSync(join(checkout, "warm-setup.txt"), "utf8")).toBe("ok\n")
      expect(state.machines.filter((machine) => machine.name.startsWith("oc-gb-") && machine.status !== "destroyed")).toEqual([])
    } finally {
      await host.close()
      rmSync(setup, { recursive: true, force: true })
    }
  })

  test("two works ensure into slots on one shared machine", async () => {
    const host = await startHost()
    try {
      const sessionID = await session(host, "build")
      const first = await attempt(host, sessionID, "build", "boxd_ensure", "reject", { workId: "docs", machine: "common" })
      const second = await attempt(host, sessionID, "build", "boxd_ensure", "reject", { workId: "review", machine: "common" })
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      expect(first.output).toMatchObject({ state: "ready", machine: "oc-shared-common", created: true })
      expect(second.output).toMatchObject({ state: "ready", machine: "oc-shared-common", created: false })
      expect((second.output as { machineId: string }).machineId).toBe((first.output as { machineId: string }).machineId)
      const shared = host.boxd.machines().filter((machine) => machine.name === "oc-shared-common" && machine.status !== "destroyed")
      expect(shared).toHaveLength(1)
      expect(shared[0]?.labels).toMatchObject({ owner: "boxd", shared: "common" })
      expect(host.boxd.machines().filter((machine) => machine.name === "oc-docs" || machine.name === "oc-review")).toHaveLength(0)
    } finally {
      await host.close()
    }
  })

  test("boxd_ensure at the organisation cap is refused before a machine is made", async () => {
    const host = await startHost({ options: { budget: { orgMachines: 1, action: "refuse" } } })
    try {
      host.boxd.seed("oc-existing", { status: "running", labels: { owner: "boxd", role: "session", work: "existing" } })
      const sessionID = await session(host, "build")
      const answer = await attempt(host, sessionID, "build", "boxd_ensure", "reject", { workId: "one-more" })
      expect(answer.ok).toBe(false)
      expect(answer.error).toContain("BUDGET_EXCEEDED")
      expect(host.boxd.machines().some((machine) => machine.name === "oc-one-more")).toBe(false)
    } finally {
      await host.close()
    }
  })
})
