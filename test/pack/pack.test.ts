// Pack, install and load the published shape: the tarball holds exactly the files whitelist, installs with lifecycle
// scripts disabled, and the server entry loads. Then, on each stock OpenCode release, the installed plugin is started by
// the real binary: its status RPC answers the contract's shape, its access rules are installed on the build agent, and
// its skill is listed. No boxd machine is ever started.
import { afterAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { arch, platform } from "node:os"
import { basename, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { SUPPORTED_HOST, TESTED_HOSTS } from "../../src/constants.js"

const root = fileURLToPath(new URL("../..", import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string
  version: string
  files: string[]
  exports: Record<string, string>
  devDependencies: Record<string, string>
  capabilities: { plugin: { name: string }; methods: Record<string, { class: string }> }
}
const METHODS = Object.keys(pkg.capabilities.methods)
// Outside the repository, so nothing resolves from the repository's own node_modules.
const work = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "boxd-pack-")))
run("git", ["init", "--quiet", work], root)
afterAll(() => rmSync(work, { recursive: true, force: true }), { timeout: 120_000 })

const MAX_FILES = 60
const MAX_PACKED_BYTES = 900 * 1024
const DIST = ["dist/index.js"]
const SERVER_HOST_MODULES = [/^node:/, /^@opencode\/plugin(?:\/|$)/]
const BUILT_IN_AGENTS = ["build", "general", "explore", "compaction", "title", "summary", "plan"]
const OFFLINE = {
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
  http_proxy: "http://127.0.0.1:9",
  https_proxy: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  OPENCODE_DISABLE_FREE_MODELS: "true",
}

type Packed = { filename: string; size: number; entryCount: number; files: { path: string }[] }
let packed: Packed | undefined

function pack(): Packed {
  if (packed) return packed
  const given = process.env.PACK_TARBALL
  if (given) {
    const tarball = resolve(given)
    copyFileSync(tarball, join(work, basename(tarball)))
    const files = run("tar", ["-tzf", tarball], root)
      .trim()
      .split("\n")
      .filter((path) => !path.endsWith("/"))
      .map((path) => ({ path: path.replace(/^package\//, "") }))
    packed = { filename: basename(tarball), size: statSync(tarball).size, entryCount: files.length, files }
    return packed
  }
  run("node", [join(root, "scripts", "check.mjs"), "build"], root)
  const result = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", work], root)
  packed = (JSON.parse(result) as Packed[])[0]!
  return packed
}

function project(name: string): string {
  const dir = join(work, name)
  mkdirSync(dir)
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `boxd-pack-${name}`, private: true, type: "module" }))
  return dir
}

const installs = new Map<string, string>()
function install(): string {
  const existing = installs.get("alone")
  if (existing) return existing
  const dir = project("alone")
  run("npm", ["install", join(work, pack().filename), `@opencode/plugin@${pkg.devDependencies["@opencode/plugin"]}`, "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], dir)
  installs.set("alone", dir)
  return dir
}

const installedPackage = () => join(install(), "node_modules", ...pkg.name.split("/"))

function isolated(base: string) {
  const home = join(base, "home")
  const env = {
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    TMPDIR: join(base, "tmp"),
  }
  for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true })
  return env
}

describe("package tarball", () => {
  test("lists exactly the files whitelist, under the size and file limits", () => {
    const { files, entryCount, size } = pack()
    const paths = files.map((file) => file.path).sort()
    const expected = ["package.json", ...pkg.files.flatMap(whitelisted)].sort()
    expect(paths).toEqual(expected)
    expect(entryCount).toBeLessThan(MAX_FILES)
    if (size > MAX_PACKED_BYTES) throw new Error(`The packed tarball is ${size} bytes, over the ${MAX_PACKED_BYTES}-byte budget.`)
    expect(paths.filter((path) => path.includes("node_modules/") || /\.(?:tsx|jsx)$/.test(path))).toEqual([])
    for (const target of Object.values(pkg.exports)) expect(paths).toContain(target.replace(/^\.\//, ""))
    expect(paths.filter((path) => path.endsWith(".d.ts"))).toEqual([])
    // The guest helper, the fixture and the skill are the product, so they must be in every tarball.
    expect(paths).toContain("guest/guest.py")
    expect(paths).toContain("fixtures/conformance.json")
    expect(paths).toContain("skills/boxd-sessions/SKILL.md")
  }, 120_000)

  test("ships the NOTICE for the bundled plugin contract", () => {
    const notice = run("tar", ["-xzOf", join(work, pack().filename), "package/NOTICE"], root)
    expect(notice).toContain("@we-the-rebel-alliance/plugin-contract")
    expect(notice).toContain("Copyright (c) 2026 Joe Broadhead")
    expect(notice).toContain("MIT License")
  })

  test("installs with scripts disabled and the server entry loads under Bun", () => {
    const consumer = install()
    const probe = join(consumer, "probe.mjs")
    writeFileSync(
      probe,
      ["const plugin = (await import(" + JSON.stringify(`${pkg.name}/server`) + ")).default", "console.log(JSON.stringify({ id: plugin?.id, setup: typeof plugin?.setup }))"].join("\n"),
    )
    const output = run(process.execPath, [probe], consumer, { PATH: process.env.PATH, ...isolated(join(work, "bun-probe")) })
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({ id: "boxd", setup: "function" })
  }, 300_000)

  test("dist holds only the one entry bundle, and it imports no sibling module", () => {
    const dist = join(installedPackage(), "dist")
    expect(tree(relative(root, dist), dist).sort()).toEqual(DIST.map((path) => basename(path)))
    for (const file of DIST) expect(relativeImports(readFileSync(join(dist, basename(file)), "utf8"))).toEqual([])
  }, 300_000)

  test("dist imports only modules the host provides", () => {
    const file = join(installedPackage(), "dist", "index.js")
    // The scan finds the bundle's real imports, so an empty foreign list means something.
    expect(specifiers(readFileSync(file, "utf8"))).toContain("@opencode/plugin")
    expect(foreign(file, SERVER_HOST_MODULES)).toEqual([])
  }, 300_000)
})

describe.each(TESTED_HOSTS)("installed alone, in stock OpenCode %s", (version) => {
  test("is active, answers the contract's status RPC, installs its access rules and lists its skill", async () => {
    const installed = installedPackage()
    const host = await serve(version, installed)
    try {
      const plugin = await host.until("the plugin finishes loading", async () => {
        const { data } = await host.api<{ data: { id: string; state: { status: string; error?: string } }[] }>("GET", "/api/plugin")
        const found = data.find((item) => item.id === "boxd")
        if (found?.state.status === "failed") throw new Error(`the plugin failed: ${found.state.error}`)
        return found && found.state.status !== "loading" ? found : undefined
      })
      expect(plugin.state).toEqual({ status: "active" })

      const { data: created } = await host.api<{ data: { id: string } }>("POST", "/api/session", { agent: "build" })
      const { output } = await host.api<{ output: Record<string, unknown> }>("POST", "/api/rpc/boxd/status", { input: { sessionID: created.id, input: {} } })
      expect(Object.keys(output).sort()).toEqual(["accounts", "host", "name", "nextStep", "state", "unguardedAgents", "version"])
      expect(output).toMatchObject({ name: "boxd", version: pkg.version, host: { version, range: SUPPORTED_HOST, tested: [version] } })
      expect(["ready", "needs_sign_in", "error"]).toContain(String(output["state"]))
      expect(output["nextStep"] === null || typeof output["nextStep"] === "string").toBe(true)
      expect(output["accounts"]).toEqual([{ alias: "default", state: expect.stringMatching(/^(ready|needs_sign_in|error)$/), owner: expect.objectContaining({ id: expect.stringMatching(/^os-user:/) }) }])

      // Every method has its generated rule on the build agent, after its base allow.
      const build = await host.until("the build agent has the generated rules", async () => {
        const { data } = await host.api<{ data: { id: string; permissions: { action: string; resource: string; effect: string }[] }[] }>("GET", "/api/agent")
        const permissions = data.find((agent) => agent.id === "build")?.permissions
        return permissions?.find((rule) => rule.action === "boxd.status")
      })
      expect(build).toMatchObject({ resource: "*", effect: "allow" })
      expect(METHODS).toContain("status")

      const { data: agents } = await host.api<{ data: { id: string }[] }>("GET", "/api/agent")
      expect(agents.map((agent) => agent.id).filter((id) => !BUILT_IN_AGENTS.includes(id))).toEqual([])
      const { data: skills } = await host.api<{ data: { id: string; path: string }[] }>("GET", "/api/skill")
      expect(skills.filter((skill) => skill.id === "boxd-sessions").map((skill) => skill.path)).toEqual([join(installed, "skills", "boxd-sessions", "SKILL.md")])
    } catch (error) {
      throw new Error(`${(error as Error).message}\n--- opencode ${version} log ---\n${host.log().slice(-3000)}`)
    } finally {
      await host.close()
    }
  }, 600_000)
})

const installed = new Map<string, string>()
function stockBinary(version: string): string {
  const given = process.env[`OPENCODE_BIN_${version.replaceAll(".", "_")}`]
  if (given) return given
  const cached = installed.get(version)
  if (cached) return cached
  const binary = `@opencode/cli-${platform()}-${arch()}`
  const dir = project(`opencode-${version}`)
  run("npm", ["install", `@opencode/cli@${version}`, `${binary}@${version}`, "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], dir)
  const path = join(dir, "node_modules", binary, "bin", "opencode")
  installed.set(version, path)
  return path
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const { port } = server.address() as { port: number }
  await new Promise((done) => server.close(done))
  return port
}

/** `opencode serve` on its own port and password, in an environment that holds only its temp root and is offline. */
async function serve(version: string, installedDir: string) {
  const binary = stockBinary(version)
  const base = join(work, `stock-${version}`)
  const directory = join(base, "project")
  const providers = { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } }
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "opencode.json"), JSON.stringify({ plugins: [installedDir], providers }))
  const password = randomUUID()
  const env = { ...isolated(base), ...OFFLINE, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", OPENCODE_PASSWORD: password }

  expect(run(binary, ["--version"], directory, env).trim()).toBe(`opencode v${version}`)
  const paths = run(binary, ["debug", "paths"], directory, env)
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
  expect(paths.length).toBeGreaterThan(5)
  expect(paths.filter(([, path]) => !path?.startsWith(base + sep))).toEqual([])

  const port = await freePort()
  let log = ""
  const server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] })
  server.stdout.on("data", (chunk) => void (log += chunk))
  server.stderr.on("data", (chunk) => void (log += chunk))
  const exited = new Promise((done) => server.once("exit", done))

  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const request = async (method: string, path: string, body?: unknown, location = directory) => {
    const url = new URL(path, `http://127.0.0.1:${port}`)
    url.searchParams.set("location[directory]", location)
    const response = await fetch(url, { method, headers: { authorization, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      // Not JSON: keep the text.
    }
    return { status: response.status, ok: response.ok, text, body: parsed }
  }
  const api = async <T>(method: string, path: string, body?: unknown, location = directory): Promise<T> => {
    const response = await request(method, path, body, location)
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${response.text.slice(0, 500)}`)
    return response.body as T
  }
  const until = async <T>(what: string, read: () => Promise<T | false | undefined>, ms = 180_000): Promise<T> => {
    for (const deadline = Date.now() + ms; ; await Bun.sleep(500)) {
      const value = await read().catch((error: unknown) => (Date.now() > deadline ? Promise.reject(error) : undefined))
      if (value) return value
      if (server.exitCode !== null) throw new Error(`opencode ${version} exited before ${what}`)
      if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`)
    }
  }
  const close = async () => {
    if (server.exitCode !== null || server.signalCode !== null) return
    server.kill("SIGTERM")
    const timer = setTimeout(() => server.kill("SIGKILL"), 10_000)
    await exited
    clearTimeout(timer)
  }
  return { api, request, until, close, directory, log: () => log }
}

// The files a `files` entry should put in the tarball. dist/ must hold exactly the one bundle.
function whitelisted(entry: string): string[] {
  if (entry === "dist") return DIST
  const path = join(root, entry)
  if (!existsSync(path)) return [`${entry} (missing)`]
  return statSync(path).isDirectory() ? tree(entry) : [entry]
}

function tree(dir: string, base = root): string[] {
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((item) => item.isFile() && item.name !== ".DS_Store")
    .map((item) => relative(base, join(item.parentPath, item.name)).split(sep).join("/"))
}

/**
 * Every module specifier a file really imports: a whole statement, at a line's start or after a `;` (the bundles are
 * minified, so several statements share a line), or a call with a literal specifier.
 */
const specifiers = (source: string) => [
  ...[...source.matchAll(/(?:^|;)[ \t]*(?:import|export)\b[^'"`;\n]*?\bfrom[ \t]*["']([^"']+)["']/gm)].map((match) => match[1]!),
  ...[...source.matchAll(/(?:^|;)[ \t]*import[ \t]*["']([^"']+)["']/gm)].map((match) => match[1]!),
  ...[...source.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]!),
]

const relativeImports = (source: string) => [
  ...specifiers(source).filter((specifier) => specifier.startsWith(".")),
  ...[...source.matchAll(/(?<![\w$.])(?:import|require)\s*\(/g)].map((match) => match[0]),
]

const foreign = (file: string, allowed: RegExp[]) => [...new Set(specifiers(readFileSync(file, "utf8")).filter((specifier) => !allowed.some((pattern) => pattern.test(specifier))))].sort()

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = { ...process.env, npm_config_update_notifier: "false" }): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr}\n${result.stdout}`)
  return result.stdout
}
