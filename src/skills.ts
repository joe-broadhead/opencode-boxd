import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Skill, type Plugin } from "@opencode/plugin"
import { boxdError } from "./errors.js"

const ID = "boxd"
export const SKILL_NAMES = [ID] as const

const DEFAULT_DIR = fileURLToPath(new URL("../skills", import.meta.url))

export function skillPath(name = ID, directory = DEFAULT_DIR): string {
  return fileURLToPath(new URL(`${name}/SKILL.md`, `file://${directory.replace(/\/*$/, "/")}`))
}

/** A skill file's frontmatter and body; the name must be the skill's id. */
export function parseSkill(name: string, path: string, text: string): Skill.Info {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"))
  if (!match) throw boxdError("SKILLS_INVALID", `${name}'s skill file has no frontmatter.`)
  const fields = new Map<string, string>()
  for (const line of match[1]!.split("\n")) {
    const field = /^([a-z]+):\s*(.*)$/.exec(line)
    if (field) fields.set(field[1]!, field[2]!.trim())
  }
  const declared = fields.get("name")
  const description = fields.get("description")
  if (declared !== name || !description) throw boxdError("SKILLS_INVALID", `The ${name} skill needs the name "${name}" and a description.`)
  return { id: Skill.ID.make(name), name: Skill.Name.make(name), description, path: Skill.Info.fields.path.make(path), content: match[2]!.trimStart() }
}

export async function loadSkills(directory = DEFAULT_DIR): Promise<{ skills: Skill.Info[]; problems: string[] }> {
  const skills: Skill.Info[] = []
  const problems: string[] = []
  for (const name of SKILL_NAMES) {
    const path = skillPath(name, directory)
    try {
      const text = await readFile(path, "utf8").catch(() => {
        throw boxdError("SKILLS_INVALID", `The ${name} skill file is not in the package.`)
      })
      skills.push(parseSkill(name, path, text))
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    }
  }
  return { skills, problems }
}

export function registerSkills(skill: Pick<Plugin.Context["skill"], "transform">, skills: readonly Skill.Info[]) {
  return skill.transform((editor) => {
    for (const info of skills) {
      editor.add({ id: info.id, name: info.name, description: info.description, path: info.path, content: info.content, autoinvoke: true })
    }
  })
}
