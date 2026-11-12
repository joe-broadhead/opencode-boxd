// The plugin on the public @opencode/sdk host: it loads, inserts the default rules, asks for every machine change and
// never for a read, runs a whole work against a fake boxd CLI and a fake guest, answers describe and the status RPC,
// and runs nothing when the prompt is declined.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { SUPPORTED_HOST } from "../../src/constants.js"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
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
      // Every tool is allowed by default , so the host's own evaluation says allow for a change too.
      expect(await effect(host, "build", "boxd_ensure")).toBe("allow")
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

  test("a read and a machine change run without asking by default; an agent that asks, and a decline, run nothing", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      const before = host.boxd.calls().length

      expect(await attempt(host, build, "build", "boxd_status")).toMatchObject({ asked: undefined, ok: true })
      expect(await attempt(host, build, "build", "boxd_job", "reject", { workId: "review-api" })).toMatchObject({ asked: undefined })

      // Every tool is allowed by default now, so the change runs with no prompt at all.
      const direct = await attempt(host, build, "build", "boxd_ensure", "reject", { workId: "review-api", directory: host.location.directory })
      expect(direct.asked).toBeUndefined()
      expect(direct.output).toMatchObject({ workId: "review-api", machine: "oc-review-api", state: "ready", guestVersion: HOST_VERSION })
      expect(host.boxd.calls().some((call) => call.startsWith("machine new oc-review-api"))).toBe(true)

      // An agent that asks for that tool still gets its prompt, and a decline stops the call before the CLI runs.
      const asking = await session(host, "build", [rule("boxd_submit", "ask")])
      const declined = await attempt(host, asking, "build", "boxd_submit", "reject", { workId: "review-api", text: "Add a health check." })
      expect(declined.asked).toBe("boxd_submit")
      expect(declined.ok).toBe(false)
      expect(host.guest.prompts).toEqual([])
      expect(host.boxd.calls().slice(before).filter((call) => call.startsWith("machine new")).length).toBe(1)
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

  test("describe lists every method with its class, and a write runs by default but not under a deny", async () => {
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

      // A plugin code is the method's output, not an RPC error: the code, what happened and the next step.
      const unopened = (await call("boxd_job", { sessionID: build, input: { workId: "review-api" } })).output
      expect(unopened).toEqual({ error: "NOT_OURS", message: 'No open work "review-api".', next: "Call boxd_ensure for this work id, and act only on the machine the ledger records for it." })

      const before = host.boxd.calls().length
      // The default block allows every tool, so a script's write is the same call a model's is: it runs.
      const ran = (await call("boxd_ensure", { sessionID: build, input: { workId: "review-api", directory: host.location.directory } })).output
      expect(ran).toMatchObject({ workId: "review-api", machine: "oc-review-api", state: "ready" })
      expect(host.boxd.calls().slice(before).filter((line) => line.startsWith("machine new")).length).toBe(1)

      // A deny is refused too, with no call: the rule in the session narrows the agent's allow.
      const denied = await session(host, "build", [rule("boxd_drop", "deny")])
      const refusedByDeny = await call("boxd_drop", { sessionID: denied, input: { workId: "review-api" } }).then(
        () => undefined,
        (error: { data?: { code?: string } }) => error,
      )
      expect(refusedByDeny?.data?.code).toBe("PERMISSION_DENIED")
      expect(host.boxd.calls().some((line) => line.startsWith("machine remove oc-review-api"))).toBe(false)

      // An unknown name is denied by the host: it is not a method of this RPC.
      const unknown = await call("boxd_no_such_tool", { sessionID: build, input: {} }).then(
        () => undefined,
        (error: { code?: string; data?: { code?: string } }) => error,
      )
      expect(unknown).toBeDefined()
    } finally {
      await host.close()
    }
  })
})

describe("the access option", () => {
  /** One tools RPC call, as the client raises it: the output, or the error's code. */
  const caller = (host: Awaited<ReturnType<typeof startHost>>) => ({
    call: async (method: string, input: unknown) => {
      const rpc = host.client.rpc as unknown as { call: (request: object) => Promise<Record<string, any>> }
      return rpc.call({ rpcID: TOOLS_RPC_ID, method, input, location: host.location })
    },
  })

  test("all (the default) runs a write with no prompt", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      const before = host.boxd.calls().length
      const ran = (await caller(host).call("boxd_ensure", { sessionID: build, input: { workId: "review-api", directory: host.location.directory } })).output
      expect(ran).toMatchObject({ workId: "review-api", machine: "oc-review-api", state: "ready" })
      expect(host.boxd.calls().slice(before).some((line) => line.startsWith("machine new oc-review-api"))).toBe(true)
      expect(await host.probe().permission.list({ sessionID: build })).toEqual([])
      expect((await statusThroughRpc(host)).access).toBe("all")
    } finally {
      await host.close()
    }
  }, 120_000)

  test("ask-changes refuses a write on the RPC path with no server call", async () => {
    const host = await startHost({ options: { access: "ask-changes" } })
    try {
      const build = await session(host)
      const before = host.boxd.calls().length
      const refused = await caller(host).call("boxd_ensure", { sessionID: build, input: { workId: "review-api" } }).then(
        () => undefined,
        (error: { data?: { code?: string } }) => error,
      )
      expect(refused?.data?.code).toBe("PERMISSION_DENIED")
      expect(host.boxd.calls().slice(before).filter((line) => line.startsWith("machine new"))).toEqual([])
      // A read still runs, and the status says which posture is in force.
      expect((await caller(host).call("boxd_status", { sessionID: build, input: {} })).output).toBeDefined()
      expect((await statusThroughRpc(host)).access).toBe("ask-changes")
    } finally {
      await host.close()
    }
  }, 120_000)

  test("read-only denies a write", async () => {
    const host = await startHost({ options: { access: "read-only" } })
    try {
      const build = await session(host)
      const before = host.boxd.calls().length
      const refused = await caller(host).call("boxd_ensure", { sessionID: build, input: { workId: "review-api" } }).then(
        () => undefined,
        (error: { data?: { code?: string } }) => error,
      )
      expect(refused?.data?.code).toBe("PERMISSION_DENIED")
      expect(host.boxd.calls().slice(before)).toEqual([])
      // The read is untouched by read-only.
      expect((await caller(host).call("boxd_job", { sessionID: build, input: { workId: "review-api" } })).output).toBeDefined()
    } finally {
      await host.close()
    }
  }, 120_000)
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
      expect(refused.output).toMatchObject({ error: "SNAPSHOT_MISSING", message: 'The golden snapshot "opencode-golden" is not in this boxd account.' })
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
      // The guest's tree is its own folder: /home/boxd/work/<id>, mapped here.
      writeFileSync(join(work, "review-api", "notes.txt"), "a note the session wrote\n")

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

describe("a failed run is reported, never hidden", () => {
  const AUTH = { type: "provider.auth", message: "Go Teams covers workspace members, not service accounts. Use a personal API key to call Go models." }

  test("boxd_job says the last run failed, and the harvest proves the transcript with the warning", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      const work = host.location.directory
      await attempt(host, build, "build", "boxd_ensure", "always", { workId: "review-api", directory: work })
      await attempt(host, build, "build", "boxd_submit", "always", { workId: "review-api", text: "Reply with OK." })
      host.guest.fail("ses_guest_root", AUTH)

      const job = await attempt(host, build, "build", "boxd_job", "reject", { workId: "review-api" })
      expect(job.output).toMatchObject({ state: "idle", outcome: "failed", error: "provider.auth: Go Teams covers workspace members, not service accounts. Use a personal API key to call Go models" })
      expect(String((job.output as { next?: string }).next)).toContain("Fix the guest's model credentials")

      const harvested = await attempt(host, build, "build", "boxd_harvest", "always", { workId: "review-api", localDirectory: work })
      // The transcript is imported and proven; the failed run is a warning, not a refusal.
      expect(harvested.output).toMatchObject({ state: "proven", outcome: "failed", warning: "GUEST_AUTH_FAILED" })
      expect(String((harvested.output as { next?: string }).next)).toContain("Fix the guest's model credentials")

      // Status carries it, so a later turn cannot read the work as done.
      const status = await statusThroughRpc(host)
      expect(status.failedRuns).toEqual([{ workId: "review-api", error: "provider.auth: Go Teams covers workspace members, not service accounts. Use a personal API key to call Go models" }])
      expect(String(status.nextStep)).toContain("The last run of review-api failed")
    } finally {
      await host.close()
    }
  })

  test("the newest run's error is the one reported, after an earlier run completed", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      await attempt(host, build, "build", "boxd_ensure", "always", { workId: "review-api", directory: host.location.directory })
      await attempt(host, build, "build", "boxd_submit", "always", { workId: "review-api", text: "Reply with OK." })
      host.guest.complete("ses_guest_root")
      await attempt(host, build, "build", "boxd_submit", "always", { workId: "review-api", text: "Reply with OK again." })
      host.guest.fail("ses_guest_root", AUTH)

      // The server lists messages newest first: the newest idle message is this run's, not the first run's.
      const job = await attempt(host, build, "build", "boxd_job", "reject", { workId: "review-api" })
      expect(job.output).toMatchObject({ state: "idle", outcome: "failed", warning: "GUEST_AUTH_FAILED", error: "provider.auth: Go Teams covers workspace members, not service accounts. Use a personal API key to call Go models" })
    } finally {
      await host.close()
    }
  })

  test("a completed run reports completed, with no warning", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      const work = host.location.directory
      await attempt(host, build, "build", "boxd_ensure", "always", { workId: "review-api", directory: work })
      await attempt(host, build, "build", "boxd_submit", "always", { workId: "review-api", text: "Reply with OK." })
      host.guest.complete("ses_guest_root")
      expect((await attempt(host, build, "build", "boxd_job", "reject", { workId: "review-api" })).output).toMatchObject({ state: "idle", outcome: "completed" })
      const harvested = await attempt(host, build, "build", "boxd_harvest", "always", { workId: "review-api", localDirectory: work })
      expect(harvested.output).toMatchObject({ state: "proven", outcome: "completed" })
      expect(harvested.output).not.toHaveProperty("warning")
      expect((await statusThroughRpc(host)).failedRuns).toEqual([])
    } finally {
      await host.close()
    }
  })
})

describe("files in and out", () => {
  test("submit copies data to the machine, harvest brings a result back, and the drop is then allowed", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      const project = host.location.directory
      // The guest's work tree is a folder of its own under /home/boxd/work; the fake maps it into the project.
      const guestWork = join(project, "review-api")
      await attempt(host, build, "build", "boxd_ensure", "always", { workId: "review-api", directory: project })
      writeFileSync(join(project, "bookmarks.json"), '{"links":["https://example.com"]}\n')

      const submitted = await attempt(host, build, "build", "boxd_submit", "always", {
        workId: "review-api",
        text: "Read data/bookmarks.json and write SUMMARY.md.",
        files: [{ from: join(project, "bookmarks.json"), to: "data/bookmarks.json" }],
      })
      expect(submitted.output).toMatchObject({ state: "admitted", files: [{ path: "data/bookmarks.json" }] })
      expect(readFileSync(join(guestWork, "data", "bookmarks.json"), "utf8")).toBe('{"links":["https://example.com"]}\n')

      // The model writes its result on the machine.
      writeFileSync(join(guestWork, "SUMMARY.md"), "# Summary\nexample.com\n")
      host.guest.idle("ses_guest_root")
      const harvested = await attempt(host, build, "build", "boxd_harvest", "always", {
        workId: "review-api",
        localDirectory: project,
        files: ["SUMMARY.md", "data/bookmarks.json"],
      })
      expect(harvested.output).toMatchObject({ state: "proven", files: [{ path: "SUMMARY.md" }, { path: "data/bookmarks.json" }] })
      expect(readFileSync(join(project, "SUMMARY.md"), "utf8")).toBe("# Summary\nexample.com\n")

      // Both untracked paths were harvested at the digests the machine still has, so the drop is allowed.
      const dropped = await attempt(host, build, "build", "boxd_drop", "always", { workId: "review-api" })
      expect(dropped.output).toMatchObject({ state: "dropped" })
    } finally {
      await host.close()
    }
  })

  test("an un-harvested output keeps the drop refused, and status names it", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      const project = host.location.directory
      const guestWork = join(project, "review-api")
      await attempt(host, build, "build", "boxd_ensure", "always", { workId: "review-api", directory: project })
      await attempt(host, build, "build", "boxd_submit", "always", { workId: "review-api", text: "Write extra.txt." })
      host.guest.idle("ses_guest_root")
      writeFileSync(join(guestWork, "extra.txt"), "lost if dropped\n")
      await attempt(host, build, "build", "boxd_harvest", "always", { workId: "review-api", localDirectory: project })
      const dropped = await attempt(host, build, "build", "boxd_drop", "always", { workId: "review-api" })
      expect(dropped.output).toMatchObject({ error: "UNTRACKED" })
      expect(String((dropped.output as { next?: string }).next)).toContain("Commit or delete")
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
      expect(status.works).toEqual([{ workId: "review-api", machine: "oc-review-api", sessionId: null, proof: "missing", dirty: false, machineStatus: "hibernated", warnings: [], outcome: null }])
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

describe("a run the guest's OpenCode died in", () => {
  test("the real guest helper reports the interrupted run, resume refuses, and harvest keeps it as aborted", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      const work = host.location.directory
      await attempt(host, build, "build", "boxd_ensure", "always", { workId: "review-api", directory: work })
      await attempt(host, build, "build", "boxd_submit", "always", { workId: "review-api", text: "Run a long task." })
      host.guest.interrupt("ses_guest_root")

      const job = await attempt(host, build, "build", "boxd_job", "reject", { workId: "review-api" })
      expect(job.output).toMatchObject({ state: "idle", outcome: "aborted" })

      const resumed = await attempt(host, build, "build", "boxd_resume", "always", { workId: "review-api" })
      expect(resumed.output).toMatchObject({ error: "RUN_INTERRUPTED" })
      expect(String((resumed.output as { next?: string }).next)).toContain("boxd_harvest")

      const harvested = await attempt(host, build, "build", "boxd_harvest", "always", { workId: "review-api", localDirectory: work })
      expect(harvested.output).toMatchObject({ state: "proven", outcome: "aborted" })

      expect((await attempt(host, build, "build", "boxd_submit", "always", { workId: "review-api", text: "Start again." })).output).toMatchObject({ state: "admitted" })
      host.guest.complete("ses_guest_root")
      expect((await attempt(host, build, "build", "boxd_sleep", "always", { workId: "review-api" })).output).toMatchObject({ state: "hibernated" })
    } finally {
      await host.close()
    }
  })
})

describe("a machine whose /tmp was cleared", () => {
  test("a reboot loses the guest helper, and the next call copies it again and runs once", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      await attempt(host, build, "build", "boxd_ensure", "always", { workId: "review-api", directory: host.location.directory })
      await attempt(host, build, "build", "boxd_submit", "always", { workId: "review-api", text: "Add a health check." })
      const copies = () => host.boxd.calls().filter((line) => line === "machine cp - oc-review-api:/tmp/opencode-boxd/guest.py").length
      expect(copies()).toBe(1)

      // A resize or a restart clears /tmp while this OpenCode keeps running.
      host.boxd.clearTmp()
      const before = host.boxd.calls().length
      expect((await attempt(host, build, "build", "boxd_job", "reject", { workId: "review-api" })).output).toMatchObject({ state: "busy" })
      expect(copies()).toBe(2)
      // The first call found no helper, so nothing ran; the probe, the copy and the one retry follow it.
      const after = host.boxd.calls().slice(before)
      expect(after.filter((line) => line === "machine exec oc-review-api -- ls -1a /tmp")).toHaveLength(1)

      // With the helper back, a call that answers is not probed again.
      const steady = host.boxd.calls().length
      expect((await attempt(host, build, "build", "boxd_job", "reject", { workId: "review-api" })).output).toMatchObject({ state: "busy" })
      expect(host.boxd.calls().slice(steady).some((line) => line.includes("ls -1a"))).toBe(false)
      expect(host.guest.prompts).toHaveLength(1)
    } finally {
      await host.close()
    }
  })

  test("a helper that is there and answers nothing is a crash, and is never run twice", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      await attempt(host, build, "build", "boxd_ensure", "always", { workId: "review-api", directory: host.location.directory })
      // The copy on the machine now exits without a word, as a crashed helper does.
      writeFileSync(join(dirname(host.boxd.state), "guest.py"), "import sys\nsys.exit(1)\n")
      const before = host.boxd.calls().length
      const submitted = await attempt(host, build, "build", "boxd_submit", "always", { workId: "review-api", text: "Add a health check." })
      expect(submitted.output).toMatchObject({ error: "GUEST_FAILED" })
      const after = host.boxd.calls().slice(before)
      expect(after.filter((line) => line === "machine exec oc-review-api -- python3 /tmp/opencode-boxd/guest.py")).toHaveLength(1)
      expect(after.some((line) => line.startsWith("machine cp - oc-review-api:/tmp/opencode-boxd/guest.py"))).toBe(false)
      expect(host.guest.prompts).toEqual([])
    } finally {
      await host.close()
    }
  })
})

describe("what a guest session last did", () => {
  test("boxd_job carries the session's last words, redacted, when it last changed, and the prompts that wait", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      await attempt(host, build, "build", "boxd_ensure", "always", { workId: "review-api", directory: host.location.directory })
      const first = await attempt(host, build, "build", "boxd_submit", "always", { workId: "review-api", text: "Open the pull request." })
      expect(first.output).not.toHaveProperty("queued")

      const at = Date.parse("2026-11-11T09:30:00.000Z")
      host.guest.say("ses_guest_root", `I could not push: github.com answered 401 for token=ghp_${"a".repeat(36)}. ${"More detail. ".repeat(40)}`, at)

      // A second prompt for a running session waits in its inbox, and the submit says so.
      const second = await attempt(host, build, "build", "boxd_submit", "always", { workId: "review-api", text: "Then tag it." })
      expect(second.output).toMatchObject({ state: "admitted", queued: true })
      expect(String((second.output as { next?: string }).next)).toContain("waits in its inbox")

      const busy = (await attempt(host, build, "build", "boxd_job", "reject", { workId: "review-api" })).output as Record<string, unknown>
      expect(busy).toMatchObject({ state: "busy", pending: 1, lastActivityAt: "2026-11-11T09:30:00.000Z" })
      const text = String(busy.lastText)
      expect(text).toStartWith("I could not push: github.com answered 401 for token=[redacted] More detail.")
      expect(text).not.toContain("ghp_")
      expect(Array.from(text)).toHaveLength(300)

      host.guest.complete("ses_guest_root")
      const idle = (await attempt(host, build, "build", "boxd_job", "reject", { workId: "review-api" })).output as Record<string, unknown>
      // A completed run whose last words say the task did not happen: the outcome alone would hide it.
      expect(idle).toMatchObject({ state: "idle", outcome: "completed", lastText: text })
    } finally {
      await host.close()
    }
  })

  test("a server that cannot say which sessions run still takes the prompt: queued is a report, not a gate", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      await attempt(host, build, "build", "boxd_ensure", "always", { workId: "review-api", directory: host.location.directory })
      host.guest.quirks.activeFails = true
      const submitted = await attempt(host, build, "build", "boxd_submit", "always", { workId: "review-api", text: "Open the pull request." })
      expect(submitted.output).toMatchObject({ state: "admitted" })
      expect(submitted.output).not.toHaveProperty("queued")
      expect(host.guest.prompts).toEqual([{ sessionID: "ses_guest_root", text: "Open the pull request." }])
    } finally {
      await host.close()
    }
  })

  test("a message of another kind is never reported as the assistant's last words", async () => {
    const host = await startHost()
    try {
      const build = await session(host)
      await attempt(host, build, "build", "boxd_ensure", "always", { workId: "review-api", directory: host.location.directory })
      await attempt(host, build, "build", "boxd_submit", "always", { workId: "review-api", text: "Open the pull request." })
      host.guest.complete("ses_guest_root")
      // The newest message is the user's own, and this server ignores the type filter and lists it for any kind.
      host.guest.sessions.get("ses_guest_root")?.messages.push({ type: "user", content: [{ type: "text", text: "Secret instructions from the user." }] })
      host.guest.quirks.ignoresTypeFilter = true
      const idle = (await attempt(host, build, "build", "boxd_job", "reject", { workId: "review-api" })).output as Record<string, unknown>
      expect(idle).toMatchObject({ state: "idle", outcome: "completed" })
      expect(idle).not.toHaveProperty("lastText")
    } finally {
      await host.close()
    }
  })
})
