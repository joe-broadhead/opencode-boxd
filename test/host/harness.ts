// An embedded OpenCode host from the public @opencode/sdk, isolated in the temp root from ./isolate.js. The boxd plugin
// is built with its internal seam: the fake boxd CLI, the fake guest server behind it, and a ledger in the temp root. A probe plugin, loaded after it, lends its context to the tests.
import { HOST_SDK_DIR, ROOT as root } from "./isolate.js"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { OpenCodeClient } from "@opencode/client"
import { Model, Plugin, Provider } from "@opencode/plugin"
import { createBoxdPlugin } from "../../src/index.js"
import { startFakeCli, type FakeCli, type FakeMachine } from "./fake-cli.js"
import { startFakeGuest, type FakeGuest } from "./fake-guest.js"
import { startMockModel } from "./mock.js"

// The package the host loads to talk to an OpenAI-compatible endpoint. It is a value the host resolves, not an import:
// nothing here imports @opencode/ai, which the repository forbids because it breaks between patch releases.
const OPENAI_COMPATIBLE = ["@opencode", "ai", "providers", "openai-compatible"].join("/")

export type Rule = { action: string; resource: string; effect: "allow" | "ask" | "deny" }

/** The SDK's `Interface`, which its own declarations resolve to `any`. */
type Client = Omit<OpenCodeClient, "plugin"> & {
  readonly sessions: OpenCodeClient["session"]
  readonly plugin: ((plugin: Plugin.Plugin) => Promise<void>) & OpenCodeClient["plugin"]
  readonly close: () => Promise<void>
}

const SDK = HOST_SDK_DIR ? join(HOST_SDK_DIR, "node_modules", "@opencode", "sdk") : fileURLToPath(new URL("../../node_modules/@opencode/sdk", import.meta.url))
export const HOST_VERSION = (JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")) as { version: string }).version

/** Removes the temp root; call once after every host in the file has closed. */
export const cleanup = () => rmSync(root, { recursive: true, force: true })

export interface FakeBoxd {
  readonly bin: string
  readonly state: string
  /** The fake CLI behind it: seed machines, snapshots, limits and faults, and read the spawns. */
  readonly fake: FakeCli
  /** Every command the plugin ran but `--help`, in order. */
  calls(): string[]
  machines(): FakeMachine[]
  /** Puts a machine in a region before the plugin is asked anything. */
  seed(name: string, machine: Partial<FakeMachine> & { status: string }): FakeMachine
}

/** The fake CLI in the temp root, on the PATH, with the fake guest server as every machine's OpenCode. */
export function startFakeBoxd(guest: FakeGuest, version = HOST_VERSION): FakeBoxd {
  const dir = join(root, "fake-boxd")
  mkdirSync(dir, { recursive: true })
  const fake = startFakeCli({ dir, version, guestPort: guest.port })
  // Every golden image this laptop's OpenCode would pick, in both regions, so a create needs no build.
  for (const region of ["fra", "nyc"] as const) for (const size of ["1x4", "2x8", "4x16", "8x32"]) fake.snapshot({ region, name: `oc-golden-${version}-${size}`, vcpu: Number(size.split("x")[0]) })
  process.env.PATH = `${dir}:${process.env.PATH ?? ""}`
  return {
    bin: fake.bin,
    state: fake.statePath,
    fake,
    calls: () => fake.calls(),
    machines: () => fake.read().machines,
    seed: (name, machine) => fake.machine({ ...machine, name }),
  }
}

export interface HostInput {
  /** Plugin options, as a user writes them in opencode.json. */
  readonly options?: Record<string, unknown>
  /** Extra user config: permissions, agents. */
  readonly config?: Record<string, unknown>
  /** A guest version other than the host's, for the mismatch test. */
  readonly guestVersion?: string
  /** Extra plugins to load beside the boxd plugin, such as the completion tool the guest helper writes. */
  readonly plugins?: readonly Plugin.Plugin[]
  /** A loopback model, so a Code Mode program can be driven by a turn. */
  readonly model?: boolean
  /** Wraps the context the boxd plugin gets, so a test can watch what it registers. */
  readonly wrap?: (ctx: Plugin.Context) => Plugin.Context
}

/** A git repository inside the temp root: the guest's work directory and the path a harvest imports into. */
export function workDirectory(name: string): string {
  const dir = join(root, "work", name)
  mkdirSync(dir, { recursive: true })
  if (!existsSync(join(dir, ".git"))) {
    Bun.spawnSync(["git", "init", "--quiet", dir])
    writeFileSync(join(dir, "README.md"), `# ${name}\n`)
    // Committed, so the guest's `git status` reports a clean tree and a drop is allowed after a harvest.
    Bun.spawnSync(["git", "-C", dir, "add", "."])
    Bun.spawnSync(["git", "-C", dir, "-c", "user.name=boxd test", "-c", "user.email=boxd@example.invalid", "commit", "--quiet", "-m", "init"])
  }
  return dir
}

let hosts = 0

export async function startHost(input: HostInput = {}) {
  const base = join(root, `host-${++hosts}`)
  mkdirSync(base, { recursive: true })
  const guest = startFakeGuest()
  const work = workDirectory(`host-${hosts}`)
  const boxd = startFakeBoxd(guest, input.guestVersion ?? HOST_VERSION)
  const model = input.model ? startMockModel() : undefined
  const plugin = createBoxdPlugin({ boxdBin: boxd.bin, ledger: join(base, "ledger") })
  const withOptions = Plugin.define({ id: plugin.id, setup: (ctx) => plugin.setup({ ...(input.wrap ? input.wrap(ctx) : ctx), options: input.options ?? {} }) })
  const probes = new Map<string, Plugin.Context>()
  const probe = Plugin.define({
    id: "boxd.host-test.probe",
    async setup(ctx) {
      if (model !== undefined) {
        const providerID = Provider.ID.make("mock")
        await ctx.provider.transform((editor) => {
          editor.add({
            // An invented credential for the mock provider, never a real key.
            info: { ...Provider.Info.empty(providerID), name: "Mock", activation: "enabled", package: OPENAI_COMPATIBLE, settings: { baseURL: model.baseURL, apiKey: ["mock", "key"].join("-") } } as never,
            models: [{ ...Model.Info.default(providerID, Model.ID.make("m1")), name: "Mock 1" }],
          })
        })
        await ctx.model.transform((editor) => editor.default.set("mock", "m1"))
      }
      probes.set(ctx.location.directory, ctx)
    },
  })
  const config = {
    // Keep the built-in local providers from probing their default ports.
    providers: { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } },
    ...input.config,
  }
  const { OpenCode } = (await import(pathToFileURL(join(SDK, "dist", "index.js")).href)) as typeof import("@opencode/sdk")
  const client: Client = await OpenCode.create({
    plugins: [withOptions, probe, ...(input.plugins ?? [])],
    // An embedded host reports "unknown" unless told, and the plugin's host guard refuses that.
    app: { version: HOST_VERSION },
    config: { content: JSON.stringify(config), directory: join(base, "config"), project: false, claude: false },
    database: { path: join(base, "opencode.db") },
    models: { fetch: false },
    fs: { filewatcher: false },
    log: { level: "error" },
  })
  const location = { directory: work }
  const host = {
    client,
    location,
    /** The plugin's ledger root, for a test that seeds or reads records. */
    ledger: join(base, "ledger"),
    guest,
    boxd,
    model,
    probe: () => {
      const ctx = probes.get(location.directory)
      if (!ctx) throw new Error("the probe plugin has not loaded")
      return ctx
    },
    async close() {
      await client.close()
      await guest.close()
      model?.stop()
    },
  }
  try {
    await until("the boxd plugin is active", async () => {
      const { data } = await client.plugin.list({ location })
      const state = data.find((item) => item.id === plugin.id)?.state
      if (state?.status === "failed") throw new Error(`the boxd plugin failed: ${state.error}`)
      return state?.status === "active" && probes.has(location.directory)
    })
  } catch (error) {
    await host.close().catch(() => {})
    throw error
  }
  return host
}

export type Host = Awaited<ReturnType<typeof startHost>>

/** Polls `check` until it returns a value. The default leaves room for a busy machine, inside the 120 s test limit. */
export async function until<T>(what: string, check: () => Promise<T | false | undefined>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`)
    await Bun.sleep(50)
  }
}

export const session = async (host: Host, agent = "build", permissions?: readonly Rule[]) =>
  (await host.client.sessions.create({ agent, ...(permissions ? { permissions } : {}), location: host.location })).id

let calls = 0

/**
 * Runs one boxd tool through the host's own executor. A prompt, if one appears, is answered with `decision`. Reports
 * whether it asked, and how the call ended, with its output when it ran.
 */
export async function attempt(host: Host, sessionID: string, agent: string, tool: string, decision: "once" | "always" | "reject" = "reject", input: Record<string, unknown> = {}) {
  const executor = await until(`${tool} is registered`, async () => (await host.probe().tool.list()).find((item) => item.id === tool))
  const context = { sessionID, agent, messageID: "msg_host_test", id: `call_host_test_${++calls}`, signal: new AbortController().signal, progress: async () => {} }
  let settled = false
  const run = executor
    .execute(input, context as never)
    .then(
      (result: unknown) => ({ ok: true as const, result: result as { output?: unknown; content?: string } }),
      (error: unknown) => ({ ok: false as const, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }),
    )
    .finally(() => { settled = true })
  let asked: string | undefined
  while (!settled) {
    const pending = await host.client.permission.list({ sessionID })
    const action = tool.replace("_", ".")
    const request = pending.find((item) => item.action === action || item.action === tool)
    if (request) {
      asked = request.action
      await host.client.permission.reply({ sessionID, requestID: request.id, decision })
      break
    }
    await Promise.race([run, Bun.sleep(25)])
  }
  const outcome = await run
  return {
    asked,
    ok: outcome.ok,
    output: outcome.ok ? ((outcome.result.output ?? outcome.result.content) as Record<string, unknown> | undefined) : undefined,
    content: outcome.ok ? outcome.result.content : undefined,
    error: outcome.ok ? undefined : outcome.error,
  }
}

export const agentRules = async (host: Host) =>
  new Map((await host.client.agent.list({ location: host.location })).data.map((agent) => [agent.id as string, agent.permissions as Rule[]]))

/** The host's own last-match evaluation for an action (resource `*`), via its permission API. */
export async function effect(host: Host, agent: string, action: string) {
  const sessionID = await session(host, agent)
  return (await host.client.permission.create({ sessionID, agent, action, resources: ["*"] })).effect
}

/** The plugin's status through its one RPC id, as a script reads it. */
export async function statusThroughRpc(host: Host, sessionID: string) {
  const rpc = host.client.rpc as unknown as { call: (request: object, options?: object) => Promise<{ output: Record<string, unknown> }> }
  const answer = await rpc.call({ rpcID: "boxd", method: "status", input: { sessionID, input: {} }, location: host.location })
  return answer.output
}
