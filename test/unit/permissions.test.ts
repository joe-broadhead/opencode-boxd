import { describe, expect, test } from "bun:test"
import { ACCESS_VALUES, defaultRules, evaluate, hasDefaultRules, insertRules, unguardedAgents, type Access, type Rule } from "../../src/permissions.js"
import { TOOLS } from "../../src/tools.js"

const BASE: Rule = { action: "*", resource: "*", effect: "allow" }
const all = defaultRules()

describe("the generated default rules", () => {
  test("allow every tool and the namespace pattern by default", () => {
    expect(all[0]).toEqual({ action: "boxd_*", resource: "*", effect: "allow" })
    for (const tool of TOOLS) expect(all).toContainEqual({ action: tool.id, resource: "*", effect: "allow" })
    // The pattern is what a tool a later release adds inherits.
    expect(all).toHaveLength(1 + TOOLS.length)
  })

  test("ask-changes asks for every tool that changes something and allows the reads", () => {
    const rules = defaultRules("ask-changes")
    expect(rules[0]).toEqual({ action: "boxd_*", resource: "*", effect: "allow" })
    for (const tool of TOOLS) expect(rules).toContainEqual({ action: tool.id, resource: "*", effect: tool.class === "read" ? "allow" : "ask" })
  })

  test("read-only denies every tool that changes something and allows the reads", () => {
    const rules = defaultRules("read-only")
    for (const tool of TOOLS) expect(rules).toContainEqual({ action: tool.id, resource: "*", effect: tool.class === "read" ? "allow" : "deny" })
  })

  test("every access value generates a block", () => {
    expect(ACCESS_VALUES).toEqual(["all", "ask-changes", "read-only"])
    for (const access of ACCESS_VALUES) expect(defaultRules(access).length).toBe(1 + TOOLS.length)
  })
})

describe("inserting the default rules", () => {
  test("goes directly after the base allow, so every later rule still wins", () => {
    const permissions: Rule[] = [BASE, { action: "edit", resource: "*", effect: "deny" }]
    expect(insertRules(permissions, all)).toBe(true)
    expect(permissions[0]).toEqual(BASE)
    expect(permissions.slice(1, 1 + all.length)).toEqual(all)
    expect(permissions.at(-1)).toEqual({ action: "edit", resource: "*", effect: "deny" })
    expect(hasDefaultRules(permissions)).toBe(true)
  })

  test("replays without appending a second block", () => {
    const permissions: Rule[] = [BASE]
    insertRules(permissions, all)
    const once = [...permissions]
    expect(insertRules(permissions, all)).toBe(false)
    expect(permissions).toEqual(once)
  })

  test("replaces a block for another access value, so switching the option never stacks two", () => {
    const permissions: Rule[] = [BASE]
    insertRules(permissions, defaultRules("all"), "all")
    insertRules(permissions, defaultRules("read-only"), "read-only")
    expect(permissions.filter((rule) => rule.action === "boxd_*")).toHaveLength(1)
    expect(hasDefaultRules(permissions, "read-only")).toBe(true)
    expect(hasDefaultRules(permissions, "all")).toBe(false)
    expect(evaluate(permissions, "boxd_drop")).toBe("deny")
  })

  test("leaves an agent without a base allow alone: a block there would loosen a default deny", () => {
    const permissions: Rule[] = [{ action: "boxd_*", resource: "*", effect: "deny" }]
    expect(insertRules(permissions, all)).toBe(false)
    expect(permissions).toEqual([{ action: "boxd_*", resource: "*", effect: "deny" }])
  })

  test("recognises the block wherever it sits after the base allow, since other plugins insert there too", () => {
    const other: Rule[] = [{ action: "linear_*", resource: "*", effect: "ask" }]
    const permissions: Rule[] = [BASE, ...other, ...all, { action: "boxd_drop", resource: "*", effect: "deny" }]
    expect(hasDefaultRules(permissions)).toBe(true)
    expect(insertRules(permissions, all)).toBe(false)
    // The user's later deny still wins over the block's allow.
    expect(evaluate(permissions, "boxd_drop")).toBe("deny")
  })

  test("does not count a partial block as guarded", () => {
    expect(hasDefaultRules([BASE, ...all.slice(0, 2)])).toBe(false)
  })
})

describe("the host's evaluation", () => {
  test("the last matching rule wins, and no match asks", () => {
    expect(evaluate([BASE, ...all], "boxd_status")).toBe("allow")
    expect(evaluate([BASE, ...all], "boxd_drop")).toBe("allow")
    expect(evaluate([BASE, ...all], "boxd_something_new")).toBe("allow")
    expect(evaluate([BASE, ...defaultRules("read-only")], "boxd_drop")).toBe("deny")
    expect(evaluate([BASE, ...defaultRules("ask-changes")], "boxd_drop")).toBe("ask")
    expect(evaluate([], "boxd_status")).toBe("ask")
    expect(evaluate([BASE], "boxd_status")).toBe("allow")
  })
})

describe("unguarded agents", () => {
  test("names an agent with a base allow and no block, and not one the rules already stop", () => {
    const agents: { id: string; permissions: Rule[] }[] = [
      { id: "build", permissions: [BASE] },
      { id: "guarded", permissions: [BASE, ...all] },
      { id: "locked", permissions: [BASE, { action: "boxd_*", resource: "*", effect: "deny" }] },
      { id: "strict", permissions: [{ action: "*", resource: "*", effect: "deny" }] },
      { id: "careful", permissions: [BASE, { action: "boxd_*", resource: "*", effect: "ask" }] },
    ]
    expect(unguardedAgents(agents)).toEqual(["build"])
  })

  test("asks for the block of the access value in force", () => {
    const agents: { id: string; permissions: Rule[] }[] = [{ id: "build", permissions: [BASE, ...defaultRules("read-only")] }]
    expect(unguardedAgents(agents, "read-only" as Access)).toEqual([])
    expect(unguardedAgents(agents, "all")).toEqual(["build"])
  })
})
