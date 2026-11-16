// `/boxd-cleanup` (design §C.5, M-3, review note N-2): the report changes nothing; each action is confirmed by one
// permission prompt with no source, asserting the tool's own action at "ask-changes" and boxd_cleanup at "all";
// "read-only" only reports; a "no" skips only that action; the resources are exactly the ids acted on; and no session
// message carries anything that could approve an action.
import { afterEach, describe, expect, test } from "bun:test"
import { CLEANUP_COMMAND, cleanupReport, cleanupView, registerCleanupCommand, runCleanup } from "../../src/cleanup.js"
import { CLEANUP_ACTION, defaultRules } from "../../src/permissions.js"
import { fakes, work, type Fakes } from "../support/cost-fakes.js"

let open: Fakes[] = []
afterEach(() => {
  for (const value of open) value.dispose()
  open = []
})

type Assert = { sessionID: string; action: string; resources: readonly string[]; metadata?: Record<string, unknown>; source?: unknown; agent?: unknown }

function setup(options: Record<string, unknown> = {}, decide: (input: Assert) => "yes" | "no" = () => "yes") {
  const f = fakes({
    options,
    works: [work("fin"), work("fin2"), work("unsaved", { phase: "asleep", saved: "none" }), work("saved", { saved: "fresh" }), work("busy", { phase: "busy", outcome: null })],
  })
  open.push(f)
  f.actions.matches = { boxd_sleep: ["fin", "fin2", "saved"], boxd_harvest: ["fin", "fin2", "unsaved"], boxd_drop: ["saved"] }
  const asked: Assert[] = []
  const ctx = {
    session: { synthetic: f.services.sessions.synthetic },
    permission: {
      assert: async (input: Assert) => {
        asked.push(input)
        // A plain rejection rejects with an error that would end the step: the command must catch it per action.
        if (decide(input) === "no") throw new Error("The user rejected permission to use this specific tool call.")
      },
    },
  }
  return { f, ctx, asked, run: () => runCleanup(ctx as never, f.services, "ses_person", "cleanup-1") }
}

const acted = (f: Fakes) => f.actions.calls.filter((call) => call.method !== "match").map((call) => `${call.method} ${call.ids.join(",")}`)

describe("/boxd-cleanup", () => {
  test("the report alone changes nothing and names costs, phases and the suggested actions", async () => {
    const { f } = setup()
    const report = await cleanupReport(f.services, { callId: "r", source: "cleanup-command" })
    expect(acted(f)).toEqual([])
    expect(f.actions.calls).toEqual([])
    expect(report).toStartWith("boxd cleanup: 4 running, 1 asleep; ~€")
    expect(report).toContain("- fin: idle, ~€0.0376/h, idle 60 min, saved stale")
    expect(report).toContain('- sleep finished: 3 works, saves ~€')
    expect(report).toContain("Machine cost today: €2.00, boxd's estimate.")
    // The usage read gave the organisation's rates: no public label.
    expect(report).toStartWith("boxd cleanup: 4 running, 1 asleep; ~€0.15/h (an estimate).")
  })

  test('"ask-changes": each action asserts the tool\'s own action once, with no source and exactly the matched ids', async () => {
    const { f, asked, run } = setup({ access: "ask-changes" })
    await run()
    expect(asked.map((item) => [item.action, [...item.resources]])).toEqual([
      ["boxd_sleep", ["fin", "fin2", "saved"]],
      ["boxd_harvest", ["fin", "fin2", "unsaved"]],
      ["boxd_drop", ["saved"]],
    ])
    for (const item of asked) {
      expect(item.source).toBeUndefined()
      expect(item.sessionID).toBe("ses_person")
    }
    expect(acted(f)).toEqual(["sleep fin,fin2,saved", "harvest fin,fin2,unsaved", "drop saved"])
    for (const call of f.actions.calls) expect(call.context).toMatchObject({ by: "cleanup-command", call: { source: "cleanup-command" } })
  })

  test('"all": each action asserts boxd_cleanup, which the default rules set to ask at every level', async () => {
    const { asked, run } = setup({ access: "all" })
    await run()
    expect(asked.map((item) => item.action)).toEqual([CLEANUP_ACTION, CLEANUP_ACTION, CLEANUP_ACTION])
    for (const access of ["all", "ask-changes", "read-only"] as const) {
      const rules = defaultRules(access)
      expect(rules.filter((rule) => rule.action === CLEANUP_ACTION).at(-1)?.effect).toBe("ask")
    }
  })

  test('"read-only": a report, and nothing asserted, matched or changed', async () => {
    const { f, asked, run } = setup({ access: "read-only" })
    const { report } = await run()
    expect(asked).toEqual([])
    expect(f.actions.calls).toEqual([])
    expect(report).toContain("access is read-only, so this command only reports.")
    expect(f.synthetic).toHaveLength(1)
  })

  test("a no ends only that action: nothing changes for it, and the next action is still asked", async () => {
    const { f, asked, run } = setup({ access: "ask-changes" }, (input) => (input.action === "boxd_sleep" ? "no" : "yes"))
    const { outcomes } = await run()
    expect(asked).toHaveLength(3)
    expect(acted(f)).toEqual(["harvest fin,fin2,unsaved", "drop saved"])
    expect(outcomes[0]).toBe("Sleep finished works: declined; nothing changed.")
  })

  test("every no: nothing changes at all", async () => {
    const { f, run } = setup({ access: "all" }, () => "no")
    await run()
    expect(acted(f)).toEqual([])
  })

  test("drop runs through C2's drop with its guard per work: a refused work stays, and says why", async () => {
    const { f, run } = setup({ access: "ask-changes" })
    f.actions.failing.drop = { saved: "NOT_SAVED" }
    const { outcomes } = await run()
    expect(outcomes.at(-1)).toBe("Drop saved finished works: 1 refused.")
  })

  test("nothing to match: no prompt for that action", async () => {
    const { f, asked, run } = setup({ access: "ask-changes" })
    f.actions.matches = { boxd_sleep: [], boxd_harvest: [], boxd_drop: [] }
    const { outcomes } = await run()
    expect(asked).toEqual([])
    expect(outcomes).toEqual(["Sleep finished works: nothing to do.", "Harvest unsaved finished works: nothing to do.", "Drop saved finished works: nothing to do."])
  })

  test("the session messages are reports only: resume false, and nothing that answers a prompt", async () => {
    const { f, run } = setup({ access: "all" })
    await run()
    expect(f.synthetic).toHaveLength(2)
    for (const message of f.synthetic) {
      expect(message.resume).toBe(false)
      expect(message.metadata).toBeUndefined()
      expect(message.text).not.toMatch(/per_|permission id|requestID|reply|approve|code:/i)
    }
  })

  test("the command is registered under its name, and its execute runs the same steps", async () => {
    const { f, ctx } = setup({ access: "read-only" })
    let added: { name: string; execute: (input: { sessionID: string }) => Promise<void> } | undefined
    const command = { transform: async (fn: (editor: { add: (value: typeof added) => void }) => void) => (fn({ add: (value) => (added = value) }), { dispose: async () => {} }) }
    await registerCleanupCommand({ ...ctx, command } as never, f.services)
    expect(added?.name).toBe(CLEANUP_COMMAND)
    await added!.execute({ sessionID: "ses_person" })
    expect(f.synthetic).toHaveLength(1)
  })
})

describe("/boxd-cleanup with no open works", () => {
  test("it reports that, reads nothing from boxd, asks nothing and changes nothing", async () => {
    const f = fakes({ options: { access: "all" } })
    open.push(f)
    const asked: unknown[] = []
    const ctx = { session: { synthetic: f.services.sessions.synthetic }, permission: { assert: async (input: unknown) => void asked.push(input) } }
    const { report } = await runCleanup(ctx as never, f.services, "ses_person", "cleanup-empty")
    expect(report).toContain("Nothing was changed.")
    expect(asked).toEqual([])
    expect(f.calls).toEqual([])
    expect(f.actions.calls).toEqual([])
    expect(f.synthetic).toHaveLength(1)
  })

  test("when every action is declined, the summary says nothing was changed", async () => {
    const { f, run } = setup({ access: "all" }, () => "no")
    await run()
    expect(f.synthetic.at(-1)?.text).toEndWith("Nothing was changed.")
  })
})

describe("the cleanup view for the TUI (CleanupViewRpc)", () => {
  const call = { callId: "v", source: "cleanup-command" } as const

  test("the same figures as the report, as data; it matches and changes nothing", async () => {
    const { f } = setup({ access: "ask-changes" })
    const view = await cleanupView(f.services).view(call)
    expect(view).toMatchObject({ state: "ok", currency: "EUR", automation: "off (access)", confirm: "tool-action", command: "/boxd-cleanup" })
    expect(view.perHour).toBeCloseTo(4 * 0.0376 + 0.0016, 4)
    expect(view.works.map((item) => item.workId)).toEqual(["busy", "fin", "fin2", "saved"])
    expect(view.works[0]).toEqual({ workId: "busy", phase: "busy", saved: "stale", perHour: 0.0376, idleMinutes: null })
    expect(view.works[1]).toMatchObject({ workId: "fin", idleMinutes: 60 })
    expect(view.actions.map((action) => action.call)[0]).toBe('boxd_sleep({ select: "finished" })')
    expect(view.note).toBeUndefined()
    expect(f.actions.calls).toEqual([])
  })

  test("how it confirms at each access level", async () => {
    for (const [access, confirm] of [["all", "cleanup-action"], ["ask-changes", "tool-action"], ["read-only", "report-only"]] as const) {
      const { f } = setup({ access })
      expect((await cleanupView(f.services).view(call)).confirm).toBe(confirm)
    }
  })

  test("a member: public rates, said in the note", async () => {
    const f = fakes({ works: [work("a")], usage: { available: false, reason: "owners and admins" } })
    open.push(f)
    const view = await cleanupView(f.services).view(call)
    expect(view.state).toBe("ok")
    expect(view.note).toContain("boxd's public EUR rates")
  })

  test("no open works: no boxd read, nothing suggested", async () => {
    const f = fakes()
    open.push(f)
    const view = await cleanupView(f.services).view(call)
    expect(view).toMatchObject({ state: "ok", works: [], actions: [], perHour: 0, note: "No open works." })
    expect(f.calls).toEqual([])
  })

  test("a failure reads as unavailable with the reason", async () => {
    const { f } = setup()
    const broken = { ...f.services, cost: { ...f.services.cost, cleanup: async () => Promise.reject(new Error("the watcher is down")), automation: () => "on" } }
    const view = await cleanupView(broken as never).view(call)
    expect(view).toMatchObject({ state: "unavailable", currency: null, perHour: null, works: [], actions: [], note: "the watcher is down" })
  })
})
