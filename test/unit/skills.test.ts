// The boxd-sessions skill: its name, its description within the fixed-context budget, and the methods it names.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { manifest } from "../../src/manifest.js"
import { readSkills } from "../../src/skills.js"

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
    expect(skill.path).toBe(join(import.meta.dir, "..", "..", "skills", "boxd-sessions", "SKILL.md"))
  })

  test("names only declared methods, as tools.boxd.<method>, and the real fields", () => {
    const text = readSkills()[0]!.content
    for (const [, method] of text.matchAll(/tools\.boxd\.([a-z][a-z0-9_]*)/g)) expect({ method, known: methods.has(method!) }).toEqual({ method, known: true })
    for (const field of ["workId", "works", "select", "localDirectory", "since"]) expect(text).toContain(field)
    // No tool reference outside the namespace.
    expect(text.match(/\bboxd_([a-z_]+)\b/g) ?? []).toEqual([])
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
