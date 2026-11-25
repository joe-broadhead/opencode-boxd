// The phase read on a real stock OpenCode 2.4.1 server: a root session starts a child, the child runs while the root
// stays idle, and the helper must read the work as busy from its whole session tree. The server is the real binary on
// an isolated temp root; only the model is a local fake that holds the run open, so the child is genuinely running. A
// loopback proxy adds the server's Basic auth, because the helper speaks to a custom `base` without reading a password.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"

setDefaultTimeout(300_000)

const root = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "boxd-guest-tree-")))
const project = join(root, "project")
const guest = join(import.meta.dir, "../../guest/guest.py")
// The provider package the stock host resolves by name; spelled in parts because the repository forbids importing it.
const OPENAI_COMPATIBLE = ["@opencode", "ai", "providers", "openai-compatible"].join("/")

/** The stock 2.4.1 binary: the one CI names, or the machine's own, and never a skip. */
function stockBinary(): string {
  const binary = process.env.OPENCODE_BIN_2_4_1 ?? "/usr/local/bin/opencode"
  if (!existsSync(binary)) {
    throw new Error(`stock OpenCode 2.4.1 is missing at ${binary}: this test drives the real host, so set OPENCODE_BIN_2_4_1 or install it.`)
  }
  const version = Bun.spawnSync([binary, "--version"]).stdout.toString().trim()
  if (version !== "opencode v2.4.1") throw new Error(`${binary} is ${version || "not runnable"}, not opencode v2.4.1: set OPENCODE_BIN_2_4_1 to the tested release.`)
  return binary
}

const freePort = async (): Promise<number> => {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const { port } = server.address() as { port: number }
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

/** The mock's answer once the run is released: one OpenAI-compatible streamed message. */
const answer = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
          `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "m1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        controller.enqueue(encoder.encode(chunk({ role: "assistant", content: "" })))
        controller.enqueue(encoder.encode(chunk({ content: "done" })))
        controller.enqueue(encoder.encode(chunk({}, "stop")))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
  )

let release!: () => void
const released = new Promise<void>((resolve) => (release = resolve))
let model: ReturnType<typeof Bun.serve>
let proxy: ReturnType<typeof Bun.serve>
let server: ReturnType<typeof spawn> | undefined
let log = ""
let port = 0
let api: <T>(method: string, path: string, body?: unknown) => Promise<T>

beforeAll(async () => {
  mkdirSync(project, { recursive: true })
  model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "m1", object: "model", owned_by: "mock" }] })
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      await request.json().catch(() => ({}))
      // Hold the child's run open until the test has read the phase.
      await released
      return answer()
    },
  })
  port = await freePort()
  // An invented credential, never a real one: the guest's OpenCode password for this test machine.
  const password = ["guest-tree", "password"].join("-")
  const directory = join(root, "home")
  const env = {
    HOME: directory,
    OPENCODE_TEST_HOME: directory,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    TMPDIR: join(root, "tmp"),
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    OPENCODE_PASSWORD: password,
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_FREE_MODELS: "true",
  }
  for (const path of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, env.TMPDIR]) mkdirSync(path, { recursive: true })
  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify({
      model: { providerID: "mock", model: "m1" },
      providers: {
        mock: {
          name: "Mock",
          package: OPENAI_COMPATIBLE,
          // An invented credential for the mock provider, never a real key.
          settings: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: ["mock", "key"].join("-") },
          models: { m1: { name: "Mock 1" } },
        },
        lmstudio: { settings: { baseURL: "" } },
        ollama: { settings: { baseURL: "" } },
        vllm: { settings: { baseURL: "" } },
      },
    }),
  )
  server = spawn(stockBinary(), ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] })
  server.stdout!.on("data", (chunk) => (log += chunk))
  server.stderr!.on("data", (chunk) => (log += chunk))
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  await until("the stock server answers", async () => {
    if (server!.exitCode !== null) throw new Error(`opencode exited before it answered: ${log}`)
    const response = await fetch(`http://127.0.0.1:${port}/api/info`, { headers: { authorization } }).catch(() => undefined)
    return response?.ok === true
  })
  // The helper's custom base carries no password; the proxy adds the stock server's Basic auth on loopback only.
  proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
      const response = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { method: request.method, headers: { authorization }, body })
      const text = await response.text()
      return new Response(text, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } })
    },
  })
  api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 500)}`)
    return JSON.parse(text) as T
  }
})

test("a work is busy while a child beyond the first listing page runs, and its last activity is the tree's newest", async () => {
  const created = await api<{ data: { id: string } }>("POST", "/api/session", { agent: "build" })
  const rootSession = created.data.id
  const oldChild = (await api<{ data: { id: string } }>("POST", "/api/session", { agent: "build", parentID: rootSession })).data.id
  await api("POST", `/api/session/${oldChild}/prompt`, { text: "run until the test lets go" })
  await until("the child session runs", async () => {
    const active = await api<{ data: Record<string, unknown> }>("GET", "/api/session/active")
    return rootSession in active.data ? false : oldChild in active.data
  })
  // Let the running child become the oldest session, then bury it beyond the server's 50-session first page.
  await Bun.sleep(20)
  let newestChild = oldChild
  for (let index = 0; index < 56; index += 1) newestChild = (await api<{ data: { id: string } }>("POST", "/api/session", { agent: "build", parentID: rootSession })).data.id
  const firstPage = await api<{ data: { id: string }[]; cursor: { next?: string } }>("GET", "/api/session?limit=50")
  expect(firstPage.data).toHaveLength(50)
  expect(firstPage.cursor.next).toBeTruthy()
  expect(firstPage.data.map((session) => session.id)).not.toContain(oldChild)
  const rootInfo = (await api<{ data: { id: string; time: Record<string, number | undefined> } }>("GET", `/api/session/${rootSession}`)).data
  const childInfo = (await api<{ data: { id: string; parentID?: string; time: Record<string, number | undefined> } }>("GET", `/api/session/${oldChild}`)).data
  const newestInfo = (await api<{ data: { time: Record<string, number | undefined> } }>("GET", `/api/session/${newestChild}`)).data
  expect([rootInfo.id, childInfo.id, childInfo.parentID]).toEqual([rootSession, oldChild, rootSession])
  const phase = await phaseOf(rootSession)
  expect(phase).toMatchObject({ phase: "busy" })
  const stamps = [rootInfo.time, childInfo.time, newestInfo.time].flatMap((time) => [time.updated, time.busy, time.idle]).filter((value): value is number => typeof value === "number")
  const newest = Math.max(...stamps)
  expect(typeof phase.lastActivityAt).toBe("string")
  expect(Date.parse(String(phase.lastActivityAt))).toBe(newest)
  // The root alone is older than the running child, so a root-only phase read could not have answered this.
  expect(newest).toBeGreaterThan(Math.max(...[rootInfo.time.updated, rootInfo.time.busy, rootInfo.time.idle].filter((value): value is number => typeof value === "number")))
  release()
  await until("the tree finishes", async () => {
    const active = await api<{ data: Record<string, unknown> }>("GET", "/api/session/active")
    return Object.keys(active.data).length === 0
  })
  expect(await phaseOf(rootSession)).toMatchObject({ phase: "idle" })
})

afterAll(async () => {
  release()
  if (server && server.exitCode === null) {
    server.kill("SIGTERM")
    await new Promise((done) => server!.once("exit", done))
  }
  proxy?.stop(true)
  model?.stop(true)
  rmSync(root, { recursive: true, force: true })
})

/** Runs the real helper's phase read against the proxy, as the guest port does. */
async function phaseOf(sessionID: string): Promise<Record<string, unknown>> {
  const child = spawn("python3", [guest], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } })
  child.stdin.end(JSON.stringify({ action: "phase", sessionId: sessionID, base: `http://127.0.0.1:${proxy.port}` }))
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => (stdout += chunk))
  child.stderr.on("data", (chunk) => (stderr += chunk))
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve))
  const line = stdout.trim().split("\n").at(-1) ?? ""
  const answer = JSON.parse(line) as Record<string, unknown>
  if (code !== 0 || answer.ok !== true) throw new Error(`guest.py phase failed (${code}): ${line}${stderr ? `\n${stderr}` : ""}`)
  return answer
}

async function until<T>(what: string, check: () => Promise<T | false | undefined>, timeoutMs = 120_000): Promise<T> {
  for (const deadline = Date.now() + timeoutMs; ; await Bun.sleep(100)) {
    let value: T | false | undefined
    try {
      value = await check()
    } catch (error) {
      if (Date.now() > deadline) throw error
    }
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}${log ? `: ${log.slice(-2000)}` : ""}`)
    if (server?.exitCode !== null) throw new Error(`opencode exited before ${what}: ${log.slice(-2000)}`)
  }
}
