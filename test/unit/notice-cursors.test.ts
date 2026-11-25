// #46: a work-change notice reaches a coordinator exactly once. `NoticeQueue` keeps a durable high-water mark per
// subscriber, the highest event sequence a delivered notice covered: a replay, a restart or a re-sweep at or below it
// posts nothing; a new event above it posts once; a refused post is never marked delivered; two subscribers keep
// independent cursors; and a notice that coalesces several changes advances past all of them.
import { afterEach, describe, expect, test } from "bun:test"
import { FileNoticeCursors } from "../../src/notice-cursors.js"
import { NoticeQueue } from "../../src/notices.js"
import type { WorkEvent } from "../../src/ports.js"
import { removeRoot, tempRoot } from "../support/ledger-fakes.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) removeRoot(root)
})

const event = (seq: number, workId: string, over: Partial<WorkEvent> = {}): WorkEvent => ({
  seq,
  at: "2026-11-16T10:00:00.000Z",
  workId,
  from: "busy",
  to: "idle",
  outcome: "completed",
  ...over,
})

interface Posted {
  readonly sessionID: string
  readonly text: string
  readonly resume: boolean
}

interface Options {
  readonly mode?: "wake" | "queue"
  readonly root?: string
  readonly get?: (input: { sessionID: string }) => Promise<unknown>
  readonly synthetic?: (input: { sessionID: string; text: string; resume?: boolean }) => Promise<unknown>
}

/** A queue over its own temp store, or over `root` to act as a restart over the same store. */
function harness(options: Options = {}) {
  const root = options.root ?? tempRoot("boxd-notice-cursors-")
  if (!options.root) roots.push(root)
  const posted: Posted[] = []
  const unsubscribed: string[] = []
  const clock = { at: 1_000_000 }
  const notices = new NoticeQueue({
    mode: () => options.mode ?? "queue",
    now: () => new Date(clock.at),
    cursors: new FileNoticeCursors(root),
    unsubscribe: async (session) => void unsubscribed.push(session),
    sessions: {
      get: (options.get ?? (async () => ({ id: "ses_ok", time: { created: 1, updated: 1 } }))) as never,
      synthetic: (options.synthetic ??
        (async (input: { sessionID: string; text: string; resume?: boolean }) => {
          posted.push({ sessionID: input.sessionID, text: input.text, resume: input.resume === true })
        })) as never,
    },
  })
  return { root, notices, posted, unsubscribed, clock }
}

const texts = (posted: readonly Posted[]) => posted.map((item) => item.text)
const notFound = () => Object.assign(new Error(""), { name: "Session.NotFoundError", _tag: "Session.NotFoundError" })

describe("a durable cursor per subscriber", () => {
  test("one delivery per event, and a replay from a new queue over the same store posts nothing", async () => {
    const first = harness()
    first.notices.enqueue(event(5, "review-api"), "ses_a", "none")
    await first.notices.flushDue()
    expect(texts(first.posted)).toEqual(["boxd: 1 work changed — review-api idle (completed, not saved). boxd_status({ since: 4 }) has the details."])
    // The same event again, in the same queue and in a queue created over the saved cursor: nothing.
    first.notices.enqueue(event(5, "review-api"), "ses_a", "none")
    await first.notices.flushDue()
    expect(first.posted).toHaveLength(1)
    await first.notices.stop()

    const again = harness({ root: first.root })
    again.notices.enqueue(event(5, "review-api"), "ses_a", "none")
    await again.notices.flushDue()
    expect(again.posted).toEqual([])
    await again.notices.stop()
  })

  test("a new event above the cursor posts once, pointing past the delivered sequences", async () => {
    const first = harness()
    first.notices.enqueue(event(5, "review-api"), "ses_a", "none")
    await first.notices.flushDue()
    await first.notices.stop()

    const again = harness({ root: first.root })
    again.notices.enqueue(event(6, "review-api", { to: "ready", outcome: undefined }), "ses_a", "none")
    await again.notices.flushDue()
    expect(texts(again.posted)).toEqual(["boxd: 1 work changed — review-api ready. boxd_status({ since: 5 }) has the details."])
    again.notices.enqueue(event(6, "review-api", { to: "ready", outcome: undefined }), "ses_a", "none")
    await again.notices.flushDue()
    expect(again.posted).toHaveLength(1)
    await again.notices.stop()
  })

  test("a post the host refuses is retried, not marked delivered", async () => {
    const refusing = harness({
      mode: "wake",
      synthetic: async () => {
        throw new Error("conflict")
      },
    })
    refusing.notices.enqueue(event(5, "review-api"), "ses_a", "none")
    await refusing.notices.flushDue()
    expect(refusing.posted).toEqual([])
    expect(refusing.notices.dropped()).toMatchObject([{ session: "ses_a", dropped: "the host refused the notice twice" }])
    expect(await new FileNoticeCursors(refusing.root).covered("ses_a")).toBe(0)
    await refusing.notices.stop()

    // Nothing was recorded as delivered, so a queue that can post still delivers the same change once.
    const later = harness({ mode: "queue", root: refusing.root })
    later.notices.enqueue(event(5, "review-api"), "ses_a", "none")
    await later.notices.flushDue()
    expect(later.posted).toHaveLength(1)
    await later.notices.stop()
  })

  test("a refused wake that succeeds as queue only counts as delivered", async () => {
    const first = harness({
      mode: "wake",
      synthetic: async (input) => {
        if (input.resume) throw new Error("conflict")
        return {}
      },
    })
    first.notices.enqueue(event(5, "review-api"), "ses_a", "none")
    await first.notices.flushDue()
    expect(first.posted).toEqual([])
    expect(await new FileNoticeCursors(first.root).covered("ses_a")).toBe(5)
    await first.notices.stop()

    // Delivered by the queue-only fallback: a restart does not repeat it.
    const again = harness({ root: first.root, synthetic: async (input) => void first.posted.push({ sessionID: input.sessionID, text: input.text, resume: input.resume === true }) })
    again.notices.enqueue(event(5, "review-api"), "ses_a", "none")
    await again.notices.flushDue()
    expect(first.posted).toEqual([])
    await again.notices.stop()
  })

  test("two subscribers for one change keep independent cursors", async () => {
    const first = harness()
    first.notices.enqueue(event(5, "review-api"), "ses_a", "none")
    await first.notices.flushDue()
    expect(first.posted.map((item) => item.sessionID)).toEqual(["ses_a"])
    // The second subscriber's own cursor is still empty, so the same change reaches it.
    first.notices.enqueue(event(5, "review-api"), "ses_b", "none")
    await first.notices.flushDue()
    expect(first.posted.map((item) => item.sessionID)).toEqual(["ses_a", "ses_b"])
    await first.notices.stop()

    const again = harness({ root: first.root })
    again.notices.enqueue(event(5, "review-api"), "ses_a", "none")
    again.notices.enqueue(event(5, "review-api"), "ses_b", "none")
    await again.notices.flushDue()
    expect(again.posted).toEqual([])
    await again.notices.stop()
  })

  test("a notice covering several sequences advances past all of them", async () => {
    const first = harness()
    first.notices.enqueue(event(5, "review-api"), "ses_a", "none")
    first.notices.enqueue(event(9, "review-api", { to: "asleep", outcome: undefined, asleepBy: "boxd_sleep" }), "ses_a", "none")
    await first.notices.flushDue()
    expect(texts(first.posted)).toEqual(["boxd: 1 work changed — review-api asleep (boxd_sleep). boxd_status({ since: 4 }) has the details."])
    expect(await new FileNoticeCursors(first.root).covered("ses_a")).toBe(9)
    await first.notices.stop()

    const again = harness({ root: first.root })
    // A sequence inside the delivered span, and the next one after it.
    again.notices.enqueue(event(7, "review-api", { to: "busy", outcome: undefined }), "ses_a", "none")
    await again.notices.flushDue()
    expect(again.posted).toEqual([])
    again.notices.enqueue(event(10, "review-api", { to: "ready", outcome: undefined }), "ses_a", "none")
    await again.notices.flushDue()
    expect(texts(again.posted)).toEqual(["boxd: 1 work changed — review-api ready. boxd_status({ since: 9 }) has the details."])
    await again.notices.stop()
  })

  test("a target that goes away is unsubscribed and does not poison the others", async () => {
    const first = harness({
      get: async (input) => {
        if (input.sessionID === "ses_gone") throw notFound()
        return { id: input.sessionID, time: { created: 1, updated: 1 } }
      },
    })
    first.notices.enqueue(event(5, "gone-work"), "ses_gone", "none")
    first.notices.enqueue(event(6, "live-work"), "ses_live", "none")
    await first.notices.flushDue()
    expect(first.posted.map((item) => item.sessionID)).toEqual(["ses_live"])
    expect(first.unsubscribed).toEqual(["ses_gone"])
    expect(first.notices.dropped()).toMatchObject([{ session: "ses_gone", dropped: "the session is gone" }])
    const store = new FileNoticeCursors(first.root)
    expect(await store.covered("ses_gone")).toBe(0)
    expect(await store.covered("ses_live")).toBe(6)
    await first.notices.stop()
  })

  test("the since cursor never points behind a sequence another notice already covered", async () => {
    const first = harness()
    first.notices.enqueue(event(5, "review-api"), "ses_a", "none")
    await first.notices.flushDue()
    await first.notices.stop()

    // A second process delivered up to 8, while this queue still holds the older anchor 5 and a newer change 9.
    const shared = new FileNoticeCursors(first.root)
    await shared.advance("ses_a", 8)
    const again = harness({ root: first.root })
    again.notices.enqueue(event(5, "review-api"), "ses_a", "none")
    again.notices.enqueue(event(9, "review-api", { to: "ready", outcome: undefined }), "ses_a", "none")
    await again.notices.flushDue()
    expect(texts(again.posted)).toEqual(["boxd: 1 work changed — review-api ready. boxd_status({ since: 8 }) has the details."])
    await again.notices.stop()
  })
})
