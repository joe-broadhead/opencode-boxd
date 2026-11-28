// The helper starts a work's OpenCode server with the machine's basics and the variables the work declares, without the
// rest of what the machine holds. The real guest/guest.py runs as a process against a folder that stands in for the
// machine's disk, with an operator's variables in its environment and in boxd's variables file. The `opencode` on its
// PATH writes the environment it was started with, so the test proves the server's environment only. It does not prove
// that a session cannot read an undeclared variable from the variables file, a login shell or sudo.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

setDefaultTimeout(60_000)

const guest = join(import.meta.dir, "../../guest/guest.py")
const helper = createHash("sha256").update(readFileSync(guest)).digest("hex")
const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "boxd-guest-env-")))
const bin = join(root, "bin")
const home = join(root, "home/boxd")
const serverEnv = join(root, "serve-env")
const OPERATOR = { OPERATOR_FIRST: "operator-gh", OPERATOR_SECOND: "operator-claude", OPERATOR_THIRD: "operator-tavily" }

/** A server that answers what the helper asks before it decides to restart: no active session, or one. */
let active: Record<string, unknown> = {}
let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  mkdirSync(bin, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(bin, "opencode"), `#!/bin/sh\ncase "$1" in\n  --version) echo 2.4.1 ;;\n  serve) env > "${serverEnv}"; env > "${root}/serve-env-$5" ;;\nesac\n`)
  chmodSync(join(bin, "opencode"), 0o755)
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/info") return Response.json({ data: { version: "2.4.1" } })
      if (path === "/api/session/active") return Response.json({ data: active })
      return new Response("not found", { status: 404 })
    },
  })
})
afterAll(() => {
  server.stop(true)
  rmSync(root, { recursive: true, force: true })
})
beforeEach(() => {
  active = {}
  rmSync(serverEnv, { force: true })
  rmSync(join(home, ".boxd-plugin"), { recursive: true, force: true })
  rmSync(join(root, "etc"), { recursive: true, force: true })
})

/** One helper call as the plugin sends it, with the operator's variables in the helper's own environment. */
async function run(request: Record<string, unknown>) {
  const child = Bun.spawn(["python3", guest], {
    stdin: new Blob([JSON.stringify({ helper, ...request })]),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      BOXD_FAKE_ROOT: root,
      LANG: "C.UTF-8",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/boxd.pem",
      ...OPERATOR,
      DECLARED_KEY: "declared-value",
    },
  })
  const [out] = await Promise.all([new Response(child.stdout).text(), child.exited])
  return JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, unknown>
}

/** One `setup` as the plugin sends it. */
async function setup(request: Record<string, unknown>, up: boolean) {
  const base = up ? `http://127.0.0.1:${server.port}` : "http://127.0.0.1:1"
  return run({ action: "setup", directory: "/home/boxd/work/review-api", base, ...request })
}

const startedWith = (port?: number): Record<string, string> =>
  Object.fromEntries(
    readFileSync(port ? join(root, `serve-env-${port}`) : serverEnv, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  )

describe("a work's OpenCode environment", () => {
  test("starts with the basics and the declared variables, and no operator variable", async () => {
    expect(await setup({ env: ["DECLARED_KEY", "OPERATOR_FIRST"] }, false)).toMatchObject({ ok: true, server: "starting" })
    const seen = startedWith()
    expect(seen.OPERATOR_FIRST).toBe("operator-gh")
    expect(seen.DECLARED_KEY).toBe("declared-value")
    expect(seen.PATH).toContain(bin)
    expect(seen.HOME).toBe(home)
    expect(seen.LANG).toBe("C.UTF-8")
    expect(seen.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/boxd.pem")
    expect(seen.OPENCODE_PASSWORD).toBeTruthy()
    expect(seen.OPERATOR_SECOND).toBeUndefined()
    expect(seen.OPERATOR_THIRD).toBeUndefined()
  })

  test("declaring nothing withholds every operator variable", async () => {
    await setup({}, false)
    const seen = startedWith()
    for (const name of [...Object.keys(OPERATOR), "DECLARED_KEY", "BOXD_FAKE_ROOT"]) expect(seen[name]).toBeUndefined()
    expect(seen.PATH).toContain(bin)
  })

  test("a declared variable comes from boxd's variables file when the process does not hold it", async () => {
    mkdirSync(join(root, "etc/profile.d"), { recursive: true })
    writeFileSync(join(root, "etc/profile.d/boxd-env.sh"), "# Generated\nexport FILE_DECLARED='from file'\nexport FILE_OTHER=hidden\n")
    await setup({ env: ["FILE_DECLARED"] }, false)
    const seen = startedWith()
    expect(seen.FILE_DECLARED).toBe("from file")
    expect(seen.FILE_OTHER).toBeUndefined()
  })

  test("a server that runs with other variables is restarted when idle and left alone when busy", async () => {
    await setup({ env: ["OPERATOR_FIRST"] }, false)
    rmSync(serverEnv)
    // The same declaration restarts nothing.
    expect(await setup({ env: ["OPERATOR_FIRST"] }, true)).toMatchObject({ ok: true, server: "up" })
    expect(existsSync(serverEnv)).toBe(false)
    // A busy session blocks the change, and the server stays as it was.
    active = { ses_busy: {} }
    expect(await setup({ env: [] }, true)).toMatchObject({ ok: false, error: "SESSION_BUSY" })
    expect(existsSync(serverEnv)).toBe(false)
    active = {}
    expect(await setup({ env: [] }, true)).toMatchObject({ ok: true, server: "starting" })
    expect(startedWith().OPERATOR_FIRST).toBeUndefined()
  })

  test("a server that an older helper started, with the whole environment, is restarted on the next setup", async () => {
    expect(await setup({}, true)).toMatchObject({ ok: true, server: "starting" })
    expect(startedWith().OPERATOR_FIRST).toBeUndefined()
  })

  test.each([[["lower_case"]], [["BAD-NAME"]], [["OPENCODE_PASSWORD"]], ["OPERATOR_FIRST"], [[1]]])("a declaration of %p is refused and starts nothing", async (env) => {
    expect(await setup({ env }, false)).toMatchObject({ ok: false, error: "NAME_INVALID" })
    expect(existsSync(serverEnv)).toBe(false)
  })

  test("two slots keep their own port, password and declared variables; a scrub refuses while they exist", async () => {
    const alpha = await run({ action: "setup", directory: "/home/boxd/work/alpha", slot: "alpha", env: ["DECLARED_KEY"], opencode: "2.4.1" })
    const beta = await run({ action: "setup", directory: "/home/boxd/work/beta", slot: "beta", env: ["OPERATOR_FIRST"], opencode: "2.4.1" })
    expect(alpha).toMatchObject({ ok: true, server: "starting" })
    expect(beta).toMatchObject({ ok: true, server: "starting" })
    const alphaPort = Number(readFileSync(join(home, ".boxd-plugin/slots/alpha/port"), "utf8"))
    const betaPort = Number(readFileSync(join(home, ".boxd-plugin/slots/beta/port"), "utf8"))
    expect(alphaPort).not.toBe(betaPort)
    for (const port of [alphaPort, betaPort]) {
      expect(port).toBeGreaterThanOrEqual(4100)
      expect(port).toBeLessThan(4200)
    }
    expect(startedWith(alphaPort)).toMatchObject({ DECLARED_KEY: "declared-value", OPENCODE_PASSWORD: expect.any(String) })
    expect(startedWith(alphaPort).OPERATOR_FIRST).toBeUndefined()
    expect(startedWith(betaPort)).toMatchObject({ OPERATOR_FIRST: "operator-gh", OPENCODE_PASSWORD: expect.any(String) })
    expect(startedWith(betaPort).DECLARED_KEY).toBeUndefined()
    expect(readFileSync(join(home, ".boxd-plugin/slots/alpha/password"), "utf8")).not.toBe(readFileSync(join(home, ".boxd-plugin/slots/beta/password"), "utf8"))

    expect(await run({ action: "scrub" })).toMatchObject({ ok: true, removed: [], refused: "has-slot" })
    expect(await run({ action: "release", slot: "alpha" })).toMatchObject({
      ok: true,
      slot: "alpha",
      removed: ["/home/boxd/.boxd-plugin/slots/alpha", "/home/boxd/work/alpha"],
    })
    expect(existsSync(join(home, ".boxd-plugin/slots/alpha"))).toBe(false)
    expect(existsSync(join(home, ".boxd-plugin/slots/beta"))).toBe(true)
    const slots = await run({ action: "slots" })
    expect(slots).toMatchObject({ ok: true, slots: [{ workId: "beta", port: betaPort }] })
  })
})
