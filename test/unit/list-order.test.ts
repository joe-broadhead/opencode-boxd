// boxd.works.list's truncation: `workList` sorts newest first before its 50-item cap, and the status read's own order
// is set only by the list path, never by a caller's input.
import { describe, expect, test } from "bun:test"
import { statusInput, workList } from "../../src/fleet/status.js"
import type { WorkBrief } from "../../src/results.js"

const at = (minute: number) => new Date(Date.UTC(2026, 10, 16, 10, minute)).toISOString()

/** 59 idle works a-00…a-58 and one recent z-recent: the newest sorts last by id, first by activity. */
const fleet = (): WorkBrief[] => [
  ...Array.from({ length: 59 }, (_, index) => ({ workId: `a-${String(index).padStart(2, "0")}`, region: null, phase: "idle" as const, outcome: "completed" as const, saved: "fresh" as const, lastActivityAt: at(index) })),
  { workId: "z-recent", region: null, phase: "idle", outcome: "completed", saved: "fresh", lastActivityAt: at(59) },
]

describe("boxd.works.list's truncation", () => {
  test("workList sorts newest first and then caps, so 60 works keep the newest 50", () => {
    const items = workList(fleet()).data.items
    expect(items).toHaveLength(50)
    expect(items[0]?.id).toBe("z-recent")
    // The oldest idle work, a-00, is the one dropped: 60 works, the newest 50 kept.
    expect(items.map((item) => item.id)).not.toContain("a-00")
  })

  test("the internal order is never read from a call's input", () => {
    // A raw call (model or script) builds its status input without it; only the list path sets it.
    expect(statusInput({ view: "all" })).not.toHaveProperty("order")
    expect(statusInput({ view: "all", limit: 300, order: "activity" })).toMatchObject({ order: "activity" })
  })
})
