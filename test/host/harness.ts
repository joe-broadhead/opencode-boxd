// An embedded OpenCode host from the public @opencode/sdk, isolated in the temp root from ./isolate.js. The boxd plugin
// is built with its internal seam: the fake boxd CLI, the fake guest server behind it, a fake prover and a ledger in
// the temp root. A probe plugin, loaded after it, lends its context to the tests.
import { HOST_SDK_DIR, ROOT as root } from "./isolate.js"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { OpenCodeClient } from "@opencode/client"
import { Plugin } from "@opencode/plugin"
import { createBoxdPlugin } from "../../src/plugin.js"
import { startFakeGuest, type FakeGuest } from "./fake-guest.js"

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

const GOLDEN = [{ name: "opencode-golden", storage: "local", status: "ready" }]

export interface FakeBoxd {
  readonly bin: string
  readonly state: string
  /** Every command the plugin ran, in order. */
  calls(): string[]
  machines(): Record<string, { name: string; status: string; sharing: string; isolated: boolean }>
  /** Puts a machine in a state before the plugin is asked anything. */
  seed(name: string, machine: { status: string; sharing?: string; isolated?: boolean }): void
  /** The account's snapshots; `opencode-golden` is there unless a test removes it. */
  snapshots(): Array<{ name: string; storage: string; status: string }>
  setSnapshots(names: readonly string[]): void
}

/** The fake CLI, its state file and a shell shim, all in the temp root. */
export function startFakeBoxd(guest: FakeGuest, version = HOST_VERSION): FakeBoxd {
  const dir = join(root, "fake-boxd")
  mkdirSync(dir, { recursive: true })
  const state = join(dir, "state.json")
  const script = fileURLToPath(new URL("./fake-boxd.mjs", import.meta.url))
  const guestPy = fileURLToPath(new URL("../../guest/guest.py", import.meta.url))
  const bin = join(dir, "boxd")
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`)
  chmodSync(bin, 0o755)
  const write = (machines: Record<string, unknown>, snapshots = GOLDEN) =>
    writeFileSync(state, JSON.stringify({ machines, snapshots, log: [], version, port: guest.port }))
  write({})
  const read = () =>
    JSON.parse(readFileSync(state, "utf8")) as {
      machines: Record<string, { name: string; status: string; sharing: string; isolated: boolean }>
      snapshots: Array<{ name: string; storage: string; status: string }>
      log: string[]
    }
  const previousPath = process.env.PATH
  process.env.PATH = `${dir}:${previousPath ?? ""}`
  process.env.BOXD_FAKE_STATE = state
  process.env.BOXD_FAKE_GUEST_PY = guestPy
  return {
    bin,
    state,
    calls: () => read().log,
    machines: () => read().machines,
    seed: (name, machine) => {
      const current = read()
      current.machines[name] = { name, status: machine.status, sharing: machine.sharing ?? "private", isolated: machine.isolated ?? false }
      write(current.machines, current.snapshots)
    },
    snapshots: () => read().snapshots,
    setSnapshots: (names) => {
      const current = read()
      write(current.machines, names.map((name) => ({ name, storage: "local", status: "ready" })))
    },
  }
}

/** Records every import the plugin proves, so a test sees the order and the parent mapping without a real OpenCode. */
export function fakeProver() {
  const calls: Array<{ remoteId: string; parentID?: string; directory: string }> = []
  return {
    calls,
    prover: {
      importTransfer: async (transfer: { info: { id: string; parentID?: string } }, directory: string) => {
        calls.push({ remoteId: transfer.info.id, ...(transfer.info.parentID ? { parentID: transfer.info.parentID } : {}), directory })
        // The laptop keeps the transcript's id, as `opencode session import` does on every tested release.
        return { id: transfer.info.id }
      },
    },
  }
}

export interface HostInput {
  /** Plugin options, as a user writes them in opencode.json. */
  readonly options?: Record<string, unknown>
  /** Extra user config: permissions, agents. */
  readonly config?: Record<string, unknown>
  /** A guest version other than the host's, for the mismatch test. */
  readonly guestVersion?: string
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
  const boxd = startFakeBoxd(guest, input.guestVersion ?? HOST_VERSION)
  const prover = fakeProver()
  const plugin = createBoxdPlugin({ boxdBin: boxd.bin, ledger: join(base, "ledger"), prover: prover.prover })
  const withOptions = Plugin.define({ id: plugin.id, setup: (ctx) => plugin.setup({ ...ctx, options: input.options ?? {} }) })
  const probes = new Map<string, Plugin.Context>()
  const probe = Plugin.define({ id: "boxd.host-test.probe", setup: (ctx) => void probes.set(ctx.location.directory, ctx) })
  const config = {
    // Keep the built-in local providers from probing their default ports.
    providers: { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } },
    ...input.config,
  }
  const { OpenCode } = (await import(pathToFileURL(join(SDK, "dist", "index.js")).href)) as typeof import("@opencode/sdk")
  const client: Client = await OpenCode.create({
    plugins: [withOptions, probe],
    // An embedded host reports "unknown" unless told, and the plugin's host guard refuses that.
    app: { version: HOST_VERSION },
    config: { content: JSON.stringify(config), directory: join(base, "config"), project: false, claude: false },
    database: { path: join(base, "opencode.db") },
    models: { fetch: false },
    fs: { filewatcher: false },
    log: { level: "error" },
  })
  const location = { directory: workDirectory(`host-${hosts}`) }
  const host = {
    client,
    location,
    guest,
    boxd,
    imports: prover.calls,
    probe: () => {
      const ctx = probes.get(location.directory)
      if (!ctx) throw new Error("the probe plugin has not loaded")
      return ctx
    },
    async close() {
      await client.close()
      await guest.close()
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
    .finally(() => void (settled = true))
  let asked: string | undefined
  while (!settled) {
    const pending = await host.client.permission.list({ sessionID })
    const request = pending.find((item) => item.action === tool)
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

/** The status RPC's output, as the dialog and a script read it. */
export async function statusThroughRpc(host: Host) {
  const rpc = host.client.rpc as unknown as (definition: object) => { status: (input: object, options: object) => Promise<Record<string, unknown>> }
  const { StatusRpc } = await import("../../src/status.js")
  return rpc(StatusRpc).status({}, { location: host.location })
}
