// The spawn-count harness's interface: how a fake binary names a spawn's verb, and how a call's counts are checked
// against its row of the budget (design §4.4).
import { describe, expect, test } from "bun:test"
import { budgetProblems, SPAWN_BUDGETS, verbOf } from "../support/spawn-count.js"
import { TOOLS } from "../../src/tools.js"

describe("the spawn budget", () => {
  test("names each verb from its argv, flags and values aside", () => {
    expect(verbOf("boxd", ["machine", "list", "--region", "all", "--json"])).toBe("machine list")
    expect(verbOf("boxd", ["machine", "exec", "oc-a", "--region", "fra", "--timeout", "8", "--", "python3"])).toBe("machine exec")
    expect(verbOf("boxd", ["manage", "machine-limit", "--json"])).toBe("manage machine-limit")
    expect(verbOf("boxd", ["--help"])).toBe("help")
    expect(verbOf("boxd", ["auth", "login"])).toBe("other")
    expect(verbOf("opencode", ["session", "delete", "ses_a", "--standalone"])).toBe("opencode session delete")
    expect(verbOf("opencode", ["session", "import", "/x.json", "--directory", "/w", "--standalone"])).toBe("opencode session import")
  })

  test("every row is a real tool, and each row's verbs add up to no more than its total", () => {
    const ids = new Set(TOOLS.map((tool) => tool.id))
    for (const row of SPAWN_BUDGETS) {
      expect(ids.has(row.call as never)).toBe(true)
      expect(Object.values(row.max).reduce((sum, value) => sum + (value ?? 0), 0)).toBeGreaterThanOrEqual(row.total)
    }
  })

  test("a call within its row passes; a verb over its maximum, an unlisted verb or a total over the row each fail", () => {
    const row = SPAWN_BUDGETS.find((entry) => entry.call === "boxd_submit")!
    expect(budgetProblems(row, { "machine list": 1, "machine get": 1, "machine exec": 1, help: 1 })).toEqual([])
    expect(budgetProblems(row, { "machine exec": 2 })).toEqual(["boxd_submit (a running work, no files) ran machine exec 2 times; its budget is 1"])
    expect(budgetProblems(row, { "machine new": 1 })).toEqual(["boxd_submit (a running work, no files) ran machine new 1 times; its budget is 0"])
    const status = SPAWN_BUDGETS.find((entry) => entry.call === "boxd_status")!
    expect(budgetProblems({ ...status, total: 1 }, { "machine list": 1, "manage machine-limit": 1 })).toEqual([
      "boxd_status (170 open works, none busy, machine limit cached) started 2 children; its budget is 1",
    ])
  })
})
