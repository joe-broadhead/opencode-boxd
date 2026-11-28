// The boxd-sessions skill: its name, its description within the fixed-context budget, and the methods it names.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { manifest } from "../../src/manifest.js"
import { readSkills } from "../../src/skills.js"

const ROOT = join(import.meta.dir, "..", "..")
const methods = new Set(Object.keys(manifest.methods))
const roots: string[] = []

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "boxd-skill-"))
  roots.push(root)
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, "SKILL.md"), text)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("the boxd-sessions skill", () => {
  test("is the one skill, with the name, a description and a body", () => {
    const skills = readSkills()
    expect(skills).toHaveLength(1)
    const skill = skills[0]!
    expect(skill.name).toBe("boxd-sessions")
    expect(skill.id).toBe("boxd-sessions")
    expect(skill.description.length).toBeGreaterThan(30)
    expect(skill.description.length).toBeLessThanOrEqual(300)
    expect(skill.content.length).toBeGreaterThan(200)
    expect(skill.path).toBe(join(ROOT, "skills", "boxd-sessions", "SKILL.md"))
  })

  test("names only declared methods, as tools.boxd.<method>, and the real fields", () => {
    const text = readSkills()[0]!.content
    for (const [, method] of text.matchAll(/tools\.boxd\.([a-z][a-z0-9_]*)/g)) expect({ method, known: methods.has(method!) }).toEqual({ method, known: true })
    for (const field of ["workId", "works", "select", "localDirectory", "since"]) expect(text).toContain(field)
    // No tool reference outside the namespace, except the guest tools the manifest declares under guestTools.
    const guestTools = new Set((manifest.guestTools ?? []).map((name) => `boxd_${name}`))
    expect([...guestTools]).toContain("boxd_done")
    expect((text.match(/\bboxd_([a-z_]+)\b/g) ?? []).filter((name) => !guestTools.has(name))).toEqual([])
  })

  test("teaches the done signal from the guest tool, not a text marker", () => {
    const text = readSkills()[0]!.content
    expect(text).toContain("boxd_done({ summary, prs })")
    expect(text).toContain("done: true")
    expect(text).toContain("outcome: completed")
    expect(text).toContain("summary")
    expect(text).toContain("prs")
    const docs = [
      join(ROOT, "README.md"),
      join(ROOT, "AGENTS.md"),
      ...readdirSync(join(ROOT, "docs")).filter((name) => name.endsWith(".md")).map((name) => join(ROOT, "docs", name)),
      join(ROOT, "skills", "boxd-sessions", "SKILL.md"),
    ]
    for (const file of docs) expect(readFileSync(file, "utf8")).not.toMatch(/\bLANE-DONE\b/)
    const capabilities = readFileSync(join(ROOT, "docs", "capabilities.md"), "utf8")
    expect(capabilities).toContain("boxd_done({ summary, prs })")
    expect(capabilities).toContain("done: true")
    expect(capabilities).toContain("outcome: completed")
  })

  test("teaches the registry copy, its report and what the machine holds", () => {
    const read = (path: string) => readFileSync(join(ROOT, path), "utf8")
    const architecture = read("docs/architecture.md")
    expect(architecture).toContain("oc-reg-<ledgerId>")
    expect(architecture).toContain("backups.period")
    expect(architecture).toContain("24h")
    expect(architecture).toContain("`/boxd` and `status` show the machine")
    const security = read("docs/security.md")
    expect(security).toContain("The registry machine")
    expect(security).toContain("patches, untracked files and `ledger-id`")
    expect(security).toContain("every record, export, patch and untracked file")
    expect(security).toContain("transcripts")
    expect(security).toContain("private to the operator")
  })

  test("states the account, the access levels and the error form", () => {
    const text = readSkills()[0]!.content
    for (const phrase of ["no plugin-held account", "`all`", "`ask-changes`", "`read-only`", "CODE: What happened. Next step: What to do."]) expect(text).toContain(phrase)
  })

  test("parses folded and literal block descriptions, and a quoted colon description, as YAML text", () => {
    const root = fixture({
      folded: "---\nname: folded\ndescription: >\n  Run on a private machine, then bring the result back.\n---\n# Folded\nbody\n",
      literal: "---\nname: literal\ndescription: |-\n  line one\n  line two\n---\n# Literal\nbody\n",
      quoted: '---\nname: quoted\ndescription: "A skill: with a colon"\n---\n# Quoted\nbody\n',
    })
    const byId = new Map(readSkills(root).map((skill) => [skill.id, skill]))
    expect(byId.get("folded")!.description.trim()).toBe("Run on a private machine, then bring the result back.")
    expect(byId.get("literal")!.description).toBe("line one\nline two")
    expect(byId.get("quoted")!.description).toBe("A skill: with a colon")
    for (const skill of byId.values()) expect(skill.content.length).toBeGreaterThan(0)
  })

  test("refuses a bare block marker, and a name that is not its directory", () => {
    const marker = fixture({ marker: "---\nname: marker\ndescription: >\n---\n# Marker\nbody\n" })
    expect(() => readSkills(marker)).toThrow(/SKILLS_INVALID|description/)
    const wrong = fixture({ wrong: "---\nname: other\ndescription: x\n---\nbody\n" })
    expect(() => readSkills(wrong)).toThrow(/names "other", not its directory "wrong"/)
  })
})
