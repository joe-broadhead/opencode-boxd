import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { DISPLAY_NAME, NAMESPACE } from "../../src/constants.js"
import { parseOptions } from "../../src/options.js"
import { ACCESS_VALUES, defaultRules, evaluate } from "../../src/permissions.js"
import { TOOLS } from "../../src/tools.js"
import { SKILL_NAMES } from "../../src/skills.js"
import { ACCESS_CHOICES, settingChoices, type PluginSetting, settingsProblems, settingValueIssue } from "../support/jelly-settings.js"

/**
 * The `jelly` section of package.json, which Jelly reads without loading the plugin. Jelly's agents have no base allow
 * rule, so this plugin's own rules never reach them: Jelly writes each declared "ask" as that tool's default.
 */
type Tool = { name: string; permission: string; effect: "allow" | "ask" | "deny"; readOnly: boolean }
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  files: string[]
  opencode: { vendor?: { id: string; name: string; domain: string }; icons: Array<{ src: string }> }
  jelly: {
    title: string
    summary: string
    icon: string
    tools: Tool[]
    skills: string[]
    rpc: unknown[]
    views: unknown[]
    signIns: unknown[]
    contributes: { homeFeeds: unknown[]; homeWidgets: unknown[]; workKinds: unknown[]; settings: PluginSetting[] }
  }
}
const { jelly } = pkg
const { settings } = jelly.contributes
const byPermission = new Map(jelly.tools.map((tool) => [tool.permission, tool]))

describe("the jelly declaration", () => {
  test("declares every known tool once, with the effect the default rules give it", () => {
    for (const tool of TOOLS) {
      expect(byPermission.get(tool.id)).toMatchObject({ effect: "allow", readOnly: tool.class === "read" })
    }
    expect(jelly.tools).toHaveLength(TOOLS.length)
    expect([...byPermission.keys()].sort()).toEqual(TOOLS.map((tool) => tool.id).sort())
    const rules = [{ action: "*", resource: "*", effect: "allow" as const }, ...defaultRules()]
    for (const tool of jelly.tools) expect([tool.permission, evaluate(rules, tool.permission)]).toEqual([tool.permission, tool.effect])
  })

  test("each tool's name is its Code Mode path, and its permission the host's action", () => {
    for (const tool of jelly.tools) {
      expect(tool.name).toStartWith(`${NAMESPACE}.`)
      expect(tool.name.replaceAll(".", "_")).toBe(tool.permission)
      expect(Object.keys(tool).sort()).toEqual(["effect", "name", "permission", "readOnly"])
    }
  })

  test("uses only the keys Jelly reads: its contracts strip any other", () => {
    expect(Object.keys(jelly).sort()).toEqual(["contributes", "icon", "rpc", "signIns", "skills", "summary", "title", "tools", "views"])
    // The one setting is the family's access option, with the default the plugin ships and Jelly's own words for its
    // three values.
    expect(jelly.contributes).toEqual({
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
    expect(jelly.rpc).toEqual([])
    expect(jelly.views).toEqual([])
  })

  test("the settings follow Jelly's rules for a declared setting", () => {
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
    expect(jelly.title).toBe(DISPLAY_NAME)
    expect([...jelly.skills].sort()).toEqual(readdirSync(new URL("../../skills", import.meta.url)).sort())
    expect(jelly.skills).toEqual([...SKILL_NAMES])
    // The plugin has no sign-in of its own: it runs the user's own boxd CLI.
    expect(jelly.signIns).toEqual([])
    expect(jelly.icon).toBe("assets/icon.svg")
    expect(pkg.opencode.icons[0]?.src).toBe(jelly.icon)
  })

  test("declares the vendor, and the summary states no policy", () => {
    expect(pkg.opencode.vendor).toEqual({ id: "boxd", name: "boxd", domain: "boxd.sh" })
    expect(jelly.summary).toBe("Run an OpenCode session on a private boxd machine and keep the transcript on your laptop.")
    expect(jelly.summary.length).toBeLessThanOrEqual(160)
  })
})
