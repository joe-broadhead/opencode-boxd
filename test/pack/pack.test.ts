// Pack, install and load the published shape: the tarball holds exactly the files whitelist, installs with lifecycle
// scripts disabled, and both entry points load. Then, on each stock OpenCode release, the installed plugin is started
// by the real binary and its tools, default rules, command and status RPC are checked. No boxd machine is ever started:
// the plugin is pointed at a fake CLI through the plugin's own snapshot option only for status, and every tool call that
// would touch a machine is left out here (test/host does those against a fake CLI and a fake guest).
import { afterAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { arch, platform } from "node:os"
import { basename, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { SUPPORTED_HOST, TESTED_HOSTS } from "../../src/constants.js"
import { defaultRules, type Rule } from "../../src/permissions.js"
import { TOOLS } from "../../src/tools.js"
import { StatusRpc } from "../../src/status.js"

const root = fileURLToPath(new URL("../..", import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string
  version: string
  files: string[]
  exports: Record<string, string>
  devDependencies: Record<string, string>
}
// Outside the repository, so nothing resolves from the repository's own node_modules.
const work = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "boxd-pack-")))
run("git", ["init", "--quiet", work], root)
afterAll(() => rmSync(work, { recursive: true, force: true }), { timeout: 120_000 })

const MAX_FILES = 30
const MAX_PACKED_BYTES = 100 * 1024
const DIST = ["dist/index.js", "dist/tui.js"]
const SERVER_HOST_MODULES = [/^node:/, /^@opencode\/plugin(?:\/|$)/]
const TUI_HOST_MODULES = [/^node:/, /^@opencode\/plugin(?:\/|$)/, /^@opentui\//, /^solid-js(?:\/|$)/]
const HOST_PACKAGES = ["@opencode/plugin", "@opentui/core", "@opentui/solid", "solid-js"]
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
function install(withHostPackages: boolean): string {
  const name = withHostPackages ? "with-host-packages" : "alone"
  const existing = installs.get(name)
  if (existing) return existing
  const dir = project(name)
  const hosts = withHostPackages ? HOST_PACKAGES.map((item) => `${item}@${pkg.devDependencies[item]}`) : []
  run("npm", ["install", join(work, pack().filename), ...hosts, "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], dir)
  installs.set(name, dir)
  return dir
}

const installedPackage = (withHostPackages: boolean) => join(install(withHostPackages), "node_modules", ...pkg.name.split("/"))

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
    expect(size).toBeLessThanOrEqual(MAX_PACKED_BYTES)
    expect(paths.filter((path) => path.includes("node_modules/") || /\.(?:tsx|jsx)$/.test(path))).toEqual([])
    for (const target of Object.values(pkg.exports)) expect(paths).toContain(target.replace(/^\.\//, ""))
    expect(paths.filter((path) => path.endsWith(".d.ts"))).toEqual([])
    // The guest helper and the skill are the product, so they must be in every tarball.
    expect(paths).toContain("guest/guest.py")
    expect(paths).toContain("skills/boxd/SKILL.md")
  }, 120_000)

  test("installs with scripts disabled and loads both entry points under Bun", () => {
    const consumer = install(true)
    const probe = join(consumer, "probe.mjs")
    writeFileSync(
      probe,
      [
        "const out = {}",
        `for (const [part, specifier] of [["server", ${JSON.stringify(pkg.name)}], ["tui", ${JSON.stringify(`${pkg.name}/tui`)}]]) {`,
        "  const plugin = (await import(specifier)).default",
        "  out[part] = { id: plugin?.id, setup: typeof plugin?.setup }",
        "}",
        "console.log(JSON.stringify(out))",
      ].join("\n"),
    )
    const output = run(process.execPath, [probe], consumer, { PATH: process.env.PATH, ...isolated(join(work, "bun-probe")) })
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({
      server: { id: "boxd.machines", setup: "function" },
      tui: { id: "boxd.machines.tui", setup: "function" },
    })
  }, 300_000)

  test("dist holds only the two entry bundles, and they import no sibling module", () => {
    const dist = join(installedPackage(true), "dist")
    expect(tree(relative(root, dist), dist).sort()).toEqual(["index.js", "tui.js"])
    for (const file of ["index.js", "tui.js"]) expect(relativeImports(readFileSync(join(dist, file), "utf8"))).toEqual([])
  }, 300_000)

  test("dist imports only modules the host provides", () => {
    const dist = join(installedPackage(true), "dist")
    expect(foreign(join(dist, "index.js"), SERVER_HOST_MODULES)).toEqual([])
    expect(foreign(join(dist, "tui.js"), TUI_HOST_MODULES)).toEqual([])
  }, 300_000)
})

describe.each(TESTED_HOSTS)("installed alone, in stock OpenCode %s", (version) => {
  test("is active, registers the nine tools, adds the default rules, and answers the status RPC", async () => {
    const installed = installedPackage(false)
    const host = await serve(version, installed)
    try {
      const plugin = await host.until("the plugin finishes loading", async () => {
        const { data } = await host.api<{ data: { id: string; state: { status: string; error?: string } }[] }>("GET", "/api/plugin")
        const found = data.find((item) => item.id === "boxd.machines")
        if (found?.state.status === "failed") throw new Error(`the plugin failed: ${found.state.error}`)
        return found && found.state.status !== "loading" ? found : undefined
      })
      expect(plugin.state).toEqual({ status: "active" })

      // The status RPC counts the tools OpenCode lists in the `boxd` namespace: nine, none unknown.
      await host.until("the nine tools are registered", async () => {
        const { output } = await host.api<{ output: { tools: number; unknownCount: number } }>("POST", "/api/rpc/boxd.machines/status", { input: {} })
        return output.tools === TOOLS.length && output.unknownCount === 0
      })

      const build = await host.until("the build agent has the default rules", async () => {
        const { data } = await host.api<{ data: { id: string; permissions: Rule[] }[] }>("GET", "/api/agent")
        const permissions = data.find((agent) => agent.id === "build")?.permissions
        return permissions?.slice(1, 1 + defaultRules().length)
      })
      expect(build).toEqual(defaultRules())

      const { output } = await host.api<{ output: Record<string, unknown> }>("POST", "/api/rpc/boxd.machines/status", { input: {} })
      expect(output).toMatchObject({
        version: pkg.version,
        state: "connected",
        host: { version, range: SUPPORTED_HOST, tested: true },
        snapshot: "opencode-claude-final",
        guestVersion: version,
        openWorks: 0,
        unknownCount: 0,
        unguardedAgents: [],
        problems: [],
        nextStep: "Nothing to do.",
      })
      expect(StatusRpc.methods.status.output.required).toContain("nextStep")

      const { data: agents } = await host.api<{ data: { id: string }[] }>("GET", "/api/agent")
      expect(agents.map((agent) => agent.id).filter((id) => !BUILT_IN_AGENTS.includes(id))).toEqual([])
      const { data: skills } = await host.api<{ data: { id: string; path: string }[] }>("GET", "/api/skill")
      expect(skills.filter((skill) => skill.id === "boxd").map((skill) => skill.path)).toEqual([join(installed, "skills", "boxd", "SKILL.md")])
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

// The files a `files` entry should put in the tarball. dist/ must hold exactly the two bundles.
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

/** Every module specifier a file really imports: a whole statement line, or a call with a literal specifier. */
const specifiers = (source: string) => [
  ...[...source.matchAll(/^[ \t]*(?:import|export)[ \t][^'"`\n]*?from[ \t]*["']([^"']+)["']/gm)].map((match) => match[1]!),
  ...[...source.matchAll(/^[ \t]*import[ \t]*["']([^"']+)["']/gm)].map((match) => match[1]!),
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
