// boxd.works.list's truncation: the status read is asked for its own bound and newest-activity order, so the 50-item
// and byte caps fall after the sort. This fails on the code that asked status for `{ view: "all", limit: 50 }`, which
// truncated by id before the list ever sorted, and the order test fails when the sort is removed.
import { describe, expect, test } from "bun:test"
import { statusInput, workList } from "../../src/fleet/status.js"
import { ownedMethods, type CallContext } from "../../src/tools.js"
import type { WorkBrief } from "../../src/results.js"
import { localIdentity } from "../../src/sources.js"

const call = () => ({ sessionID: "ses_list", agent: "build", messageID: "msg_list", id: "call_list", signal: new AbortController().signal } as CallContext)
const at = (minute: number) => new Date(Date.UTC(2026, 10, 16, 10, minute)).toISOString()

/** 59 idle works a-00…a-58 and one recent z-recent: the newest sorts last by id, first by activity. */
const fleet = (): WorkBrief[] => [
  ...Array.from({ length: 59 }, (_, index) => ({ workId: `a-${String(index).padStart(2, "0")}`, region: null, phase: "idle" as const, outcome: "completed" as const, saved: "fresh" as const, lastActivityAt: at(index) })),
  { workId: "z-recent", region: null, phase: "idle", outcome: "completed", saved: "fresh", lastActivityAt: at(59) },
]

describe("boxd.works.list's truncation", () => {
  test("the status read is asked for its own bound, newest-activity order, so its cap cannot drop the newest work", async () => {
    const asked: Record<string, unknown>[] = []
    // The status read, as fleetStatus behaves: it sorts by id and cuts to `limit`. With the old `limit: 50` this drops
    // z-recent before the list ever sees it.
    const runs = {
      boxd_status: async (input: Record<string, unknown>) => {
        asked.push(input)
        const limit = Number(input["limit"] ?? 25)
        const ordered = input["order"] === "activity" ? [...fleet()].sort((a, b) => (Date.parse(b.lastActivityAt!) - Date.parse(a.lastActivityAt!))) : [...fleet()].sort((a, b) => a.workId.localeCompare(b.workId))
        return { works: ordered.slice(0, limit), asOf: at(59) }
      },
      boxd_job: async () => ({}),
    }
    const method = ownedMethods({ runs: runs as never, selectors: {} as never }, async () => {}).find((entry) => entry.name === "boxd_status")!
    const answer = (await method.run({ list: "works", account: localIdentity().account }, call() as never)) as { data: { items: { id: string }[] } }
    // The read asked for the status's own bound and the activity order, not 50 by id.
    expect(asked).toEqual([{ view: "all", limit: 300, order: "activity" }])
    expect(answer.data.items[0]?.id).toBe("z-recent")
    expect(answer.data.items).toHaveLength(50)
    expect(answer.data.items.map((item) => item.id)).toContain("z-recent")
  })

  test("workList sorts newest first and then caps, so 60 works keep the newest 50", () => {
    const items = workList(fleet(), "studio-mac").data.items
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
