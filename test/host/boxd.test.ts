// The plugin on the public @opencode/sdk host: it loads, inserts the default rules, asks for every machine change and
// never for a read, runs a whole work against a fake boxd CLI and a fake guest, answers describe and the status RPC,
// and runs nothing when the prompt is declined.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { SUPPORTED_HOST } from "../../src/constants.js"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { defaultRules, type Rule } from "../../src/permissions.js"
import { TOOLS, CHANGING_TOOLS, READ_TOOLS } from "../../src/tools.js"
import { TOOLS_RPC_ID } from "../../src/host/tools-rpc.js"
import { agentRules, attempt, cleanup, effect, HOST_VERSION, session, startHost, statusThroughRpc, until } from "./harness.js"

setDefaultTimeout(120_000)
afterAll(cleanup)

const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect })

/** The status text /boxd-status posts. */
async function statusText(host: Awaited<ReturnType<typeof startHost>>, sessionID: string) {
  await host.client.sessions.command({ sessionID, name: "boxd-status", text: "" })
  return until("/boxd-status posts its text", async () => {
    const inbox = await host.client.session.inbox.list({ sessionID })
    const posted = inbox.findLast((item) => item.type === "synthetic")
    return posted?.type === "synthetic" ? posted.payload.text : undefined
  })
}

describe("the plugin on a stock host", () => {
  test("loads, registers the nine tools, adds the default rules, and answers status", async () => {
    const host = await startHost()
    try {
      const tools = (await host.probe().tool.list()).map((tool) => tool.id).filter((id) => id.startsWith("boxd_"))
      expect(tools.sort()).toEqual(TOOLS.map((tool) => `boxd_${tool.name}`).sort())

      const rules = (await agentRules(host)).get("build")!
      const block = defaultRules()
      expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "allow" })
      expect(rules.slice(1, 1 + block.length)).toEqual(block)

      // The host's own evaluation, for the agent the plugin guarded.
      expect(await effect(host, "build", "boxd_ensure")).toBe("ask")
      expect(await effect(host, "build", "boxd_status")).toBe("allow")

      const status = await statusThroughRpc(host)
      expect(status).toMatchObject({ version: "0.0.0", state: "connected", host: { version: HOST_VERSION, range: SUPPORTED_HOST, tested: true }, openWorks: 0, unguardedAgents: [], nextStep: "Nothing to do." })
      expect(status.works).toEqual([])

      const text = await statusText(host, await session(host))
      expect(text).toContain("- Connection: connected")
      expect(text).toContain("- Snapshot: opencode-golden")
      expect(text).toContain("- Next step: Nothing to do.")
      expect(text.split("\n").filter((line) => line.startsWith("- Next step:"))).toHaveLength(1)
    } finally {
      await host.close()
    }
  })

  test("a read runs without asking; a machine change asks, and a decline runs nothing", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      const before = host.boxd.calls().length

      expect(await attempt(host, build, "build", "boxd_status")).toMatchObject({ asked: undefined, ok: true })
      expect(await attempt(host, build, "build", "boxd_job", "reject", { workId: "review-api" })).toMatchObject({ asked: undefined })

      const declined = await attempt(host, build, "build", "boxd_ensure", "reject", { workId: "review-api", directory: host.location.directory })
      expect(declined.asked).toBe("boxd_ensure")
      expect(declined.ok).toBe(false)
      // The decline stopped the call before the CLI ran: no machine was created.
      expect(host.boxd.calls().slice(before).filter((call) => call.startsWith("machine new"))).toEqual([])
      expect(host.boxd.machines()).toEqual({})

      const allowed = await attempt(host, build, "build", "boxd_ensure", "once", { workId: "review-api", directory: host.location.directory })
      expect(allowed.asked).toBe("boxd_ensure")
      expect(allowed.output).toMatchObject({ workId: "review-api", machine: "oc-review-api", state: "ready", guestVersion: HOST_VERSION })
      expect(host.boxd.calls().some((call) => call.startsWith("machine new oc-review-api"))).toBe(true)
    } finally {
      await host.close()
    }
  })

  test("runs a whole work: ensure, submit, job, harvest, drop, against the fake CLI and the fake guest", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      const work = host.location.directory
      expect(await attempt(host, build, "build", "boxd_ensure", "always", { workId: "review-api", directory: work })).toMatchObject({ ok: true })

      const admitted = await attempt(host, build, "build", "boxd_submit", "always", { workId: "review-api", text: "Add a health check." })
      expect(admitted.output).toMatchObject({ state: "admitted", sessionId: "ses_guest_root" })
      expect(host.guest.prompts).toEqual([{ sessionID: "ses_guest_root", text: "Add a health check." }])

      expect((await attempt(host, build, "build", "boxd_job", "always", { workId: "review-api" })).output).toMatchObject({ state: "busy" })
      host.guest.idle("ses_guest_root")
      expect((await attempt(host, build, "build", "boxd_job", "always", { workId: "review-api" })).output).toMatchObject({ state: "idle" })

      const harvested = await attempt(host, build, "build", "boxd_harvest", "always", { workId: "review-api", localDirectory: work })
      expect(harvested.output).toMatchObject({ state: "proven", sessions: [{ remoteId: "ses_guest_root", importedId: "ses_guest_root" }] })
      expect(host.imports.map((item) => item.remoteId)).toEqual(["ses_guest_root"])

      expect((await attempt(host, build, "build", "boxd_sleep", "always", { workId: "review-api" })).output).toMatchObject({ state: "hibernated" })
      expect(host.boxd.machines()["oc-review-api"]?.status).toBe("hibernated")
      expect((await attempt(host, build, "build", "boxd_drop", "always", { workId: "review-api" })).output).toMatchObject({ state: "dropped" })
      expect(host.boxd.machines()["oc-review-api"]?.status).toBe("destroyed")

      // The ledger now reports the work as closed.
      expect((await statusThroughRpc(host)).openWorks).toBe(0)
    } finally {
      await host.close()
    }
  })

  test("describe lists every method with its class, and a script's write runs only with an allow rule", async () => {
    const host = await startHost()
    try {
      /** One tools RPC call: its output, or the error the envelope carries. */
      const call = async (method: string, input: unknown) => {
        const rpc = host.client.rpc as unknown as { call: (request: object) => Promise<Record<string, any>> }
        return rpc.call({ rpcID: TOOLS_RPC_ID, method, input, location: host.location })
      }
      const build = await session(host)
      const listing = (await call("describe", { sessionID: build })).output as { methods: Array<Record<string, any>>; unclassified: string[] }
      expect(listing.methods.map((method) => method.name)).toEqual(TOOLS.map((tool) => tool.id))
      expect(listing.unclassified ?? []).toEqual([])
      for (const method of listing.methods) {
        const spec = TOOLS.find((tool) => tool.id === method.name)!
        expect({ name: method.name, kind: method.kind, class: method.class, action: method.action }).toEqual({ name: method.name, kind: "plugin", class: spec.class, action: spec.id })
      }

      const before = host.boxd.calls().length
      // The client raises the RPC's own error: a resolved ask is refused before dispatch, with no prompt and no call.
      const refused = await call("boxd_ensure", { sessionID: build, input: { workId: "review-api" } }).then(
        () => undefined,
        (error: { data?: { code?: string } }) => error,
      )
      expect(refused?.data?.code).toBe("PERMISSION_DENIED")
      expect(host.boxd.calls().slice(before).filter((line) => line.startsWith("machine new"))).toEqual([])

      // A session that allows the action is the script's grant.
      const granted = await session(host, "build", [rule("boxd_ensure", "allow")])
      const ran = (await call("boxd_ensure", { sessionID: granted, input: { workId: "review-api", directory: host.location.directory } })).output
      expect(ran).toMatchObject({ workId: "review-api", machine: "oc-review-api", state: "ready" })
    } finally {
      await host.close()
    }
  })
})

describe("a create needs its golden image", () => {
  test("with no golden snapshot, status says so, and ensure and resume refuse before any create", async () => {
    const host = await startHost()
    try {
      host.boxd.setSnapshots([])
      const build = await session(host)
      const status = await statusThroughRpc(host)
      expect(status).toMatchObject({ snapshot: "opencode-golden", snapshotPresent: false })
      expect(String(status.nextStep)).toContain("docs/golden-image.md")

      const before = host.boxd.calls().length
      const refused = await attempt(host, build, "build", "boxd_ensure", "always", { workId: "review-api", directory: host.location.directory })
      expect(refused.output).toMatchObject({ error: "SNAPSHOT_MISSING" })
      expect(host.boxd.calls().slice(before).filter((call) => call.startsWith("machine new"))).toEqual([])
      expect(host.boxd.machines()).toEqual({})

      // Add the image, and the same call creates the machine. The ensure re-reads the listing, so status is fresh again.
      host.boxd.setSnapshots(["opencode-golden"])
      expect(await attempt(host, build, "build", "boxd_ensure", "always", { workId: "review-api", directory: host.location.directory })).toMatchObject({ ok: true })
      expect(host.boxd.machines()["oc-review-api"]?.status).toBe("running")
      expect((await statusThroughRpc(host)).snapshotPresent).toBe(true)
    } finally {
      await host.close()
    }
  })
})

describe("a read never bills, and a drop never loses a file", () => {
  test("boxd_job on a hibernated work reports asleep and the CLI never wakes it", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      await attempt(host, build, "build", "boxd_ensure", "always", { workId: "review-api", directory: host.location.directory })
      host.boxd.seed("oc-review-api", { status: "hibernated" })
      const before = host.boxd.calls().length
      const job = await attempt(host, build, "build", "boxd_job", "reject", { workId: "review-api" })
      expect(job.asked).toBeUndefined()
      expect(job.output).toMatchObject({ state: "asleep", machineStatus: "hibernated" })
      expect(host.boxd.calls().slice(before).filter((call) => call.startsWith("wake") || call.startsWith("hold"))).toEqual([])
    } finally {
      await host.close()
    }
  })

  test("an untracked file is captured, named, and refuses the drop", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      const work = host.location.directory
      await attempt(host, build, "build", "boxd_ensure", "always", { workId: "review-api", directory: work })
      await attempt(host, build, "build", "boxd_submit", "always", { workId: "review-api", text: "Write notes." })
      host.guest.idle("ses_guest_root")
      writeFileSync(join(work, "notes.txt"), "a note the session wrote\n")

      const harvested = await attempt(host, build, "build", "boxd_harvest", "always", { workId: "review-api", localDirectory: work })
      expect(harvested.output).toMatchObject({ state: "proven", git: { known: true, untracked: ["notes.txt"] } })
      expect(String((harvested.output as { next?: string }).next)).toContain("Commit or delete notes.txt")

      const dropped = await attempt(host, build, "build", "boxd_drop", "always", { workId: "review-api" })
      expect(dropped.output).toMatchObject({ error: "UNTRACKED" })
      expect(host.boxd.machines()["oc-review-api"]?.status).not.toBe("destroyed")
    } finally {
      await host.close()
    }
  })
})

describe("the status RPC", () => {
  test("reports the open work, the unharvested flag and the guest version", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      await attempt(host, build, "build", "boxd_ensure", "always", { workId: "review-api", directory: host.location.directory })
      host.boxd.seed("oc-review-api", { status: "hibernated" })
      const status = await statusThroughRpc(host)
      expect(status).toMatchObject({ state: "connected", openWorks: 1, guestVersion: HOST_VERSION, snapshot: "opencode-golden", unknownCount: 0 })
      expect(status.works).toEqual([{ workId: "review-api", machine: "oc-review-api", sessionId: null, proof: "missing", dirty: false, machineStatus: "hibernated", warnings: [] }])
      expect(status.unharvested).toEqual(["review-api"])
      expect(String(status.nextStep)).toContain("boxd_harvest for review-api")
    } finally {
      await host.close()
    }
  })

  test("names an agent that lacks the default rules", async () => {
    const host = await startHost({ config: { agents: { lonely: { description: "No rules of its own", mode: "subagent" } } } })
    try {
      const status = await statusThroughRpc(host)
      expect(status.unguardedAgents).toContain("lonely")
      expect(String(status.nextStep)).toContain("Put the default rules")
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

// The two reads and the seven changes, as the plugin declares them.
test("the read and change lists match the table", () => {
  expect(READ_TOOLS).toEqual(["boxd_status", "boxd_job"])
  expect(CHANGING_TOOLS).toHaveLength(7)
})
