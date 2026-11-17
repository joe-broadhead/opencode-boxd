// The boxd.works source (src/sources.ts): the conformance kit's report, the family's events_list suite, and the cases the
// kit does not name on its own: paging, an empty page, an expired cursor, the ledger failing, the v0 import still
// running, another account at the probe, the plugin's own words, and a read while the event log's lock is held.
import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assertEventsListConformance, type EventsListResult } from "@we-the-rebel-alliance/source-contract/events"
import { sessionRules } from "@we-the-rebel-alliance/source-contract/permission"
import { boxdError } from "../../src/errors.js"
import { acquireLock } from "../../src/ledger/lock.js"
import type { WorkEvent } from "../../src/ports.js"
import { encodeWorksCursor, eventOf, listWorks, probeWorks, sourceMethods, titleOf } from "../../src/sources.js"
import { TOOLS_RPC_ID } from "../../src/tools-rpc.js"
import { call, conformanceReports, declaredSources, FIXTURE, fixtureDeps, fixtureLog } from "../support/conformance.js"

const fixture = await fixtureLog()
afterAll(fixture.cleanup)
const deps = fixtureDeps(fixture.log)
const { account, owner } = deps.identity()
const kept = fixture.kept
const KEY_SHAPED = "sk-proj9x7k2m4q8r1t6w3z"
const list = (input: Record<string, unknown>) => listWorks(deps, input) as Promise<EventsListResult>
/** The refusal a read ends in. */
const refusalOf = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("the read answered, and it must be refused")
    },
    (error: unknown) => error as Error & { code: string; next: string },
  )
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: { code?: string; message?: string }) => error.code,
  )

describe("the declaration", () => {
  test("is one events source on this plugin's tools RPC, whose fenced session allows only its own action", () => {
    const sources = declaredSources()
    expect(sources.rpc).toBe(TOOLS_RPC_ID)
    expect(sources.probe).toEqual({ action: "boxd_probe" })
    expect(sources.items.map((item) => [item.id, item.kind, item.kind === "events" ? item.reads : undefined, item.input?.["source"]])).toEqual([["boxd.works", "events", "x-boxd/work", "works"]])
    const rules = sessionRules(sources.items[0]! as never, { source: "boxd.works", account })
    expect(rules.ok ? rules.value : rules.problems).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "boxd_events_list", resource: "*", effect: "allow" },
    ])
  })

  test("declares none of the keys a consumer on source-contract 0.1.x refuses", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as { sources: { items: { permission: Record<string, unknown>; accounts: Record<string, unknown> }[] } }
    for (const item of pkg.sources.items) {
      for (const key of ["identityRules", "readsIdentity", "identity"]) expect(item.permission[key]).toBeUndefined()
      expect(item.accounts["server"]).toBeUndefined()
    }
  })
})

describe("the conformance kit", () => {
  test("passes, with the expired-cursor check run for real: the log rotates", async () => {
    const [report] = await conformanceReports()
    expect(report!.problems).toEqual([])
    expect(report!.ok).toBe(true)
    const byName = new Map(report!.checks.map((check) => [check.name, check]))
    for (const name of ["page-result", "gap-and-cursor-expired", "gap-once-per-read", "refused-is-final", "probe", "unused-grants", "rpc-id"]) {
      expect({ name, ran: byName.get(name)?.ran }).toEqual({ name, ran: true })
    }
    expect(byName.get("failed-holds-cursor")).toMatchObject({ ran: false, notApplicable: true })
    expect(byName.get("failed-holds-cursor")!.reason).toContain("one read of the local event log")
  })

  test("the family's events_list suite: pages join up, an old cursor repeats its page, refusals carry the table's codes", async () => {
    const since = kept[1]!.at
    const listed = kept.filter((line) => line.seq >= kept[1]!.seq)
    await assertEventsListConformance((input) => listWorks(deps, input), {
      source: "works",
      account,
      owner,
      since,
      expected: listed.filter((line) => line.workId !== KEY_SHAPED).map((line) => `${line.workId}:${line.seq}`),
      refused: listed.filter((line) => line.workId === KEY_SHAPED).map((line) => `${line.workId}:${line.seq}`),
      maxBytes: 65_536,
      kinds: ["x-boxd/work"],
      namespace: "boxd",
      binding: { plugin: "boxd" },
      codes: true,
    })
  })
})

describe("events_list", () => {
  test("pages: each page's cursor lists what follows it, and the last answers more: false", async () => {
    const since = kept[1]!.at
    const ids: string[] = []
    let page = await list({ since, limit: 2 })
    for (let guard = 0; guard < 20; guard++) {
      ids.push(...page.events.map((event) => event.external_id), ...(page.refused ?? []).map((entry) => entry.external_id))
      if (!page.more) break
      page = await list({ cursor: page.cursor, limit: 2 })
    }
    expect(page.more).toBe(false)
    expect(ids.sort()).toEqual(kept.slice(1).map((line) => `${line.workId}:${line.seq}`).sort())
  })

  test("an empty page names its source, account and owner, and answers a cursor that lists nothing new", async () => {
    const newest = kept[kept.length - 1]!
    const page = await list({ cursor: encodeWorksCursor(account, { q: newest.seq, t: newest.at }) })
    expect(page).toMatchObject({ source: "works", account, owner, events: [], more: false, trust: "untrusted" })
    expect(page.gap).toBeUndefined()
    expect((await list({ cursor: page.cursor })).events).toEqual([])
  })

  test("a cursor the log rotated away answers gap.reason expired, since the time it covered, and reads on from the oldest kept event", async () => {
    const lost = FIXTURE.events[0]!
    const page = await list({ cursor: encodeWorksCursor(account, { q: 1, t: lost.at! }), limit: 3 })
    expect(page.gap).toEqual({ reason: "expired", since: lost.at! })
    const first = [...page.events.map((event) => event.external_id), ...(page.refused ?? []).map((entry) => entry.external_id)].sort()
    expect(first).toEqual(kept.slice(0, 3).map((line) => `${line.workId}:${line.seq}`).sort())
    expect(page.more).toBe(true)
    // The gap is answered once: the page its cursor names carries none.
    expect((await list({ cursor: page.cursor })).gap).toBeUndefined()
  })

  test("a window that starts before the oldest kept event says the history before it is gone", async () => {
    const page = await list({ since: "2026-11-15T00:00:00Z", limit: 1 })
    expect(page.gap).toEqual({ reason: "expired", since: "2026-11-15T00:00:00.000Z" })
    // A window inside what the log keeps has no gap.
    expect((await list({ since: kept[0]!.at })).gap).toBeUndefined()
  })

  test("the ledger failing to read answers UNAVAILABLE with a next step", async () => {
    const failing = fixtureDeps(fixture.log, FIXTURE, { ledger: { eventsSince: async () => Promise.reject(boxdError("LEDGER_FAILED")) } })
    const error = await refusalOf(listWorks(failing, {}))
    expect(error.code).toBe("UNAVAILABLE")
    expect(error.message).toMatch(/^UNAVAILABLE: .*LEDGER_FAILED.*\. Next step: Run \/boxd-status/)
  })

  test("an uncoded file-system error, or a log busy rotating, is UNAVAILABLE, never the ledger's path", async () => {
    const path = join(fixture.log.file, "..", "events.jsonl")
    const enoent = Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" })
    const missing = await refusalOf(listWorks(fixtureDeps(fixture.log, FIXTURE, { ledger: { eventsSince: async () => Promise.reject(enoent) } }), {}))
    expect(missing.code).toBe("UNAVAILABLE")
    expect(missing.message).not.toContain(path)
    expect(missing.message).not.toContain("ENOENT")
    const busy = await refusalOf(listWorks(fixtureDeps(fixture.log, FIXTURE, { ledger: { eventsSince: async () => Promise.reject(boxdError("LEDGER_LOCKED")) } }), {}))
    expect(busy.code).toBe("UNAVAILABLE")
    expect(busy.message).toContain("Next step: Call events_list again in a few seconds, with the same cursor.")
  })

  test("while the v0 import runs, or after it failed, it answers UNAVAILABLE and never reads the ledger or starts the import", async () => {
    let reads = 0
    const counting = { eventsSince: async () => (reads++, { events: [], cursor: 0, cursorExpired: false }) }
    const importing = fixtureDeps(fixture.log, FIXTURE, { ledger: counting, importV0: { state: () => ({ state: "importing", done: 2, total: 5 }) } })
    const busy = await refusalOf(listWorks(importing, {}))
    expect(busy.code).toBe("UNAVAILABLE")
    expect(busy.message).toContain("still importing the works of opencode-boxd v0 (2 of 5 works)")
    const failed = fixtureDeps(fixture.log, FIXTURE, { ledger: counting, importV0: { state: () => ({ state: "failed", reason: "listing failed", retryAt: FIXTURE.now }) } })
    expect(await code(listWorks(failed, {}))).toBe("UNAVAILABLE")
    // The import's own LEDGER_IMPORTING, raised by the ledger's gate, is the same answer.
    const gated = fixtureDeps(fixture.log, FIXTURE, { ledger: { eventsSince: async () => Promise.reject(boxdError("LEDGER_IMPORTING")) } })
    expect(await code(listWorks(gated, {}))).toBe("UNAVAILABLE")
    expect(reads).toBe(0)
  })

  test("reads while another process holds the event log's lock: a read takes no lock", async () => {
    const lock = await acquireLock(join(fixture.log.file, "..", "events.lock"), { purpose: "events" })
    try {
      expect(lock).not.toBeNull()
      expect((await list({ since: kept[0]!.at })).events.length).toBeGreaterThan(0)
    } finally {
      await lock?.release()
    }
  })

  test("events are oldest first even when the clock went back between two appends; the cursor still covers both", async () => {
    const lines: WorkEvent[] = [
      { seq: 1, at: "2026-11-17T10:00:00.000Z", workId: "late-clock", from: null, to: "creating" },
      { seq: 2, at: "2026-11-17T09:59:00.000Z", workId: "late-clock", from: "creating", to: "starting" },
    ]
    const skewed = fixtureDeps(fixture.log, FIXTURE, { ledger: { eventsSince: async (cursor) => ({ events: lines.filter((line) => line.seq > cursor), cursor: 2, cursorExpired: false }) } })
    const page = (await listWorks(skewed, { since: "2026-11-17T00:00:00Z" })) as EventsListResult
    expect(page.events.map((event) => event.external_id)).toEqual(["late-clock:2", "late-clock:1"])
    expect(((await listWorks(skewed, { cursor: page.cursor })) as EventsListResult).events).toEqual([])
  })

  test("refuses another computer's account, a source it does not have, a scope and a malformed cursor", async () => {
    expect(await code(list({ account: "other-mac" }))).toBe("ACCOUNT_MISMATCH")
    expect(await code(list({ source: "machines" }))).toBe("SOURCE_UNKNOWN")
    expect(await code(list({ scope: { works: ["fix-auth"] } }))).toBe("INPUT_INVALID")
    expect(await code(list({ cursor: "not-a-cursor" }))).toBe("CURSOR_INVALID")
    expect(await code(list({ cursor: encodeWorksCursor("other-mac", { q: 1, t: FIXTURE.now }) }))).toBe("CURSOR_INVALID")
  })
})

/**
 * An event log in memory with `EventLog.since`'s rules: the kept lines after a cursor, and `cursorExpired` for a cursor
 * older than the oldest kept line or newer than the newest. `drop` lines are lost from the start, as a rotation loses them.
 */
function memoryLog(lines: readonly WorkEvent[], drop = 0) {
  const kept = lines.slice(drop)
  return {
    eventsSince: async (since: number) => {
      const newest = kept.length ? kept[kept.length - 1]!.seq : 0
      const oldest = kept.length ? kept[0]!.seq : newest + 1
      const expired = since > newest || since < oldest - 1
      const events = expired ? kept : kept.filter((line) => line.seq > since)
      return { events, cursor: events.length ? events[events.length - 1]!.seq : expired ? newest : since, cursorExpired: expired }
    },
  }
}

/** Every page of a read, from its first input, following each cursor until more is false. */
async function walk(read: (input: Record<string, unknown>) => Promise<EventsListResult>, first: Record<string, unknown>, limit?: number) {
  const pages: EventsListResult[] = []
  let page = await read({ ...first, ...(limit ? { limit } : {}) })
  pages.push(page)
  for (let guard = 0; page.more && guard < 1_000; guard++) {
    page = await read({ cursor: page.cursor, ...(limit ? { limit } : {}) })
    pages.push(page)
  }
  return pages
}

const listed = (pages: readonly EventsListResult[]) => pages.flatMap((page) => [...page.events.map((event) => event.external_id), ...(page.refused ?? []).map((entry) => entry.external_id)])

describe("the three ways a source has gone wrong before", () => {
  const BURST_AT = "2026-11-17T10:00:00.000Z"
  /** A 170-work fleet changing at once, three times: 510 lines at the same instant. */
  const burst: WorkEvent[] = Array.from({ length: 510 }, (_, index) => ({ seq: index + 1, at: BURST_AT, workId: `fleet-${String(index % 170).padStart(3, "0")}`, from: "busy", to: "idle", outcome: "completed" }))

  test("(a) no sliding gap: an expired cursor restarts from the gap line it carries, whatever the clock says", async () => {
    const lost = "2026-11-16T07:00:00.000Z"
    const cursor = encodeWorksCursor(account, { q: 3, t: lost })
    const log = memoryLog(burst.slice(0, 40), 10)
    const at = (now: string) => (input: Record<string, unknown>) => listWorks(fixtureDeps(fixture.log, FIXTURE, { ledger: log, now: () => new Date(now) }), input) as Promise<EventsListResult>
    const early = await walk(at("2026-11-17T12:00:00Z"), { cursor }, 7)
    const late = await walk(at("2026-12-25T12:00:00Z"), { cursor }, 7)
    for (const pages of [early, late]) {
      expect(pages[0]!.gap).toEqual({ reason: "expired", since: lost })
      expect(listed(pages)).toEqual(burst.slice(10, 40).map((line) => `${line.workId}:${line.seq}`))
    }
    expect(late.map((page) => page.cursor)).toEqual(early.map((page) => page.cursor))
  })

  test("(b) no jam: a burst larger than a page drains, page by page, with nothing repeated or skipped, and each page within maxBytes", async () => {
    const read = (input: Record<string, unknown>) => listWorks(fixtureDeps(fixture.log, FIXTURE, { ledger: memoryLog(burst) }), input) as Promise<EventsListResult>
    for (const limit of [undefined, 1, 500]) {
      const pages = await walk(read, { since: "2026-11-17T00:00:00Z" }, limit)
      expect(listed(pages)).toEqual(burst.map((line) => `${line.workId}:${line.seq}`))
      for (const page of pages) expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65_536)
      expect(pages.at(-1)!.more).toBe(false)
    }
    // A burst of works whose ids are shaped like keys: every page is refusals only, and the cursor still moves.
    const keyed = burst.map((line, index) => ({ ...line, workId: `sk-proj${String(index).padStart(4, "0")}x7k2m4q8r1t6w` }))
    const keyedPages = await walk((input) => listWorks(fixtureDeps(fixture.log, FIXTURE, { ledger: memoryLog(keyed) }), input) as Promise<EventsListResult>, { since: "2026-11-17T00:00:00Z" }, 500)
    expect(keyedPages.length).toBeGreaterThan(1)
    expect(keyedPages.every((page) => page.events.length === 0 && Buffer.byteLength(JSON.stringify(page)) <= 65_536)).toBe(true)
    expect(listed(keyedPages)).toEqual(keyed.map((line) => `${line.workId}:${line.seq}`))
  })

  test("(c) a gap is answered once per read, across many small pages, from an expired cursor or an old window", async () => {
    const log = memoryLog(burst.slice(0, 30), 12)
    const read = (input: Record<string, unknown>) => listWorks(fixtureDeps(fixture.log, FIXTURE, { ledger: log }), input) as Promise<EventsListResult>
    for (const first of [{ cursor: encodeWorksCursor(account, { q: 2, t: "2026-11-16T00:00:00.000Z" }) }, { since: "2026-11-16T00:00:00Z" }]) {
      const pages = await walk(read, first, 1)
      expect(pages.length).toBe(18)
      expect(pages.map((page) => page.gap !== undefined)).toEqual(pages.map((_, index) => index === 0))
      expect(listed(pages)).toEqual(burst.slice(12, 30).map((line) => `${line.workId}:${line.seq}`))
    }
  })
})

describe("an event", () => {
  test("is the plugin's own words: the work, its phase, how a run ended, its code and who slept it; no text, actors or link", () => {
    const at = "2026-11-17T09:00:00.000Z"
    const event = (fields: Partial<WorkEvent>): WorkEvent => ({ seq: 7, at, workId: "fix-auth", from: "busy", to: "idle", ...fields })
    expect(titleOf(event({ outcome: "completed" }))).toBe("Work fix-auth: its run completed")
    expect(titleOf(event({ outcome: "failed", code: "RUN_FAILED" }))).toBe("Work fix-auth: its run failed (RUN_FAILED)")
    expect(titleOf(event({ to: "asleep", asleepBy: "boxd_sleep" }))).toBe("Work fix-auth: its machine is put to sleep by boxd_sleep")
    expect(titleOf(event({ to: "busy", needsInput: "permission" }))).toBe("Work fix-auth: it is running a prompt, waiting for a permission answer")
    expect(titleOf(event({ from: null, to: "creating" }))).toBe("Work fix-auth: its machine is being created")
    const normalised = eventOf(event({ outcome: "failed", code: "RUN_FAILED", reading: { residentGiB: 1.5, load1: 0.4 } }), account)
    expect(normalised).toMatchObject({
      source: "works",
      account,
      external_id: "fix-auth:7",
      kind: "x-boxd/work",
      occurred_at: at,
      thread: "boxd-work:fix-auth",
      actors: [],
      text: "",
      url: null,
      labels: ["phase:idle", "outcome:failed", "code:RUN_FAILED"],
    })
  })

  test("whose title holds a secret is refused for good, and the cursor moves past it", async () => {
    const page = await list({ since: kept[0]!.at })
    expect((page.refused ?? []).map((entry) => entry.reason)).toEqual(kept.filter((line) => line.workId === KEY_SHAPED).map(() => "secret"))
    expect(page.events.some((event) => event.title.includes(KEY_SHAPED))).toBe(false)
  })
})

describe("probe", () => {
  test("names this computer and its OS user and reads nothing; another account is ACCOUNT_MISMATCH", () => {
    expect(probeWorks(deps, { source: "works" })).toEqual({ source: "works", account, owner, trust: "untrusted" })
    expect(owner).toEqual({ id: "os-user:sam@studio-mac", label: "sam on studio-mac" })
    expect(() => probeWorks(deps, { account: "other-mac" })).toThrow(/^ACCOUNT_MISMATCH: /)
    expect(() => probeWorks(deps, { source: "machines" })).toThrow(/^SOURCE_UNKNOWN: /)
  })
})

describe("the tools RPC methods", () => {
  test("are two reads that each assert their own action with the call's source before answering", async () => {
    const asserted: Record<string, unknown>[] = []
    const methods = sourceMethods(deps, async (request) => void asserted.push(request as never))
    expect(methods.map((method) => [method.name, method.class, method.action])).toEqual([
      ["events_list", "read", "boxd_events_list"],
      ["probe", "read", "boxd_probe"],
    ])
    await methods[0]!.run({ since: kept[0]!.at }, call())
    await methods[1]!.run({}, call())
    expect(asserted).toEqual([
      { sessionID: "ses_conformance", agent: "build", action: "boxd_events_list", resources: ["*"], source: { type: "tool", messageID: "msg_conformance", id: "call_conformance" } },
      { sessionID: "ses_conformance", agent: "build", action: "boxd_probe", resources: ["*"], source: { type: "tool", messageID: "msg_conformance", id: "call_conformance" } },
    ])
  })
})
