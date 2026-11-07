import { describe, expect, test } from "bun:test"
import { defaultRules, evaluate, hasDefaultRules, insertRules, unguardedAgents, type Rule } from "../../src/permissions.js"

const BASE: Rule = { action: "*", resource: "*", effect: "allow" }
const rules = defaultRules()

describe("inserting the default rules", () => {
  test("goes directly after the base allow, so every later rule still wins", () => {
    const permissions: Rule[] = [BASE, { action: "edit", resource: "*", effect: "deny" }]
    expect(insertRules(permissions, rules)).toBe(true)
    expect(permissions[0]).toEqual(BASE)
    expect(permissions.slice(1, 1 + rules.length)).toEqual(rules)
    expect(permissions.at(-1)).toEqual({ action: "edit", resource: "*", effect: "deny" })
    expect(hasDefaultRules(permissions)).toBe(true)
  })

  test("replays without appending a second block", () => {
    const permissions: Rule[] = [BASE]
    insertRules(permissions, rules)
    const once = [...permissions]
    expect(insertRules(permissions, rules)).toBe(false)
    expect(permissions).toEqual(once)
  })

  test("leaves an agent without a base allow alone: there the ask would loosen a default deny", () => {
    const permissions: Rule[] = [{ action: "boxd_*", resource: "*", effect: "deny" }]
    expect(insertRules(permissions, rules)).toBe(false)
    expect(permissions).toEqual([{ action: "boxd_*", resource: "*", effect: "deny" }])
  })

  test("recognises the block wherever it sits after the base allow, since other plugins insert there too", () => {
    const other: Rule[] = [{ action: "linear_*", resource: "*", effect: "ask" }]
    const permissions: Rule[] = [BASE, ...other, ...rules, { action: "boxd_drop", resource: "*", effect: "deny" }]
    expect(hasDefaultRules(permissions)).toBe(true)
    expect(insertRules(permissions, rules)).toBe(false)
    // The user's later deny still wins over the block's ask.
    expect(evaluate(permissions, "boxd_drop")).toBe("deny")
  })

  test("does not count a partial block as guarded", () => {
    expect(hasDefaultRules([BASE, ...rules.slice(0, 2)])).toBe(false)
  })
})

describe("the host's evaluation", () => {
  test("the last matching rule wins, and no match asks", () => {
    expect(evaluate([BASE, ...rules], "boxd_status")).toBe("allow")
    expect(evaluate([BASE, ...rules], "boxd_drop")).toBe("ask")
    expect(evaluate([BASE, ...rules], "boxd_something_new")).toBe("ask")
    expect(evaluate([], "boxd_status")).toBe("ask")
    expect(evaluate([BASE], "boxd_status")).toBe("allow")
  })
})

describe("unguarded agents", () => {
  test("names an agent with a base allow and no block, and not one the rules already stop", () => {
    const agents: { id: string; permissions: Rule[] }[] = [
      { id: "build", permissions: [BASE] },
      { id: "guarded", permissions: [BASE, ...rules] },
      { id: "locked", permissions: [BASE, { action: "boxd_*", resource: "*", effect: "deny" }] },
      { id: "strict", permissions: [{ action: "*", resource: "*", effect: "deny" }] },
      { id: "careful", permissions: [BASE, { action: "boxd_*", resource: "*", effect: "ask" }] },
    ]
    expect(unguardedAgents(agents)).toEqual(["build"])
  })

  test("is empty when every agent carries the block", () => {
    expect(unguardedAgents([{ id: "build", permissions: [BASE, ...rules] }])).toEqual([])
  })
})
