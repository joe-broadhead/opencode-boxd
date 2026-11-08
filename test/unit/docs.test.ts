// The README, the docs set and the error table are one contract: every code has a Troubleshooting row and an Errors
// row, every scripting example is a body the RPC accepts, the default-rules block is the code's own, every "tested on"
// list is TESTED_HOSTS, and no text describes a state the package is not in.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { CODES } from "../../src/errors.js"
import { COMMAND_STEM, TESTED_HOSTS } from "../../src/constants.js"
import { TOOLS } from "../../src/tools.js"
import { defaultRules } from "../../src/permissions.js"

const root = new URL("../../", import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), "utf8")
const README = read("README.md")
const CONFIG = read("docs/configuration.md")
const SCRIPTING = read("docs/scripting.md")

const codes = Object.keys(CODES)

/** Every file under a folder, relative to the repository. */
function files(folder: string): string[] {
  return readdirSync(fileURLToPath(new URL(`../../${folder}`, import.meta.url)), { withFileTypes: true }).flatMap((entry) => {
    const path = `${folder}/${entry.name}`
    return entry.isDirectory() ? files(path) : [path]
  })
}

/**
 * Every code the plugin can put in front of a person or a script, from one place per call site: `boxdError("CODE"`,
 * `errorText("CODE"` (the two paths that bypass `CODES`), and a `"CODE: message"` literal. A code that is in `CODES`
 * only by accident is fine; a code raised and not in `CODES` is a failure.
 */
function raisedCodes(): string[] {
  const sources = files("src")
  const found = sources.flatMap((path) => {
    const text = read(path)
    return [
      ...text.matchAll(/\b(?:boxdError|errorText)\(\s*"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)"/g),
      ...text.matchAll(/["'`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+):\s/g),
    ].map((match) => match[1]!)
  })
  return [...new Set(found)].sort()
}

/** The minimum JSON Schema check a scripting example needs: type, required and additionalProperties. */
function conforms(value: unknown, schema: Record<string, unknown>, at = "input"): string | undefined {
  const type = schema.type as string | undefined
  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return `${at} must be an object`
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
    for (const required of (schema.required ?? []) as string[]) if (!(required in (value as Record<string, unknown>))) return `${at}.${required} is required`
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value as Record<string, unknown>)) if (!(key in properties)) return `${at}.${key} is not allowed`
    }
    for (const [key, child] of Object.entries(properties)) {
      const inside = (value as Record<string, unknown>)[key]
      if (inside === undefined) continue
      const problem = conforms(inside, child, `${at}.${key}`)
      if (problem !== undefined) return problem
    }
    return undefined
  }
  if (type === "string") return typeof value === "string" ? undefined : `${at} must be a string`
  return undefined
}

describe("the README", () => {
  test("has the family's sections, in order", () => {
    const headings = [...README.matchAll(/^## (.+)$/gm)].map((match) => match[1])
    expect(headings).toEqual(["Requirements", "Install", "Sign in", "Use", "Files in and out", "Permissions", "Configure", "Organisation rollout", "Troubleshooting", "Uninstall", "Links"])
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

  test("every code raised in src/ or bin/ is in the one table", () => {
    const raised = raisedCodes()
    expect(raised.length).toBeGreaterThan(5)
    expect(raised.filter((code) => !codes.includes(code))).toEqual([])
  })

  test("names the command and the dialog", () => {
    expect(README).toContain(`/${COMMAND_STEM}-status`)
    expect(README).toContain(`/${COMMAND_STEM}`)
  })

  test("says every tool is allowed by default, and names the three ways to restrict", () => {
    expect(README).toContain("**Every tool is allowed by default.**")
    for (const value of ["\"all\"", "\"ask-changes\"", "\"read-only\""]) expect(README).toContain(value)
    for (const tool of ["boxd_ensure", "boxd_submit", "boxd_harvest", "boxd_sleep", "boxd_resume", "boxd_image", "boxd_drop"]) {
      expect(README).toContain(tool)
    }
    expect(README).toContain("a machine that idles hibernates")
  })

  test("prints the default-rules block exactly as the code generates it, in order", () => {
    const block = [/(## Permissions\n[\s\S]*?)```json\n([\s\S]*?)\n```/].map((pattern) => pattern.exec(README)?.[2]).find((body) => body?.includes("boxd_*"))
    expect(block).toBeDefined()
    const rules = JSON.parse(block!) as { action: string; resource: string; effect: string }[]
    // The exact block the transform inserts: generated here, printed there, so neither can drift.
    expect(rules).toEqual(defaultRules().map((rule) => ({ ...rule })))
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
  test("has the shared files, each with a heading", () => {
    for (const path of ["docs/configuration.md", "docs/architecture.md", "docs/golden-image.md", "docs/jelly.md", "docs/scripting.md", "docs/live-check.md"]) {
      expect(existsSync(new URL(path, root))).toBe(true)
      expect(read(path)).toMatch(/^# /m)
    }
  })

  test("every 'tested on' list in the docs is TESTED_HOSTS", () => {
    const expected = `${TESTED_HOSTS.slice(0, -1).join(", ")} and ${TESTED_HOSTS.at(-1)}`
    const documents = ["README.md", "AGENTS.md", "SECURITY.md", "docs/configuration.md", "CHANGELOG.md"]
    let found = 0
    for (const document of documents) {
      const text = read(document).replace(/\s+/g, " ")
      for (const phrase of ["tested on ", "runs on OpenCode ", "tested on OpenCode "]) {
        for (let at = text.indexOf(phrase); at !== -1; at = text.indexOf(phrase, at + 1)) {
          found += 1
          expect({ document, after: text.slice(at + phrase.length, at + phrase.length + expected.length) }).toEqual({ document, after: expected })
        }
      }
    }
    expect(found).toBeGreaterThan(3)
  })

  test("scripting names every method, the location and the saved-approval limit", () => {
    for (const tool of TOOLS.map((spec) => spec.id)) expect(SCRIPTING).toContain(tool)
    expect(SCRIPTING).toContain("Known limit: a saved \"Always allow\" answer")
    expect(SCRIPTING).toContain("boxd.machines.tools")
    expect(SCRIPTING).toContain("## The location")
  })

  test("every scripting example is a body the RPC accepts, with the header and the envelope", () => {
    const calls = [...SCRIPTING.matchAll(/^(?:opencode api post|curl)([^\n]*)/gm)].map((match) => match[1]!)
    expect(calls.length).toBeGreaterThan(1)
    for (const call of calls) {
      expect(call).toContain("x-opencode-directory:$PWD")
      expect(call).toContain("/api/rpc/")
    }
    // Each `opencode api post …` example: the method exists, and its input validates against that tool's schema.
    const examples = [...SCRIPTING.matchAll(/opencode api post \/api\/rpc\/boxd\.machines\.tools\/(\w+)[^\n]*-d '(\{[\s\S]*?\})'/g)]
    expect(examples.length).toBeGreaterThan(1)
    for (const [, method, body] of examples) {
      const envelope = JSON.parse(body!) as { input?: { sessionID?: string; input?: unknown } }
      expect({ method, keys: Object.keys(envelope) }).toEqual({ method, keys: ["input"] })
      expect(typeof envelope.input?.sessionID).toBe("string")
      if (method === "describe") continue
      const spec = TOOLS.find((tool) => tool.id === method)
      expect({ method, known: spec !== undefined }).toEqual({ method, known: true })
      expect({ method, problem: conforms(envelope.input?.input ?? {}, spec!.input as Record<string, unknown>) }).toEqual({ method, problem: undefined })
    }
  })

  test("scripting states the result shape and the refusal codes", () => {
    expect(SCRIPTING).toContain("A plugin-owned method's result is the method's output object")
    for (const code of ["PERMISSION_DENIED", "SESSION_UNKNOWN", "SESSION_AGENT_REQUIRED", "TOOL_UNAVAILABLE"]) {
      expect(SCRIPTING).toContain(`\`${code}\``)
    }
  })

  test("jelly says a later tool is not asked about in Jelly", () => {
    expect(read("docs/jelly.md")).toContain("a tool boxd adds later is not asked about in Jelly, a write included")
  })

  test("the AGENTS file states the rules the checks enforce", () => {
    const agents = read("AGENTS.md")
    for (const phrase of ["Public API only", "Forbidden in this repository", "Every write asserts", "npm run check"]) expect(agents).toContain(phrase)
  })
})
