// The boxd-sessions skill: its name, its description within the fixed-context budget, and the methods it names.
import { describe, expect, test } from "bun:test"
import { manifest } from "../../src/manifest.js"
import { loadSkills, parseSkill, skillPath } from "../../src/skills.js"

const methods = new Set(Object.keys(manifest.methods))

describe("the boxd-sessions skill", () => {
  test("is the one skill, with the name, a description and a body", async () => {
    const { skills, problems } = await loadSkills()
    expect(problems).toEqual([])
    expect(skills).toHaveLength(1)
    const skill = skills[0]!
    expect(String(skill.name)).toBe("boxd-sessions")
    expect(String(skill.description).length).toBeGreaterThan(30)
    expect(String(skill.description).length).toBeLessThanOrEqual(300)
    expect(skill.content.length).toBeGreaterThan(200)
    expect(String(skill.path)).toBe(skillPath())
  })

  test("names only declared methods, as tools.boxd.<method>, and the real fields", async () => {
    const { skills } = await loadSkills()
    const text = skills[0]!.content
    for (const [, method] of text.matchAll(/tools\.boxd\.([a-z][a-z0-9_]*)/g)) expect({ method, known: methods.has(method!) }).toEqual({ method, known: true })
    for (const field of ["workId", "works", "select", "localDirectory", "since"]) expect(text).toContain(field)
    // No tool reference outside the namespace.
    expect(text.match(/\bboxd_([a-z_]+)\b/g) ?? []).toEqual([])
  })

  test("states the account, the access levels and the error form", async () => {
    const { skills } = await loadSkills()
    const text = skills[0]!.content
    for (const phrase of ["one account, `default`", "`all`", "`ask-changes`", "`read-only`", "CODE: What happened. Next step: What to do."]) expect(text).toContain(phrase)
  })

  test("refuses a skill whose front matter names another skill", () => {
    expect(() => parseSkill("boxd-sessions", "/x/SKILL.md", "---\nname: other\ndescription: x\n---\nbody")).toThrow(/name "boxd-sessions"/)
  })
})
