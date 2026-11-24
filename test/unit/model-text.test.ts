// What the model reads says what the default does. Every tool is allowed under `access: "all"`, so no text the
// model sees may say a tool asks first, is read-only, needs an option turned on, or is off until it is classified. A
// sentence that names `ask-changes` or `read-only` describes that value, not the default.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildStatus, formatStatus, type Status } from "../../src/status.js"
import { TOOLS } from "../../src/tools.js"
import { statusFacts } from "../support/fleet.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

/** A claim that is false under the default block: a tool cannot ask, be refused or be off, because every tool allows. */
const STALE: [string, RegExp][] = [
  // Case-sensitive "asks": the imperative "Ask the user before …" is guidance to the model, not a claim about a rule.
  ["says a change asks", /\b(?:every|each) (?:machine )?change asks\b/],
  ["says a tool asks first", /\basks (?:the user )?(?:first|before)\b/],
  ["needs an option turned on", /\bneeds? (?:the (?:plugin )?)?option\b/i],
  ["is off until classified", /\b(?:off|asks?) until (?:it is |they are )?classif/i],
  ["says it is read-only now", /\bread-only now\b/i],
  ["is refused while read-only", /\brefused while (?:the plugin is )?read-only\b/i],
  ["says the writes are off", /\b(?:the )?(?:machine )?changes? (?:are|stay) off\b/i],
]

/** A sentence that names a restricting value describes that value, not the default. */
const atAll = (text: string) =>
  text
    .split(/(?<=[.:])\s+/)
    .filter((sentence) => !/(?:ask-changes|read-only)/.test(sentence))
    .join(" ")

const jellySummary = () => (JSON.parse(read("package.json")) as { jelly?: { summary?: string } }).jelly?.summary ?? ""

/** The status a person reads with the default option and the block in place, and one tool this version does not know. */
const defaultStatus = (): Status => buildStatus(statusFacts({ tools: [...TOOLS.map((tool) => tool.id), "shiny_new_tool"] }))

describe("the model-facing text at access all", () => {
  const all = {
    "the Jelly summary": jellySummary(),
    "the /boxd-status text": formatStatus(defaultStatus()),
    "the boxd-sessions skill": read("skills/boxd-sessions/SKILL.md"),
  }

  test.each(Object.entries(all))("%s claims nothing the default block contradicts", (_file, text) => {
    for (const [claim, pattern] of STALE) expect({ claim, hit: pattern.exec(atAll(text))?.[0] ?? null }).toEqual({ claim, hit: null })
  })

  test("status says every tool is allowed, and that an unknown tool runs too", () => {
    const text = formatStatus(defaultStatus())
    expect(text).toContain("every tool is allowed without asking")
    expect(text).toContain("unknown tools run without asking")
  })
})
