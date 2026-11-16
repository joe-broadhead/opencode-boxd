// The TUI's rendering of package E's cleanup view (design §C.5): counts, costs, ids and phases, and how each action is
// confirmed; it approves nothing, and a read-only view says it only reports.
import { describe, expect, test } from "bun:test"
import type { CleanupView } from "../../src/services.js"
import { cleanupText } from "../../src/tui.js"

const view = (over: Partial<CleanupView> = {}): CleanupView => ({
  state: "ok",
  currency: "EUR",
  perHour: 0.41,
  works: [{ workId: "db-mig", phase: "idle", saved: "stale", perHour: 0.038, idleMinutes: 42 }],
  actions: [{ action: "sleep", select: "finished", works: 9, savesPerHour: 0.33, call: 'boxd_sleep({ select: "finished" })' }],
  automation: "off (access)",
  confirm: "cleanup-action",
  command: "/boxd-cleanup",
  ...over,
})

describe("the cleanup view in the TUI", () => {
  test("names the running works and the actions with their savings, and says each action asks", () => {
    expect(cleanupText(view())).toBe(
      [
        "Running now: ~€0.41/h (an estimate); automation: off (access)",
        "- db-mig: idle, not saved, €0.04/h, idle 42 min",
        "",
        "Cleanup actions:",
        "- sleep 9 works (finished), saves ~€0.33/h",
        "",
        "/boxd-cleanup asks you to confirm each action with a permission prompt.",
      ].join("\n"),
    )
  })

  test("a read-only view only reports, and an unavailable one says why", () => {
    expect(cleanupText(view({ confirm: "report-only" }))).toContain("Access is read-only: /boxd-cleanup only reports.")
    expect(cleanupText(view({ state: "unavailable", note: "the cost service is not built" }))).toBe("The cleanup view is not available: the cost service is not built.")
  })
})
