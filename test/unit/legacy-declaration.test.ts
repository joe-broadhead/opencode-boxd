import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { DISPLAY_NAME, NAMESPACE } from "../../src/constants.js"
import { parseOptions } from "../../src/options.js"
import { ACCESS_VALUES, defaultRules, evaluate } from "../../src/permissions.js"
import { TOOLS } from "../../src/tools.js"
import { SKILL_NAMES } from "../../src/skills.js"
import { declarationProblems } from "../support/jelly-kit.js"
import { ACCESS_CHOICES, settingChoices, type PluginSetting, settingsProblems, settingValueIssue } from "../support/jelly-settings.js"

/**
 * The legacy declaration in package.json (the `jelly` key), which an app reads without loading the plugin. It applies
 * the declared `access` setting from each tool's `readOnly`, so the declaration must name every tool with its true
 * class. The key is kept for 4a and replaced by the `capabilities` manifest in 4b.
 */
type Tool = { name: string; permission: string; effect: "allow" | "ask" | "deny"; readOnly: boolean }
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  files: string[]
  opencode: { vendor?: { id: string; name: string; domain: string; mark?: boolean }; icons: Array<{ src: string }> }
  jelly: {
    title: string
    summary: string
    cost: string
    icon: string
    tools: Tool[]
    skills: string[]
    rpc: unknown[]
    views: unknown[]
    signIns: unknown[]
    contributes: { homeFeeds: unknown[]; homeWidgets: unknown[]; workKinds: unknown[]; settings: PluginSetting[] }
  }
}
const declaration = pkg.jelly
const { settings } = declaration.contributes
const byPermission = new Map(declaration.tools.map((tool) => [tool.permission, tool]))

const ROOT = new URL("../../", import.meta.url)

describe("the legacy declaration", () => {
  test("follows the plugin authors' standard, with the effects the plugin's own default rules give", () => {
    const rules = [{ action: "*", resource: "*", effect: "allow" as const }, ...defaultRules()]
    const registered = TOOLS.map((tool) => tool.id)
    // The copied kit's package-name rule predates the move to the new org; 4b removes the key and the kit with the
    // `capabilities` manifest, so this copy stays byte-identical to the family's.
    expect(declarationProblems(ROOT, { effectOf: (permission) => evaluate(rules, permission), registered }).filter((problem) => !problem.startsWith("the package is named "))).toEqual([])
  })

  test("equals the registry: the thirteen tools in its order, each with its true readOnly (design §3.14)", () => {
    expect(declaration.tools.map((tool) => [tool.permission, tool.readOnly])).toEqual(TOOLS.map((tool) => [tool.id, tool.readOnly]))
    expect(declaration.tools).toHaveLength(13)
    expect(declaration.tools.filter((tool) => tool.readOnly).map((tool) => tool.permission)).toEqual(["boxd_status", "boxd_events_list", "boxd_job", "boxd_read"])
  })

  test("the cost line says what boxd bills, the golden builder, and when automation hibernates (design §3.14, §C.3)", () => {
    expect(declaration.cost).toContain("boxd bills each plugin machine")
    expect(declaration.cost).toContain("boxd_golden and boxd_ensure may make a short-lived builder.")
    // autoSleepMinutes is an option, so the line gives its default, not a fixed time.
    expect(declaration.cost).toContain('At access Allowed, finished works are harvested and hibernated after 10 idle minutes by default; else only with automation "on".')
  })

  test("declares every known tool once, with the effect the default rules give it", () => {
    for (const tool of TOOLS) {
      expect(byPermission.get(tool.id)).toMatchObject({ effect: "allow", readOnly: tool.readOnly })
    }
    expect(declaration.tools).toHaveLength(TOOLS.length)
    expect([...byPermission.keys()].sort()).toEqual(TOOLS.map((tool) => tool.id).sort())
    const rules = [{ action: "*", resource: "*", effect: "allow" as const }, ...defaultRules()]
    for (const tool of declaration.tools) expect([tool.permission, evaluate(rules, tool.permission)]).toEqual([tool.permission, tool.effect])
  })

  test("each tool's name is its Code Mode path, and its permission the host's action", () => {
    for (const tool of declaration.tools) {
      expect(tool.name).toStartWith(`${NAMESPACE}.`)
      expect(tool.name.replaceAll(".", "_")).toBe(tool.permission)
      expect(Object.keys(tool).sort()).toEqual(["effect", "name", "permission", "readOnly"])
    }
  })

  test("uses only the keys the declaration schema reads: its contracts strip any other", () => {
    expect(Object.keys(declaration).sort()).toEqual(["contributes", "cost", "icon", "rpc", "signIns", "skills", "summary", "title", "tools", "views"])
    // The one setting is the family's access option, with the default the plugin ships and the declaration's own words
    // for its three values.
    expect(declaration.contributes).toEqual({
      homeFeeds: [],
      homeWidgets: [],
      workKinds: [],
      settings: [
        {
          key: "access",
          label: "Access",
          type: "string",
          description: "How much the plugin's tools may do. Generates default rules for agents with a base allow rule.",
          choices: ACCESS_CHOICES,
          default: "all",
        },
      ],
    })
    expect(declaration.rpc).toEqual([])
    expect(declaration.views).toEqual([])
  })

  test("the settings follow the declaration's rules for a declared setting", () => {
    expect(settingsProblems(settings)).toEqual([])
  })

  test("the options parser takes every declared access choice, its default included, and refuses a value outside them", () => {
    const access = settings.find((setting) => setting.key === "access")!
    const values = (settingChoices(access) ?? []).map((choice) => choice.value)
    expect(values).toEqual([...ACCESS_VALUES])
    for (const value of values) expect<string>(parseOptions({ access: value }).access).toBe(value)
    expect<string>(parseOptions({}).access).toBe(access.default as string)
    expect(settingValueIssue(access, "write")).not.toBeNull()
    expect(() => parseOptions({ access: "write" })).toThrow("OPTIONS_INVALID")
  })

  test("names every skill the package ships, no sign-in, and the family's icon path", () => {
    expect(declaration.title).toBe(DISPLAY_NAME)
    expect([...declaration.skills].sort()).toEqual(readdirSync(new URL("../../skills", import.meta.url)).sort())
    expect(declaration.skills).toEqual([...SKILL_NAMES])
    // The plugin has no sign-in of its own: it runs the user's own boxd CLI.
    expect(declaration.signIns).toEqual([])
    expect(declaration.icon).toBe("assets/icon.svg")
    expect(pkg.opencode.icons[0]?.src).toBe(declaration.icon)
  })

  test("declares the vendor, and the summary states no policy", () => {
    expect(pkg.opencode.vendor).toEqual({ id: "boxd", name: "boxd", domain: "boxd.sh", mark: true })
    expect(declaration.summary).toBe("Run an OpenCode session on a private boxd machine and bring the transcript back here.")
    expect(declaration.summary.length).toBeLessThanOrEqual(160)
  })
})
