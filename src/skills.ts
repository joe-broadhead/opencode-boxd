import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Skill, type Plugin } from "@opencode/plugin"
import { BoxdError } from "./errors.js"

const ID = "boxd"

export function skillPath(): string {
  return fileURLToPath(new URL("../skills/boxd/SKILL.md", import.meta.url))
}

export function parseSkill(text: string): { name: string; description: string; content: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"))
  if (!match) throw new BoxdError("SKILL_INVALID", "skills/boxd/SKILL.md has no frontmatter.", "Fix the skill file.")
  const fields = new Map<string, string>()
  for (const line of match[1]!.split("\n")) {
    const field = /^([a-z]+):\s*(.*)$/.exec(line)
    if (field) fields.set(field[1]!, field[2]!.trim())
  }
  const name = fields.get("name")
  const description = fields.get("description")
  if (name !== ID || !description) {
    throw new BoxdError("SKILL_INVALID", "The boxd skill name must be boxd and it needs a description.", "Fix the skill file.")
  }
  return { name, description, content: match[2]!.trimStart() }
}

export async function registerSkills(ctx: { skill: Pick<Plugin.Context["skill"], "transform"> }): Promise<{ dispose(): Promise<void> }> {
  const path = skillPath()
  const skill = parseSkill(readFileSync(path, "utf8"))
  return ctx.skill.transform((editor) => {
    editor.add({
      id: Skill.ID.make(ID),
      name: Skill.Name.make(skill.name),
      description: skill.description,
      path: path as Skill.Info["path"],
      content: skill.content,
      autoinvoke: true,
    })
  })
}
