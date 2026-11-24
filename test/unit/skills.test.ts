import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSkills, parseSkill, skillPath } from "../../src/skills.js"
import { TOOLS } from "../../src/tools.js"

describe("the boxd-sessions skill", () => {
  test("is the one skill, with the name, a description and a body", async () => {
    const { skills, problems } = await loadSkills()
    expect(problems).toEqual([])
    expect(skills).toHaveLength(1)
    const skill = skills[0]!
    expect(String(skill.name)).toBe("boxd-sessions")
    expect(String(skill.description).length).toBeGreaterThan(30)
    expect(skill.content.length).toBeGreaterThan(200)
    expect(String(skill.path)).toBe(skillPath())
  })

  test("states the real tool names and parameters, and no tool the plugin does not have", async () => {
    const { skills } = await loadSkills()
    const text = skills[0]!.content
    for (const tool of TOOLS) expect(text).toContain(tool.id)
    for (const field of ["workId", "localDirectory", "machine", "select", "since", "works"]) expect(text).toContain(field)
    // Every boxd_* it names is a tool, and every key a call example passes is in that tool's schema.
    for (const [, name] of text.matchAll(/\bboxd_([a-z_]+)\b/g)) expect({ name, known: TOOLS.some((tool) => tool.name === name) }).toEqual({ name, known: true })
    for (const [, name, body] of text.matchAll(/\bboxd_([a-z]+)\(\{([^}]*)\}\)/g)) {
      const properties = Object.keys((TOOLS.find((tool) => tool.name === name)!.input as { properties: Record<string, unknown> }).properties)
      for (const [, key] of body!.matchAll(/(\w+)(?=\s*[:,}]|\s*$)/g)) if (!/^".*"$/.test(key!)) expect({ name, key, known: properties.includes(key!) || /^[A-Z]/.test(key!) }).toEqual({ name, key, known: true })
    }
  })

  test("has the short Cost section, with the lifecycle and the consent rule", async () => {
    const { skills } = await loadSkills()
    const text = skills[0]!.content
    expect(text).toContain("## Cost")
    expect(text).toContain('boxd_sleep({ select: "finished" })')
    expect(text).toContain('boxd_drop({ select: "saved-finished" })')
    expect(text).toContain('`automation: "on"`')
    expect(text).toContain("/boxd-cleanup")
  })

  test("is under 100 lines", async () => {
    const { skills } = await loadSkills()
    expect(skills[0]!.content.split("\n").length).toBeLessThan(100)
  })

  test("a file without frontmatter, or with another name, is SKILLS_INVALID", () => {
    expect(() => parseSkill("boxd-sessions", "/x", "no frontmatter")).toThrow(/^SKILLS_INVALID: /)
    expect(() => parseSkill("boxd-sessions", "/x", "---\nname: other\ndescription: x\n---\nbody")).toThrow(/^SKILLS_INVALID: /)
  })

  test("a missing file is reported as a problem, not thrown, so status can say so", async () => {
    const empty = await mkdtemp(join(tmpdir(), "boxd-skills-"))
    const { skills, problems } = await loadSkills(empty)
    expect(skills).toEqual([])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toStartWith("SKILLS_INVALID: ")
    expect(problems[0]).toContain("Next step: ")
  })

  test("a directory with the skill in it loads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "boxd-skills-"))
    await mkdir(join(dir, "boxd-sessions"), { recursive: true })
    await writeFile(join(dir, "boxd-sessions", "SKILL.md"), "---\nname: boxd-sessions\ndescription: A host test skill.\n---\nBody.\n")
    const { skills, problems } = await loadSkills(dir)
    expect(problems).toEqual([])
    expect(String(skills[0]!.description)).toBe("A host test skill.")
  })
})
