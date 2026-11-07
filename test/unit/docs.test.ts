// The README, the docs set and the error table are one contract: every code has a Troubleshooting row and an Errors
// row, the README has the family's sections in order, and no text describes a state the package is not in.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { CODES } from "../../src/errors.js"
import { COMMAND_STEM, TESTED_HOSTS } from "../../src/constants.js"

const root = new URL("../../", import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), "utf8")
const README = read("README.md")
const CONFIG = read("docs/configuration.md")

const codes = Object.keys(CODES)

describe("the README", () => {
  test("has the family's sections, in order", () => {
    const headings = [...README.matchAll(/^## (.+)$/gm)].map((match) => match[1])
    expect(headings).toEqual(["Requirements", "Install", "Sign in", "Use", "Permissions", "Configure", "Organisation rollout", "Troubleshooting", "Uninstall", "Links"])
    expect(README.split("\n")[0]).toBe("# boxd for OpenCode")
    expect(README).toContain("Unofficial; not affiliated with boxd.")
  })

  test("states the supported range and every tested release", () => {
    expect(README).toContain("OpenCode `>=2.2.3 <2.3.0`")
    expect(README).toContain(`tested on ${TESTED_HOSTS.slice(0, -1).join(", ")} and ${TESTED_HOSTS.at(-1)}`)
    expect(README).toContain("macOS or Linux")
  })

  test("installs from the registry, not from a checkout", () => {
    expect(README).toContain("opencode plugin add @joe-broadhead/opencode-boxd")
    expect(README).not.toMatch(/plugins.*\.\/opencode-boxd/)
    expect(README).not.toMatch(/npm run build/)
  })

  test("has one Troubleshooting row for every code, and no code the plugin does not raise", () => {
    const rows = [...README.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((match) => match[1])
    expect(rows.sort()).toEqual([...codes].sort())
    for (const code of codes) expect(CONFIG).toContain(`| \`${code}\` |`)
  })

  test("names the command and the dialog", () => {
    expect(README).toContain(`/${COMMAND_STEM}-status`)
    expect(README).toContain(`/${COMMAND_STEM}`)
  })

  test("says what each machine change asks for, and why drop asks rather than being off", () => {
    expect(README).toContain("`boxd_drop` asks rather than being off")
    for (const tool of ["boxd_ensure", "boxd_submit", "boxd_harvest", "boxd_sleep", "boxd_resume", "boxd_image", "boxd_drop"]) {
      expect(README).toContain(tool)
    }
  })

  test("links every repo file on the default branch", () => {
    const links = [...README.matchAll(/\]\((https:\/\/github\.com\/joe-broadhead\/opencode-boxd\/blob\/HEAD\/[^)]+)\)/g)].map((match) => match[1]!)
    expect(links.length).toBeGreaterThan(3)
    for (const link of links) {
      const path = link.split("/blob/HEAD/")[1]!
      expect(existsSync(new URL(path, root))).toBe(true)
    }
  })

  test("describes the published state: no provisional, private or process text, and no test counts", () => {
    for (const text of [README, CONFIG, read("CHANGELOG.md"), read("AGENTS.md"), read("CONTRIBUTING.md")]) {
      expect(text).not.toMatch(/not published yet|private until|provisional|not yet checked|TODO|FIXME/i)
      expect(text).not.toMatch(/\b\d+ tests?\b/i)
    }
    expect(README).not.toMatch(/0\.\d+\.\d+/)
  })
})

describe("the docs set", () => {
  test("has the four files, each with a heading", () => {
    for (const path of ["docs/configuration.md", "docs/architecture.md", "docs/jelly.md", "docs/scripting.md", "docs/live-check.md"]) {
      expect(existsSync(new URL(path, root))).toBe(true)
      expect(read(path)).toMatch(/^# /m)
    }
  })

  test("scripting names every method and the DC-2 limit", () => {
    const scripting = read("docs/scripting.md")
    for (const tool of ["boxd_status", "boxd_job", "boxd_ensure", "boxd_submit", "boxd_harvest", "boxd_sleep", "boxd_resume", "boxd_image", "boxd_drop"]) {
      expect(scripting).toContain(tool)
    }
    expect(scripting).toContain("DC-2")
  })

  test("jelly says a later tool is not asked about in Jelly", () => {
    expect(read("docs/jelly.md")).toContain("a tool boxd adds later is not asked about in Jelly, a write included")
  })

  test("the AGENTS file states the rules the checks enforce", () => {
    const agents = read("AGENTS.md")
    for (const phrase of ["Public API only", "Forbidden in this repository", "Every write asserts", "npm run check"]) expect(agents).toContain(phrase)
  })
})
