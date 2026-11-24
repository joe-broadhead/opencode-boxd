// Package E's session hooks (design §C.4, §7.1): the idle check that never loops, speaks only when money burns and
// automation will not act, and costs one short note; the session events that orphan a coordinator's works. There is no
// per-request hook: cost is read in `boxd_status`, and a change reaches the session as a synthetic notice.
import { afterEach, describe, expect, test } from "bun:test"
import { costHooks, IDLE_TAG, registerCostHooks } from "../../src/hooks.js"
import { fakes, minutesAgo, T0, work, type Fakes } from "../support/cost-fakes.js"

let open: Fakes[] = []
const make = (input: Parameters<typeof fakes>[0] = {}) => {
  const value = fakes(input)
  open.push(value)
  return value
}
afterEach(() => {
  for (const value of open) value.dispose()
  open = []
})

/** About four characters a token, the usual rule for English text. */
const tokens = (text: string) => Math.ceil(text.length / 4)

const fleet = () => [
  work("a", { phase: "busy", idleSince: undefined }),
  work("b"),
  work("c", { saved: "fresh" }),
  work("d", { phase: "asleep" }),
  work("x", { notify: "ses_other" }),
]

describe("the idle check (L-4): speaks only when money burns and automation will not act, never loops", () => {
  /** One idle: the hook runs; a note it posts makes the model answer, as the host runs it in the same execution. */
  async function idle(f: Fakes, hooks: ReturnType<typeof costHooks>, sessionID = "ses_coord") {
    const before = f.synthetic.length
    await hooks.idle({ sessionID })
    if (f.synthetic.length > before) f.contexts.get(sessionID)!.push({ type: "assistant" })
  }

  test("automation off and idle works running: one note, tagged, with the counts, the cost and one call", async () => {
    const f = make({ works: fleet(), options: { access: "ask-changes" } })
    const hooks = costHooks(f.services)
    await idle(f, hooks)
    expect(f.synthetic).toHaveLength(1)
    const note = f.synthetic[0]!
    expect(note.metadata).toMatchObject({ boxd: IDLE_TAG, id: expect.stringMatching(/^boxd-idle-[0-9a-f]{12}$/) })
    // No usage read yet, so boxd's public rates, and the note says so rather than pass them off as the org's.
    expect(note.text).toMatch(/^boxd: 3 idle works are running \(~€0\.\d\d\/h, public EUR rates\) and auto-sleep is off \(access\)\. Call boxd_sleep\(\{ select: "idle" \}\) or say why not\.$/)
    // About 60 tokens, and the one extra turn it causes.
    expect(tokens(note.text)).toBeLessThanOrEqual(60)
  })

  test("silent at the default (automation on), for a session that owns nothing, and with idleCheck off", async () => {
    const on = make({ works: fleet() })
    await costHooks(on.services).idle({ sessionID: "ses_coord" })
    const nobody = make({ works: fleet(), options: { access: "read-only" } })
    await costHooks(nobody.services).idle({ sessionID: "ses_nobody" })
    const off = make({ works: fleet(), options: { access: "read-only", idleCheck: false } })
    await costHooks(off.services).idle({ sessionID: "ses_coord" })
    expect([...on.synthetic, ...nobody.synthetic, ...off.synthetic]).toEqual([])
  })

  test("10 idle cycles with no other input: exactly one note", async () => {
    const f = make({ works: fleet(), options: { access: "read-only" } })
    const hooks = costHooks(f.services)
    for (let cycle = 0; cycle < 10; cycle++) {
      f.clock.now = new Date(T0.getTime() + cycle * 60 * 60_000)
      await idle(f, hooks)
    }
    expect(f.synthetic).toHaveLength(1)
  })

  test("its own note as the newest input keeps the next idle silent, even with a new state and 30 minutes gone", async () => {
    const f = make({ works: fleet(), options: { access: "read-only" } })
    const hooks = costHooks(f.services)
    await idle(f, hooks)
    f.watch.works = [...fleet(), work("e")]
    f.clock.now = new Date(T0.getTime() + 31 * 60_000)
    await idle(f, hooks)
    expect(f.synthetic).toHaveLength(1)
    // A person's message after it: the check may speak again.
    f.contexts.get("ses_coord")!.push({ type: "user" })
    await idle(f, hooks)
    expect(f.synthetic).toHaveLength(2)
  })

  test("burning, not burning, burning again within minutes: still one note per 30 minutes (MEDIUM-2)", async () => {
    const f = make({ works: [work("a")], options: { access: "ask-changes" } })
    const hooks = costHooks(f.services)
    for (let minute = 0; minute < 60; minute++) {
      f.clock.now = new Date(T0.getTime() + minute * 60_000)
      f.watch.works = [minute % 2 ? work("a", { phase: "busy", idleSince: undefined }) : work("a")]
      f.contexts.set("ses_coord", [...(f.contexts.get("ses_coord") ?? []), { type: "user" }])
      await idle(f, hooks)
    }
    // Minutes 0 and 30 at most: never two within 30 minutes.
    expect(f.synthetic).toHaveLength(2)
  })

  test("at most once per 30 minutes, even when the state changes", async () => {
    const f = make({ works: fleet(), options: { access: "read-only" } })
    const hooks = costHooks(f.services)
    await idle(f, hooks)
    f.contexts.get("ses_coord")!.push({ type: "user" })
    f.watch.works = [...fleet(), work("e")]
    f.clock.now = new Date(T0.getTime() + 10 * 60_000)
    await idle(f, hooks)
    expect(f.synthetic).toHaveLength(1)
  })

  test("50 cycles across 5 state changes: at most 5 notes", async () => {
    const f = make({ works: fleet(), options: { access: "read-only" } })
    const hooks = costHooks(f.services)
    for (let cycle = 0; cycle < 50; cycle++) {
      if (cycle % 10 === 0) {
        f.watch.works = [...fleet(), ...Array.from({ length: cycle / 10 }, (_, index) => work(`n${index}`))]
        f.clock.now = new Date(T0.getTime() + (cycle / 10) * 31 * 60_000)
        // Between changes the person or a tool says something, so its own-note rule alone does not hold it back.
        f.contexts.set("ses_coord", [...(f.contexts.get("ses_coord") ?? []), { type: "user" }])
      }
      await idle(f, hooks)
    }
    expect(f.synthetic.length).toBeGreaterThanOrEqual(1)
    expect(f.synthetic.length).toBeLessThanOrEqual(5)
  })

  test("other reasons: a failed auto-sleep, a work waiting on a person past €1, a reached budget", async () => {
    const waiting = work("q", { needsInput: "permission", idleSince: minutesAgo(T0, 60 * 30) })
    const f = make({ works: [work("a", { phase: "busy", idleSince: undefined }), waiting, work("s")], options: { budget: { daily: 1, action: "warn" } } })
    const internals = (await import("../../src/cost/shared.js")).sharedOf(f.services.cost)
    internals.failed.set("s", { step: "sleep", code: "BOXD_FAILED", at: 0 })
    await f.services.cost.budget({ callId: "t", source: "automation" })
    await costHooks(f.services).idle({ sessionID: "ses_coord" })
    const text = f.synthetic[0]!.text
    expect(text).toContain("Auto-sleep failed for 1 running work")
    expect(text).toContain("1 work waits on a person (oc-q)")
    expect(text).toContain("Today's machine cost has reached the budget (€2.00 of €1.00, boxd's estimate).")
    // The budget read the organisation's rates: no public label.
    expect(text).not.toContain("public")
  })

  test("a note that could not be posted is reported, never thrown", async () => {
    const f = make({ works: fleet(), options: { access: "read-only" } })
    const services = { ...f.services, sessions: { ...f.services.sessions, synthetic: async () => Promise.reject(new Error("session is locked")) } }
    await costHooks(services as never).idle({ sessionID: "ses_coord" })
    expect(f.reports.get("hooks:idle")).toContain("session is locked")
  })
})

describe("registration and the session events", () => {
  test("the idle hook registers; a refused one is named for status, and the session events still subscribe", async () => {
    const f = make({ works: fleet() })
    const names: string[] = []
    const ctx = {
      session: {
        hook: async (name: string) => {
          if (name === "experimental.idle") throw new Error("unknown hook")
          names.push(name)
          return { dispose: async () => {} }
        },
      },
      event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    }
    const stops = await registerCostHooks(ctx as never, f.services)
    expect(names).toEqual([])
    expect(f.reports.get("hooks")).toContain("experimental.idle")
    for (const stop of stops) await stop()
  })

  test("session.deleted and session.archived orphan the session's works and wake automation", async () => {
    const f = make({ works: fleet() })
    let pokes = 0
    const shared = (await import("../../src/cost/shared.js")).sharedOf(f.services.cost)
    shared.poke = () => void pokes++
    f.watch.works = [work("a", { notify: "ses_coord" }), work("b", { notify: "ses_other" }), work("c", { notify: "ses_live" })]
    const events = [
      { type: "session.deleted", data: { sessionID: "ses_coord" } },
      { type: "session.archived", data: { sessionID: "ses_other" } },
    ]
    let types: readonly string[] = []
    const ctx = {
      session: { hook: async () => ({ dispose: async () => {} }) },
      event: {
        subscribe: (input: { types: readonly string[] }) => {
          types = input.types
          return (async function* () {
            yield* events
          })()
        },
      },
    }
    const stops = await registerCostHooks(ctx as never, f.services)
    for (const stop of stops) await stop()
    expect(types).toEqual(["session.deleted", "session.archived"])
    // The watcher's sessionGone marks the works, the fast path; automation is woken for each.
    expect(f.watch.gone).toEqual([
      { sessionID: "ses_coord", why: "deleted" },
      { sessionID: "ses_other", why: "archived" },
    ])
    expect(f.watch.works.map((item) => item.orphaned?.why ?? null)).toEqual(["deleted", "archived", null])
    expect(pokes).toBe(2)
  })
})
