import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSkills, parseSkill, skillPath } from "../../src/skills.js"

describe("the boxd skill", () => {
  test("is the one skill, with the name, a description and a body", async () => {
    const { skills, problems } = await loadSkills()
    expect(problems).toEqual([])
    expect(skills).toHaveLength(1)
    const skill = skills[0]!
    expect(String(skill.name)).toBe("boxd")
    expect(String(skill.description).length).toBeGreaterThan(30)
    expect(skill.content.length).toBeGreaterThan(200)
    expect(String(skill.path)).toBe(skillPath())
  })

  test("states the real tool names and parameters, and no tool the plugin does not have", async () => {
    const { skills } = await loadSkills()
    const text = skills[0]!.content
    for (const name of ["boxd_ensure", "boxd_submit", "boxd_job", "boxd_harvest", "boxd_sleep", "boxd_resume", "boxd_image", "boxd_drop", "boxd_status"]) {
      expect(text).toContain(name)
    }
    for (const field of ["workId", "localDirectory", "machine", "name"]) expect(text).toContain(field)
    // No tool this plugin does not have, and no invented command.
    expect(text).not.toMatch(/boxd_(?:create|destroy|list|logs|tail)\b/)
  })

  test("is under 100 lines", async () => {
    const { skills } = await loadSkills()
    expect(skills[0]!.content.split("\n").length).toBeLessThan(100)
  })

  test("a file without frontmatter, or with another name, is SKILLS_INVALID", () => {
    expect(() => parseSkill("boxd", "/x", "no frontmatter")).toThrow(/^SKILLS_INVALID: /)
    expect(() => parseSkill("boxd", "/x", "---\nname: other\ndescription: x\n---\nbody")).toThrow(/^SKILLS_INVALID: /)
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
    await mkdir(join(dir, "boxd"), { recursive: true })
    await writeFile(join(dir, "boxd", "SKILL.md"), "---\nname: boxd\ndescription: A host test skill.\n---\nBody.\n")
    const { skills, problems } = await loadSkills(dir)
    expect(problems).toEqual([])
    expect(String(skills[0]!.description)).toBe("A host test skill.")
  })
})
