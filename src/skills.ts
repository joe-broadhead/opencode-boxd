/**
 * The plugin's skills, read from `skills/<name>/SKILL.md` and registered with the host.
 *
 * OpenCode does not discover a plugin's `skills/` directory: the installed package sits under the host's cache, outside
 * the directories it scans. A plugin adds its skills through `ctx.skill.transform`, so setup reads every file, checks
 * its frontmatter and registers the body under the directory's name.
 */
import { readdirSync, readFileSync, type Dirent } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Skill, type Plugin } from "@opencode/plugin"
import { parse as parseYaml } from "yaml"
import { boxdError } from "./errors.js"

/** One checked skill, ready to register. */
export interface SkillFile {
  /** The skill id: the directory name, and the frontmatter name. */
  readonly id: string
  readonly name: string
  readonly description: string
  /** The absolute path of the SKILL.md file. */
  readonly path: string
  /** The Markdown body below the frontmatter, with no frontmatter. */
  readonly content: string
}

/** The installed package's `skills/` directory, from `src/skills.ts` and from the bundled `dist/index.js`. */
const SKILLS = fileURLToPath(new URL("../skills/", import.meta.url))

/** A failure the plugin's code table can read: the file, what is wrong with it and the next step. */
function invalid(file: string, what: string): Error {
  return boxdError("SKILLS_INVALID", `${file} ${what}. Fix the skill file, then reload the plugin.`)
}

interface Frontmatter {
  readonly name: string | undefined
  readonly description: string | undefined
  readonly content: string
}

/**
 * The frontmatter fields this plugin checks and the Markdown body. The frontmatter is parsed as YAML, so `>` , `|`
 * and their chomping variants fold or keep the description exactly as the skill author wrote it; a parser that reads
 * only the first line would register `>` as the description.
 */
function frontmatter(text: string, file: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (match === null) throw invalid(file, "has no frontmatter")
  let data: unknown
  try {
    data = parseYaml(match[1] ?? "")
  } catch (cause) {
    const message = cause instanceof Error ? cause.message.split("\n")[0] : String(cause)
    throw invalid(file, `has frontmatter that is not valid YAML: ${message}`)
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw invalid(file, "has frontmatter that is not a mapping")
  const fields = data as Record<string, unknown>
  if (fields.name !== undefined && typeof fields.name !== "string") throw invalid(file, "has a frontmatter name that is not text")
  if (fields.description !== undefined && typeof fields.description !== "string") throw invalid(file, "has a frontmatter description that is not text")
  return {
    name: fields.name,
    description: fields.description,
    content: text.slice(match[0].length).trim(),
  }
}

/** Read and check every `skills/<name>/SKILL.md` below `directory`, sorted by id. */
export function readSkills(directory = SKILLS): SkillFile[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    throw invalid("skills/", "is missing")
  }
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  if (names.length === 0) throw invalid("skills/", "holds no <name>/SKILL.md")
  return names.map((name) => {
    const file = `skills/${name}/SKILL.md`
    let text: string
    try {
      text = readFileSync(join(directory, name, "SKILL.md"), "utf8")
    } catch {
      throw invalid(file, "is missing")
    }
    const parsed = frontmatter(text, file)
    if (parsed.name === undefined || parsed.name === "") throw invalid(file, "has no frontmatter name")
    if (parsed.name !== name) throw invalid(file, `names "${parsed.name}", not its directory "${name}"`)
    if (parsed.description === undefined || parsed.description.trim() === "") throw invalid(file, "has no frontmatter description")
    if ([">", "|", ">-", "|-", ">+", "|+"].includes(parsed.description.trim())) {
      throw invalid(file, `has the frontmatter description "${parsed.description.trim()}", which is only a block marker; indent the text below it`)
    }
    if (parsed.content === "") throw invalid(file, "has no content below its frontmatter")
    return { id: name, name: parsed.name, description: parsed.description, path: join(directory, name, "SKILL.md"), content: parsed.content }
  })
}

/**
 * Register the checked skills with the host. The transform's `dispose` is the setup cleanup, like every other
 * registration. A plugin that adds a skill directory calls this once, from `setup`.
 */
export async function registerSkills(
  context: Plugin.Context,
  skills: readonly SkillFile[] = readSkills(),
): Promise<Awaited<ReturnType<Plugin.Context["skill"]["transform"]>>> {
  return context.skill.transform((editor) => {
    for (const skill of skills) {
      editor.add({
        id: Skill.ID.make(skill.id),
        name: Skill.Name.make(skill.name),
        description: skill.description,
        path: skill.path as Skill.Info["path"],
        content: skill.content,
      })
    }
  })
}
