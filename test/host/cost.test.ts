// Package E on every stock host (design §7.2, "the cost hooks on every host"): the context, compaction and idle hooks
// register and fire on the host's own request path, with a recording loopback model; system parts stay byte-identical
// across a fleet change, and the line is only on the tail of the first request after it; the compaction request carries
// the works part; the idle note is admitted once, runs in the same execution and is readable as the plugin's own; the
// session events orphan a coordinator's works; and `/boxd-cleanup` confirms each action with the host's own permission
// prompt, which a person answers and no session message carries. E's services here are the narrow fakes (the watcher's
// snapshot and C2's actions), behind the host's real session, permission, command and event domains.
import { HOST_SDK_DIR, ROOT as root } from "./isolate.js"
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Model, Plugin, Provider } from "@opencode/plugin"
import { CLEANUP_COMMAND, registerCleanupCommand } from "../../src/cleanup.js"
import { IDLE_TAG, registerCostHooks } from "../../src/hooks.js"
import { defaultRules, registerDefaultRules } from "../../src/permissions.js"
import type { Dispose } from "../../src/services.js"
import { fakes, work, type Fakes } from "../support/cost-fakes.js"
import { cleanup, until } from "./harness.js"

setDefaultTimeout(120_000)
afterAll(cleanup)

/**
 * The isolated root, as isolate.js made it: another host file's cleanup may have removed it before this file runs in
 * the same process, so it is made again, a git repository with its home and temp folders.
 */
function ensureRoot() {
  if (!existsSync(join(root, ".git"))) {
    mkdirSync(root, { recursive: true })
    Bun.spawnSync(["git", "init", "--quiet", root])
  }
  for (const dir of [process.env.HOME, process.env.TMPDIR]) if (dir) mkdirSync(dir, { recursive: true })
}

const OPENAI_COMPATIBLE = ["@opencode", "ai", "providers", "openai-compatible"].join("/")
const SDK = HOST_SDK_DIR ? join(HOST_SDK_DIR, "node_modules", "@opencode", "sdk") : fileURLToPath(new URL("../../node_modules/@opencode/sdk", import.meta.url))
const HOST_VERSION = (JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")) as { version: string }).version

type Body = { messages: Array<{ role: string; content?: unknown }>; tools?: unknown[] }
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : ""

/**
 * An OpenAI-compatible model on loopback that records every request body and answers "ok"; a user message holding
 * `[[call]]` gets one Code Mode program that calls the test's `probe_echo` tool, and the request after the tool result
 * gets "done".
 */
function recordingModel() {
  const bodies: Body[] = []
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "m1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "m1", object: "model", owned_by: "mock" }] })
      const body = (await request.json()) as Body
      bodies.push(body)
      const last = body.messages.at(-1)
      // The person's own message: the plugin's fleet line may follow it.
      const person = [...body.messages].reverse().find((message) => message.role === "user" && !textOf(message.content).startsWith("boxd: "))
      if ((body.tools ?? []).length > 0 && last?.role === "user" && textOf(person?.content).includes("[[call]]")) {
        return new Response(
          new ReadableStream({
            start(controller) {
              const send = (line: string) => controller.enqueue(new TextEncoder().encode(line))
              send(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "execute", arguments: JSON.stringify({ code: "return await tools.probe.echo({})" }) } }] }))
              send(chunk({}, "tool_calls"))
              send("data: [DONE]\n\n")
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      const value = (body.tools ?? []).length === 0 ? "Mock summary" : last?.role === "tool" ? "done" : "ok"
      return new Response(
        new ReadableStream({
          start(controller) {
            const send = (line: string) => controller.enqueue(new TextEncoder().encode(line))
            send(chunk({ role: "assistant", content: "" }))
            send(chunk({ content: value }))
            send(chunk({}, "stop"))
            send("data: [DONE]\n\n")
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, bodies, stop: () => server.stop(true) }
}

let hosts = 0

/** A host with E's hooks, command and default rules, over the fakes; the probe context is the plugin's own. */
async function startCostHost(options: Record<string, unknown>) {
  ensureRoot()
  const base = join(root, `cost-host-${++hosts}`)
  const work = join(base, "work")
  mkdirSync(work, { recursive: true })
  Bun.spawnSync(["git", "init", "--quiet", work])
  const model = recordingModel()
  const f: Fakes = fakes({ options })
  let ctxRef: Plugin.Context | undefined
  /** What the `probe_echo` tool does when the model calls it: the test changes the fleet mid tool loop with it. */
  let onTool: () => void = () => {}
  const stops: Dispose[] = []
  const plugin = Plugin.define({
    id: "boxd.host-test.cost",
    async setup(ctx) {
      const providerID = Provider.ID.make("mock")
      await ctx.provider.transform((editor) => {
        editor.add({
          info: { ...Provider.Info.empty(providerID), name: "Mock", activation: "enabled", package: OPENAI_COMPATIBLE, settings: { baseURL: model.baseURL, apiKey: "mock" } } as never,
          models: [{ ...Model.Info.default(providerID, Model.ID.make("m1")), name: "Mock 1" }],
        })
      })
      await ctx.model.transform((editor) => editor.default.set("mock", "m1"))
      await ctx.tool.transform((editor) => {
        editor.namespace({ name: "probe", description: "The cost host test's own tool" })
        editor.add({
          name: "echo",
          description: "Echoes; the test changes the fleet while it runs.",
          input: { type: "object", properties: {} },
          output: { type: "object" },
          options: { namespace: "probe", permission: "probe_echo" },
          execute: async () => {
            onTool()
            return { output: { ok: true }, content: "echoed" }
          },
        })
      })
      // The host's own session domain: the idle check reads its newest input and posts through it.
      const services = { ...f.services, sessions: ctx.session }
      await registerDefaultRules(ctx.agent, defaultRules(f.services.options.access), () => {}, f.services.options.access)
      stops.push(...(await registerCostHooks(ctx, services)))
      await registerCleanupCommand(ctx, services)
      ctxRef = ctx
    },
  })
  const config = { providers: { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } } }
  const { OpenCode } = (await import(pathToFileURL(join(SDK, "dist", "index.js")).href)) as typeof import("@opencode/sdk")
  const client = (await OpenCode.create({
    plugins: [plugin],
    app: { version: HOST_VERSION },
    config: { content: JSON.stringify(config), directory: join(base, "config"), project: false, claude: false },
    database: { path: join(base, "opencode.db") },
    models: { fetch: false },
    fs: { filewatcher: false },
    log: { level: "error" },
  })) as any
  const location = { directory: work }
  await until("the cost plugin is active", async () => {
    const { data } = await client.plugin.list({ location })
    const state = data.find((item: { id: string }) => item.id === "boxd.host-test.cost")?.state
    if (state?.status === "failed") throw new Error(`the plugin failed: ${state.error}`)
    return state?.status === "active" && ctxRef !== undefined
  })
  return {
    client,
    f,
    model,
    location,
    ctx: () => ctxRef!,
    set onTool(value: () => void) {
      onTool = value
    },
    async session() {
      return (await client.session.create({ location, agent: "build" })).id as string
    },
    /** One prompt, waiting until the session's execution, idle hook included, has ended. */
    async prompt(sessionID: string, text: string) {
      await client.session.prompt({ sessionID, text })
      await this.settle(sessionID)
    },
    async settle(sessionID: string) {
      await ctxRef!.session.wait({ sessionID })
    },
    async close() {
      for (const stop of stops.reverse()) await stop().catch(() => {})
      await client.close()
      model.stop()
      f.dispose()
    },
  }
}

const turns = (bodies: readonly Body[]) => bodies.filter((body) => (body.tools ?? []).length > 0)
const system = (body: Body) => JSON.stringify(body.messages.filter((message) => message.role === "system"))
const lastText = (body: Body) => textOf(body.messages.at(-1)?.content)
const hasLine = (body: Body) => body.messages.some((message) => message.role === "user" && textOf(message.content).startsWith("boxd: "))

describe(`the cost hooks on @opencode/sdk ${HOST_VERSION}`, () => {
  test("the fleet line: only on the tail of the first request after a change, system byte-identical, owner only, never stored", async () => {
    const host = await startCostHost({})
    try {
      const owner = await host.session()
      const other = await host.session()
      host.f.watch.works = [work("a", { phase: "busy", idleSince: undefined, notify: owner }), work("b", { notify: owner })]

      await host.prompt(owner, "first")
      const first = turns(host.model.bodies).at(-1)!
      expect(lastText(first)).toStartWith("boxd: 2 works — 1 busy, 1 idle (1 unsaved); ~€")
      expect(first.messages.at(-1)?.role).toBe("user")
      // The person's own message is the one before it, untouched.
      expect(textOf(first.messages.at(-2)?.content)).toBe("first")

      await host.prompt(owner, "second")
      const second = turns(host.model.bodies).at(-1)!
      expect(hasLine(second)).toBe(false)
      expect(system(second)).toBe(system(first))

      host.f.watch.works = [work("a", { notify: owner }), work("b", { notify: owner })]
      await host.prompt(owner, "third")
      const third = turns(host.model.bodies).at(-1)!
      expect(lastText(third)).toStartWith("boxd: 2 works — 2 idle (2 unsaved)")
      expect(system(third)).toBe(system(first))
      // The earlier line was for that request only: it is not in this one's history.
      expect(third.messages.filter((message) => textOf(message.content).startsWith("boxd: "))).toHaveLength(1)

      await host.prompt(other, "not an owner")
      expect(hasLine(turns(host.model.bodies).at(-1)!)).toBe(false)

      const stored = (await host.ctx().session.context({ sessionID: owner })) as Array<{ text?: string }>
      expect(stored.some((message) => (message.text ?? "").startsWith("boxd: "))).toBe(false)
    } finally {
      await host.close()
    }
  })

  test("a change mid tool loop waits for the next turn: the step after the tool result carries no line", async () => {
    const host = await startCostHost({})
    try {
      const owner = await host.session()
      host.f.watch.works = [work("a", { phase: "busy", idleSince: undefined, notify: owner })]
      // The fleet changes while the tool runs, between the loop's first request and its second.
      host.onTool = () => void (host.f.watch.works = [work("a", { notify: owner }), work("b", { notify: owner })])
      const before = turns(host.model.bodies).length
      await host.prompt(owner, "[[call]] go")
      const loop = turns(host.model.bodies).slice(before)
      expect(loop).toHaveLength(2)
      expect(lastText(loop[0]!)).toStartWith("boxd: 1 works — 1 busy")
      // The host's tail on the step after a tool result is that result: the line waits, so the cached tail is reused.
      expect(loop[1]!.messages.at(-1)?.role).toBe("tool")
      expect(hasLine(loop[1]!)).toBe(false)
      expect(system(loop[1]!)).toBe(system(loop[0]!))
      await host.prompt(owner, "next turn")
      expect(lastText(turns(host.model.bodies).at(-1)!)).toStartWith("boxd: 2 works — 2 idle (2 unsaved)")
    } finally {
      await host.close()
    }
  })

  test("a compaction request carries the works part on its tail", async () => {
    const host = await startCostHost({})
    try {
      const owner = await host.session()
      host.f.watch.works = [work("a", { phase: "busy", idleSince: undefined, notify: owner }), work("b", { notify: owner })]
      await host.prompt(owner, "first")
      const before = host.model.bodies.length
      await host.client.session.compact({ sessionID: owner })
      const compaction = await until("the compaction request", async () => host.model.bodies.slice(before).find((body) => body.messages.some((message) => textOf(message.content).startsWith("Keep this list"))), 60_000)
      // The host appends its own summary instruction after the hooks ran; the works part is the message just before it,
      // after the whole history.
      const index = compaction.messages.findIndex((message) => textOf(message.content).startsWith("Keep this list"))
      expect(textOf(compaction.messages[index]!.content)).toBe("Keep this list in the summary: boxd works open: a (busy), b (idle); boxd_status lists all.")
      expect(compaction.messages[index]!.role).toBe("user")
      expect(index).toBe(compaction.messages.length - 2)
      expect(textOf(compaction.messages.at(-1)!.content)).not.toContain("boxd")
    } finally {
      await host.close()
    }
  })

  test("the idle check: one note, admitted in the same execution, tagged and readable; then silent", async () => {
    const host = await startCostHost({ access: "read-only" })
    try {
      const owner = await host.session()
      host.f.watch.works = [work("a", { notify: owner }), work("b", { notify: owner })]
      await host.prompt(owner, "first")
      const note = await until("the idle note runs", async () => turns(host.model.bodies).find((body) => lastText(body).startsWith("boxd: 2 idle works are running")), 60_000)
      expect(lastText(note)).toContain('Call boxd_sleep({ select: "idle" }) or say why not.')
      await host.settle(owner)
      const context = (await host.ctx().session.context({ sessionID: owner })) as Array<{ type: string; metadata?: Record<string, unknown> }>
      const notes = context.filter((message) => message.type === "synthetic" && message.metadata?.boxd === IDLE_TAG)
      expect(notes).toHaveLength(1)
      // A second turn of the same burning state: silent.
      await host.prompt(owner, "second")
      await host.settle(owner)
      const again = (await host.ctx().session.context({ sessionID: owner })) as Array<{ type: string; metadata?: Record<string, unknown> }>
      expect(again.filter((message) => message.type === "synthetic" && message.metadata?.boxd === IDLE_TAG)).toHaveLength(1)
      expect(turns(host.model.bodies).filter((body) => lastText(body).startsWith("boxd: 2 idle works"))).toHaveLength(1)
    } finally {
      await host.close()
    }
  })

  test("session.deleted and session.archived orphan the coordinator's works", async () => {
    const host = await startCostHost({})
    try {
      const deleted = await host.session()
      const archived = await host.session()
      await host.client.session.update({ sessionID: archived, archived: true })
      await host.client.session.remove({ sessionID: deleted })
      // Passed to the watcher's sessionGone, which marks the works orphaned.
      const gone = await until("both events arrive", async () => (host.f.watch.gone.length >= 2 ? host.f.watch.gone : undefined), 30_000)
      expect([...gone].sort((a, b) => a.why.localeCompare(b.why))).toEqual([
        { sessionID: archived, why: "archived" },
        { sessionID: deleted, why: "deleted" },
      ])
    } finally {
      await host.close()
    }
  })
})

describe(`/boxd-cleanup on @opencode/sdk ${HOST_VERSION}`, () => {
  async function scenario(access: "all" | "ask-changes", decide: (action: string, index: number) => "once" | "reject") {
    const host = await startCostHost({ access })
    const sessionID = await host.session()
    host.f.actions.matches = { boxd_sleep: ["fin"], boxd_harvest: ["fin", "un"], boxd_drop: ["sv"] }
    host.f.watch.works = [work("fin"), work("un", { phase: "asleep", saved: "none" }), work("sv", { saved: "fresh" })]
    // The command runs until the person has answered every prompt, so it is awaited only after the answers.
    const running = host.client.session.command({ sessionID, name: CLEANUP_COMMAND, text: "" })
    const asked: Array<{ action: string; resources: readonly string[] }> = []
    // The person answers each prompt as it appears.
    for (let index = 0; index < 3; index++) {
      const request = await until(`prompt ${index + 1}`, async () => (await host.client.permission.list({ sessionID })).find((item: { id: string }) => !asked.some((seen) => (seen as { id?: string }).id === item.id)), 30_000)
      asked.push({ ...request, id: request.id })
      await host.client.permission.reply({ sessionID, requestID: request.id, decision: decide(request.action, index) })
    }
    await until("the command finishes", async () => {
      const inbox = await host.client.session.inbox.list({ sessionID })
      return inbox.some((item: { type: string; payload?: { text?: string } }) => item.type === "synthetic" && (item.payload?.text ?? "").startsWith("boxd cleanup, done:"))
    }, 30_000)
    await running
    return { host, sessionID, asked }
  }

  test('"ask-changes": one prompt per action, the tool\'s own action, the ids as resources; a no skips only that action', async () => {
    const { host, sessionID, asked } = await scenario("ask-changes", (action) => (action === "boxd_sleep" ? "reject" : "once"))
    try {
      expect(asked.map((item) => [item.action, [...item.resources]])).toEqual([
        ["boxd_sleep", ["fin"]],
        ["boxd_harvest", ["fin", "un"]],
        ["boxd_drop", ["sv"]],
      ])
      const acted = host.f.actions.calls.filter((call) => call.method !== "match").map((call) => `${call.method} ${call.ids.join(",")}`)
      expect(acted).toEqual(["harvest fin,un", "drop sv"])
      // No session message carries a prompt, and the session stays usable after the no.
      const context = (await host.ctx().session.context({ sessionID })) as Array<{ text?: string }>
      for (const message of context) expect(message.text ?? "").not.toMatch(/per_[A-Za-z0-9]/)
      await host.prompt(sessionID, "still here")
      expect(turns(host.model.bodies).length).toBeGreaterThan(0)
    } finally {
      await host.close()
    }
  })

  test('"all": one boxd_cleanup prompt per action; rejecting all changes nothing', async () => {
    const { host, asked } = await scenario("all", () => "reject")
    try {
      expect(asked.map((item) => item.action)).toEqual(["boxd_cleanup", "boxd_cleanup", "boxd_cleanup"])
      expect(host.f.actions.calls.filter((call) => call.method !== "match")).toEqual([])
    } finally {
      await host.close()
    }
  })
})
