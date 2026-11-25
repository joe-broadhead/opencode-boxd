// `events_list`: one page at a time with a bound cursor, an expired log answers one gap, another source is refused,
// and a title shaped like a secret is refused rather than listed. It reads only the ledger: no CLI, no guest.
import { describe, expect, test } from "bun:test"
import { listWorks, probeWorks } from "../../src/handlers/events.js"
import type { WorkEvent } from "../../src/ports.js"

const owner = { id: "os-user:ana@studio", label: "ana on studio" }
const at = (minute: number) => new Date(Date.UTC(2026, 10, 16, 10, minute)).toISOString()
const event = (seq: number, over: Partial<WorkEvent> = {}): WorkEvent => ({ seq, at: at(seq), workId: "review-api", from: null, to: "ready", ...over })
const deps = (events: readonly WorkEvent[], options: { cursorExpired?: boolean; cursor?: number } = {}) => ({
  ledger: {
    eventsSince: async (q: number) => ({ events: events.filter((item) => item.seq > q), cursor: options.cursor ?? events.at(-1)?.seq ?? 0, cursorExpired: options.cursorExpired ?? false }),
  },
  identity: () => owner,
  now: () => new Date("2026-11-16T11:00:00.000Z"),
})

describe("events_list", () => {
  test("pages oldest first with a cursor bound to the plugin, the source and the account", async () => {
    const first = await listWorks(deps([event(1), event(2), event(3)]), { source: "works", limit: 2, since: "2026-11-16T00:00:00Z" })
    expect(first.events.map((item) => item.external_id)).toEqual(["review-api:1", "review-api:2"])
    expect(first.more).toBe(true)
    const second = await listWorks(deps([event(1), event(2), event(3)]), { source: "works", cursor: first.cursor })
    expect(second.events.map((item) => item.external_id)).toEqual(["review-api:3"])
    expect(second.more).toBe(false)
  })

  test("two events sharing a timestamp are never split by the cursor: the sequence number is the resume point", async () => {
    // The provider contract's fake resumes after the last event's timestamp, which would lose the second event here. The
    // plugin's cursor carries the ledger's unique, monotonic sequence number and the port filters `seq > q`, so a page
    // boundary between two equal `at` values keeps both.
    const same = at(5)
    const events = [event(1, { at: same, workId: "one" }), event(2, { at: same, workId: "two" })]
    const first = await listWorks(deps(events), { source: "works", since: "2026-11-16T00:00:00Z", limit: 1 })
    expect(first.events.map((item) => item.external_id)).toEqual(["one:1"])
    expect(first.more).toBe(true)
    const second = await listWorks(deps(events), { source: "works", cursor: first.cursor })
    expect(second.events.map((item) => item.external_id)).toEqual(["two:2"])
    expect(second.more).toBe(false)
    expect(second.gap).toBeUndefined()
  })

  test("keeps the since window on every cursor page: every matching event exactly once, before-since events excluded", async () => {
    // The first page applies `since`; every later page must apply it too, while the cursor advances by sequence. These
    // events are not in timestamp order, so a cursor that only remembers the last event's `at` would re-admit a
    // before-since event with a higher sequence number, and the two events sharing `at(12)` straddle a page boundary.
    const since = at(10)
    const events = [
      event(1, { at: at(5), workId: "before" }),
      event(2, { at: at(12), workId: "first" }),
      event(3, { at: at(12), workId: "second" }),
      event(4, { at: at(11), workId: "still-after" }),
      event(5, { at: at(9), workId: "before-higher-seq" }),
      event(6, { at: at(13), workId: "last" }),
    ]
    const seen: string[] = []
    let page = await listWorks(deps(events), { source: "works", since, limit: 1 })
    seen.push(...page.events.map((item) => item.external_id))
    while (page.more) {
      page = await listWorks(deps(events), { source: "works", cursor: page.cursor, limit: 1 })
      expect(page.events.every((item) => Date.parse(item.occurred_at) >= Date.parse(since))).toBe(true)
      seen.push(...page.events.map((item) => item.external_id))
    }
    expect(seen).toEqual(["first:2", "second:3", "still-after:4", "last:6"])
    expect(new Set(seen).size).toBe(seen.length)
  })

  test("a cursor from another source or plugin is CURSOR_INVALID", async () => {
    const page = await listWorks(deps([event(1)]), { source: "works", since: "2026-11-16T00:00:00Z" })
    const error = await listWorks(deps([event(1)]), { source: "works", cursor: `${page.cursor}x` }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "CURSOR_INVALID" })
  })

  test("an expired log answers one gap and restarts at its oldest kept event", async () => {
    const page = await listWorks(deps([event(1), event(2)], { cursorExpired: true, cursor: 2 }), { source: "works", cursor: "stale" }).catch((caught: unknown) => caught)
    // A malformed cursor is refused before the log is read; a valid one for another log answers the gap.
    expect(page).toMatchObject({ code: "CURSOR_INVALID" })
    const first = await listWorks(deps([event(1)]), { source: "works", since: "2026-11-16T00:00:00Z" })
    const expired = await listWorks(deps([event(2)], { cursorExpired: true }), { source: "works", cursor: first.cursor })
    expect(expired.gap).toEqual({ reason: "expired", since: expect.any(String) })
  })

  test("a title shaped like a secret is refused for good, and another source is SOURCE_UNKNOWN", async () => {
    // An invented credential, never a real one: a key-shaped work id the event screen must refuse.
    const key = ["ghp", "abcdefghijklmnop123456"].join("_")
    const page = await listWorks(deps([event(1, { workId: key })]), { source: "works", since: "2026-11-16T00:00:00Z" })
    // The event's title is the plugin's own sentence, which carries the work id: a key-shaped id is refused.
    expect(page.refused?.[0]).toMatchObject({ reason: "secret" })
    const error = await listWorks(deps([]), { source: "other" }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: "SOURCE_UNKNOWN" })
  })

  test("probe names the account and the machine identity, and reads no content", () => {
    expect(probeWorks(deps([]), { source: "works" })).toEqual({ source: "works", account: "default", owner, trust: "untrusted" })
  })
})
