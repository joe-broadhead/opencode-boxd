// boxd.works.list's own rules, through workList: newest first before the cap, the screen and its order, the id screen,
// a repeated work once, at most 50, and the whole answer inside the declared maxBytes. Each assertion fails when its
// rule is removed.
import { describe, expect, test } from "bun:test"
import { workList } from "../../src/fleet/status.js"
import type { WorkBrief } from "../../src/results.js"

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 20, 9, 0, 0) + minutes * 60_000).toISOString()
const work = (id: string, extra: Partial<WorkBrief> = {}): WorkBrief => ({ workId: id, region: null, phase: "ready", outcome: null, saved: "fresh", lastActivityAt: at(0), ...extra })

describe("workList", () => {
  test("lists newest first by lastActivityAt, before the 50-item cap, so a busy recent work is never dropped", () => {
    const works = [
      work("alpha", { lastActivityAt: at(-30) }),
      work("zulu", { lastActivityAt: at(-1) }),
      work("mike", { lastActivityAt: at(-10) }),
    ]
    expect(workList(works).data.items.map((item) => item.id)).toEqual(["zulu", "mike", "alpha"])
    // More than 50: the cap takes the newest 50, not the first 50 by id.
    const many = Array.from({ length: 60 }, (_, index) => work(`work-${String(index).padStart(2, "0")}`, { lastActivityAt: at(index) }))
    const items = workList(many).data.items
    expect(items).toHaveLength(50)
    expect(items[0]?.id).toBe("work-59")
    expect(items.at(-1)?.id).toBe("work-10")
  })

  test("screens the whole id and text before cutting, and lists a repeated work once", () => {
    // A secret that only appears after the 200-character cut is still caught.
    const text = `${"a".repeat(196)}Password: Ku7pLm2QzR9w`
    expect(workList([{ ...work("straddle"), phase: text as never }]).data.items).toEqual([])
    // An invented credential, never a real one: an id that is a token is left out through the id screen.
    expect(workList([work(["ghp", "A1b2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8"].join("_"))]).data.items).toEqual([])
    expect(workList([work("dup"), work("dup")]).data.items).toHaveLength(1)
  })

  test("keeps the whole answer inside the declared maxBytes", () => {
    const maximal = Array.from({ length: 50 }, (_, index) => work(`w${index}`.padEnd(25, "z"), { lastActivityAt: at(index) }))
    const answer = workList(maximal, "studio-mac", at(0))
    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(65_536)
  })
})
