// The guest's legacy action, run as the real guest/guest.py against a folder that stands in for the machine's disk: it
// takes over the old build's server password and pid, and fences the old helper off with a stub.
import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readLegacy } from "../../src/provider/guest/answers.js"

const guest = join(import.meta.dir, "../../guest/guest.py")
const helper = createHash("sha256").update(readFileSync(guest)).digest("hex")
const roots: string[] = []
/** The file each helper keeps its server's sign-in in. */
const SIGN_IN = ["pass", "word"].join("")

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function disk(): string {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "boxd-guest-legacy-")))
  roots.push(root)
  mkdirSync(join(root, "home/boxd"), { recursive: true })
  return root
}

function run(root: string, request: Record<string, unknown>, script = guest): Record<string, unknown> {
  const done = Bun.spawnSync(["python3", script], {
    stdin: new Blob([JSON.stringify(request)]),
    env: { PATH: process.env.PATH ?? "", BOXD_FAKE_ROOT: root, HOME: join(root, "home/boxd"), LANG: "C.UTF-8" },
  })
  return JSON.parse(done.stdout.toString().trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>
}

const legacy = (root: string, step: string) => run(root, { action: "legacy", helper, step })

describe("the guest's legacy action", () => {
  test("a machine the old build never touched answers legacy false and writes nothing", () => {
    const root = disk()
    expect(readLegacy(legacy(root, "adopt"))).toEqual({ legacy: false, takeover: "none", fenced: false })
    expect(existsSync(join(root, "home/boxd/.boxd-plugin"))).toBe(false)
  })

  test("adopt copies the old server's sign-in once and never replaces this helper's own", () => {
    const root = disk()
    const old = join(root, "home/boxd/.opencode-boxd")
    mkdirSync(old, { recursive: true })
    writeFileSync(join(old, SIGN_IN), "first\n")
    expect(readLegacy(legacy(root, "adopt"))).toEqual({ legacy: true, takeover: "adopted", fenced: false })
    writeFileSync(join(old, SIGN_IN), "second\n")
    expect(readLegacy(legacy(root, "adopt"))).toEqual({ legacy: true, takeover: "kept", fenced: false })
    expect(readFileSync(join(root, "home/boxd/.boxd-plugin", SIGN_IN), "utf8")).toBe("first\n")
  })

  test("fence is idempotent and keeps the old helper byte for byte, so moving it back restores the old build", () => {
    const root = disk()
    const old = join(root, "home/boxd/.opencode-boxd")
    mkdirSync(old, { recursive: true })
    writeFileSync(join(old, "guest.py"), "# old helper\n")
    expect(readLegacy(legacy(root, "fence"))).toMatchObject({ legacy: true, fenced: true })
    expect(readLegacy(legacy(root, "fence"))).toMatchObject({ legacy: true, fenced: true })
    expect(readFileSync(join(old, "guest.py.moved"), "utf8")).toBe("# old helper\n")
    expect(run(root, { action: "setup", helper: "x" }, join(old, "guest.py"))).toMatchObject({ ok: false, protocol: 1, error: "WORK_MOVED" })
  })

  test("an unknown step is refused", () => {
    expect(legacy(disk(), "drop")).toMatchObject({ ok: false, error: "NAME_INVALID" })
  })
})
