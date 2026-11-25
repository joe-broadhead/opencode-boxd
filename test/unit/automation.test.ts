// Package E's automation (design §C.2, §C.3, §7.1 "Cost and cleanup"): harvest then sleep of finished and orphaned
// works through C2's FleetActions (faked), one work at a time, sleeping only after a saved harvest (or an old guest or a
// timeout); gated by access; one owner; lease renewals by id with each lease's own length at every access level; and
// never a drop.
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { automation, LEASE_RENEW_MS, startAutomation, type Automation } from "../../src/automation.js"
import type { WorkSnapshot } from "../../src/ports.js"
import { fakes, minutesAgo, record, T0, work, type Fakes } from "../support/cost-fakes.js"

let open: Array<{ f: Fakes; loops: Automation[] }> = []
function setup(input: Parameters<typeof fakes>[0] = {}) {
  const f = fakes(input)
  const entry = { f, loops: [] as Automation[] }
  open.push(entry)
  const loop = (over: Partial<Fakes> = {}) => {
    const created = automation({ ...f.services, ...over } as never)
    entry.loops.push(created)
    return created
  }
  return { f, loop }
}
afterEach(async () => {
  for (const { f, loops } of open) {
    for (const loop of loops) await loop.dispose()
    f.dispose()
  }
  open = []
})

const acted = (f: Fakes) => f.actions.calls.filter((call) => call.method !== "match").map((call) => `${call.method} ${call.ids.join(",")}`)

describe("a finished work is harvested, then slept, after autoSleepMinutes", () => {
  test("idle past 10 minutes: harvest, whose export checks the tree is idle, then sleep, tagged automation", async () => {
    const { f, loop } = setup({ works: [work("a", { idleSince: minutesAgo(T0, 11) })], records: [record("a")] })
    await loop().tick()
    expect(acted(f)).toEqual(["harvest a", "sleep a"])
    for (const call of f.actions.calls) {
      expect(call.context.by).toBe("automation")
      expect(call.context.call.source).toBe("automation")
    }
    // The harvest's own export is the one guest read: no separate phase read, one listing to skip a sleeping machine.
    expect(f.calls.filter((call) => call.startsWith("phase") || call.startsWith("v0-phase"))).toEqual([])
    expect(f.calls.filter((call) => call === "list")).toEqual(["list"])
  })

  test("each work is harvested and slept on its own, never a batch waiting on every harvest", async () => {
    const ids = ["w0", "w1", "w2"]
    const { f, loop } = setup({ works: ids.map((id) => work(id)), records: ids.map((id) => record(id)) })
    await loop().tick()
    expect(acted(f).sort()).toEqual(["harvest w0", "harvest w1", "harvest w2", "sleep w0", "sleep w1", "sleep w2"])
    for (const id of ids) {
      const order = acted(f).filter((entry) => entry.endsWith(` ${id}`))
      expect(order).toEqual([`harvest ${id}`, `sleep ${id}`])
    }
  })

  test("not yet due: no read, no action", async () => {
    const { f, loop } = setup({ works: [work("a", { idleSince: minutesAgo(T0, 9), touchedAt: minutesAgo(T0, 9) })], records: [record("a")] })
    await loop().tick()
    expect(acted(f)).toEqual([])
    expect(f.calls.filter((call) => call.startsWith("phase") || call === "list")).toEqual([])
  })

  test("a new prompt in the window cancels it: busy in the snapshot, or the harvest's export finds the tree busy", async () => {
    const { f, loop } = setup({ works: [work("a", { phase: "busy", idleSince: undefined })], records: [record("a")] })
    const one = loop()
    await one.tick()
    expect(acted(f)).toEqual([])
    f.watch.works = [work("b", { idleSince: minutesAgo(T0, 30) })]
    f.records.set("b", record("b"))
    f.actions.failing.harvest = { b: "SESSION_BUSY" }
    await one.tick()
    // Harvested (refused: busy), and never slept: a run someone asked for is not frozen.
    expect(acted(f)).toEqual(["harvest b"])
    expect(one.log.at(-1)).toMatchObject({ workId: "b", step: "harvest", result: "SESSION_BUSY" })
    // A busy work is not a failure: no warning, nothing for the idle check.
    expect(f.records.get("b")?.warnings).toBeUndefined()
  })

  test("a ready work with no prompt waits 30 minutes, not 10", async () => {
    const { f, loop } = setup({ works: [work("r", { phase: "ready", outcome: null, idleSince: minutesAgo(T0, 20), touchedAt: minutesAgo(T0, 20) })], records: [record("r")] })
    const one = loop()
    await one.tick()
    expect(acted(f)).toEqual([])
    f.clock.now = new Date(T0.getTime() + 11 * 60_000)
    await one.tick()
    expect(acted(f)).toEqual(["harvest r", "sleep r"])
  })

  for (const code of ["GUEST_VERSION", "TIMEOUT"]) {
    test(`a harvest that failed for ${code} (an old guest, a timeout) still sleeps, with UNHARVESTED_SLEEP`, async () => {
      const { f, loop } = setup({ works: [work("a")], records: [record("a")] })
      f.actions.failing.harvest = { a: code }
      const one = loop()
      await one.tick()
      expect(acted(f)).toEqual(["harvest a", "sleep a"])
      expect(f.records.get("a")?.warnings?.map((warning) => warning.code)).toEqual(["UNHARVESTED_SLEEP"])
      expect(one.log.filter((entry) => entry.workId === "a").map((entry) => `${entry.step}:${entry.result}`)).toEqual([`harvest:${code}`, "sleep:ok"])
    })
  }

  test("any other harvest failure is not slept: AUTOMATION_BLOCKED, shared with the idle check, retried after 30 minutes", async () => {
    const { f, loop } = setup({ works: [work("a")], records: [record("a")] })
    f.actions.failing.harvest = { a: "EXPORT_INVALID" }
    const one = loop()
    await one.tick()
    expect(acted(f)).toEqual(["harvest a"])
    expect(f.records.get("a")?.warnings?.map((warning) => warning.code)).toEqual(["AUTOMATION_BLOCKED"])
    const { sharedOf } = await import("../../src/cost/shared.js")
    expect(sharedOf(f.services.cost).failed.get("a")).toMatchObject({ step: "harvest", code: "EXPORT_INVALID" })
    await one.tick()
    expect(acted(f)).toEqual(["harvest a"])
    f.clock.now = new Date(T0.getTime() + 31 * 60_000)
    await one.tick()
    expect(acted(f)).toEqual(["harvest a", "harvest a"])
  })

  test("a failed sleep is recorded (AUTOMATION_BLOCKED), shared with the idle check, and retried only after 30 minutes", async () => {
    const { f, loop } = setup({ works: [work("a")], records: [record("a")] })
    f.actions.failing.sleep = { a: "BOXD_FAILED" }
    const one = loop()
    await one.tick()
    expect(f.records.get("a")?.warnings?.map((warning) => warning.code)).toEqual(["AUTOMATION_BLOCKED"])
    await one.tick()
    expect(acted(f)).toEqual(["harvest a", "sleep a"])
    f.clock.now = new Date(T0.getTime() + 31 * 60_000)
    await one.tick()
    expect(acted(f)).toEqual(["harvest a", "sleep a", "harvest a", "sleep a"])
  })

  test("a work waiting on a person is never touched", async () => {
    const { f, loop } = setup({ works: [work("a", { needsInput: "form" }), work("b", { needsInput: "permission", touchedAt: minutesAgo(T0, 48 * 60) })], records: [record("a"), record("b")] })
    await loop().tick()
    expect(acted(f)).toEqual([])
  })

  test("a lock taken over between the listing and the harvest: nothing is done by the old holder", async () => {
    const { f, loop } = setup({ works: [work("a")], records: [record("a")] })
    const one = loop()
    // The listing is the last step before the actions; the lock is lost right then.
    const list = f.services.boxd.list.bind(f.services.boxd)
    ;(f.services.boxd as { list: unknown }).list = async (...args: Parameters<typeof list>) => {
      const answer = await list(...args)
      const { rmSync } = await import("node:fs")
      rmSync(join(f.services.ledgerRoot, "automation.lock"), { recursive: true, force: true })
      return answer
    }
    await one.tick()
    expect(acted(f)).toEqual([])
    expect(one.log.at(-1)).toMatchObject({ workId: "a", step: "skip", result: "not-owner" })
    expect(f.services.cost.automation()).toBe("not-owner")
  })

  test("a machine already asleep in the listing is left alone", async () => {
    const { f, loop } = setup({ works: [work("a")], records: [record("a")] })
    f.statuses.set("oc-a", "hibernated")
    await loop().tick()
    expect(acted(f)).toEqual([])
    expect(f.calls.filter((call) => call.startsWith("phase"))).toEqual([])
  })

  test("autoSleepMinutes 0 turns the finished step off; orphans still count", async () => {
    const { f, loop } = setup({ options: { autoSleepMinutes: 0 }, works: [work("a", { idleSince: minutesAgo(T0, 600) }), work("o", { touchedAt: minutesAgo(T0, 13 * 60) })], records: [record("a"), record("o")] })
    await loop().tick()
    expect(acted(f)).toEqual(["harvest o", "sleep o"])
  })
})

describe("orphans (§C.3)", () => {
  const fresh = { idleSince: minutesAgo(T0, 1), touchedAt: minutesAgo(T0, 1) }

  test("the coordinator deleted (the session event, through the watcher's sessionGone): harvested and slept", async () => {
    const { f, loop } = setup({ works: [work("a", { ...fresh, notify: "ses_gone" })], records: [record("a")] })
    f.services.watch.sessionGone("ses_gone", "deleted")
    expect(f.watch.gone).toEqual([{ sessionID: "ses_gone", why: "deleted" }])
    await loop().tick()
    expect(acted(f)).toEqual(["harvest a", "sleep a"])
  })

  test("orphaned as the watcher's sweep marks it (archived, re-parented); a live coordinator's work waits", async () => {
    const orphaned = (why: "archived" | "reparented") => ({ why, session: "ses_x", at: T0.toISOString() })
    const { f, loop } = setup({ works: [work("a", { ...fresh, orphaned: orphaned("archived") }), work("b", { ...fresh, orphaned: orphaned("reparented") }), work("c", { ...fresh, notify: "ses_live" })], records: [record("a"), record("b"), record("c")] })
    await loop().tick()
    expect(acted(f).sort()).toEqual(["harvest a", "harvest b", "sleep a", "sleep b"])
  })

  test("untouched for orphanHours", async () => {
    const { f, loop } = setup({ works: [work("a", { idleSince: minutesAgo(T0, 1), touchedAt: minutesAgo(T0, 12 * 60) })], records: [record("a")] })
    await loop().tick()
    expect(acted(f)).toEqual(["harvest a", "sleep a"])
  })

  test("a busy orphan is left to finish", async () => {
    const { f, loop } = setup({ works: [work("a", { phase: "busy", notify: "ses_gone", touchedAt: minutesAgo(T0, 24 * 60) })], records: [record("a")] })
    f.services.watch.sessionGone("ses_gone", "archived")
    await loop().tick()
    expect(acted(f)).toEqual([])
  })
})

describe("never a drop (§C.3 step 4)", () => {
  test("the module never calls drop, remove or a delete timer", () => {
    const source = readFileSync(join(import.meta.dir, "..", "..", "src", "automation.ts"), "utf8").replace(/\/\*\*[\s\S]*?\*\/|\/\/.*$/gm, "")
    for (const forbidden of [".drop(", "actions.drop", "boxd.remove", ".remove(", "delete-after", "deleteAfter", "machineRemove"]) expect(source).not.toContain(forbidden)
  })

  test("a fleet where every work could be dropped: only harvest and sleep run, and the CLI removes nothing", async () => {
    const works: WorkSnapshot[] = ["a", "b", "c"].map((id) => work(id, { saved: "fresh", outcome: "completed", touchedAt: minutesAgo(T0, 48 * 60) }))
    const { f, loop } = setup({ works, records: works.map((item) => record(item.workId)) })
    const one = loop()
    for (let i = 0; i < 5; i++) {
      f.clock.now = new Date(T0.getTime() + i * 40 * 60_000)
      await one.tick()
    }
    expect(f.calls.filter((call) => call === "remove" || call === "hibernate")).toEqual([])
  })
})

describe("automation and access (M-2)", () => {
  const due = () => ({ works: [work("a")], records: [record("a")] })

  for (const access of ["ask-changes", "read-only"] as const) {
    test(`auto at ${access}: no harvest, no sleep, no lock`, async () => {
      const { f, loop } = setup({ options: { access }, ...due() })
      await loop().tick()
      expect(acted(f)).toEqual([])
      expect(f.calls).toEqual([])
      expect(f.services.cost.automation()).toBe("off (access)")
    })

    test(`"on" at ${access} is the person's consent: it acts`, async () => {
      const { f, loop } = setup({ options: { access, automation: "on" }, ...due() })
      await loop().tick()
      expect(acted(f)).toEqual(["harvest a", "sleep a"])
      expect(f.services.cost.automation()).toBe("on (consent)")
    })
  }

  test('"off" at all: nothing', async () => {
    const { f, loop } = setup({ options: { automation: "off" }, ...due() })
    await loop().tick()
    expect(acted(f)).toEqual([])
    expect(f.services.cost.automation()).toBe("off")
  })

  test("auto at all: on", async () => {
    const { f, loop } = setup(due())
    await loop().tick()
    expect(acted(f)).toEqual(["harvest a", "sleep a"])
    expect(f.services.cost.automation()).toBe("on")
  })

  test("startAutomation with no consent, no leased work and no budget reads nothing from boxd and takes no lock", async () => {
    const { f } = setup({ options: { access: "read-only" }, ...due() })
    const stop = startAutomation(f.services, { tickMs: 5 })
    await Bun.sleep(30)
    await stop()
    expect(f.calls).toEqual([])
    expect(acted(f)).toEqual([])
    expect(existsSync(join(f.services.ledgerRoot, "automation.lock"))).toBe(false)
    expect(f.watch.listeners.size).toBe(0)
  })
})

describe("one automation owner (automation.lock)", () => {
  test("two processes on one ledger: only the holder acts, the other is not-owner", async () => {
    const { f, loop } = setup({ works: [work("a")], records: [record("a")] })
    const otherCost = fakes({ works: [work("a")], records: [record("a")] })
    try {
      const first = loop()
      // The second process: its own cost port and actions, the same ledger root.
      const second = automation({ ...otherCost.services, ledgerRoot: f.services.ledgerRoot } as never)
      await first.tick()
      await second.tick()
      expect(acted(f)).toEqual(["harvest a", "sleep a"])
      expect(acted(otherCost)).toEqual([])
      expect(otherCost.services.cost.automation()).toBe("not-owner")
      expect(f.services.cost.automation()).toBe("on")
      await second.dispose()
    } finally {
      otherCost.dispose()
    }
  })

  test("the lock is given up on dispose, and the next process takes it", async () => {
    const { f, loop } = setup({ works: [work("a")], records: [record("a")] })
    const first = loop()
    await first.tick()
    await first.dispose()
    const next = fakes({ works: [work("b")], records: [record("b")] })
    try {
      const second = automation({ ...next.services, ledgerRoot: f.services.ledgerRoot } as never)
      await second.tick()
      expect(acted(next)).toEqual(["harvest b", "sleep b"])
      await second.dispose()
    } finally {
      next.dispose()
    }
  })

  test("startAutomation runs a pass at start and after an event, and stops cleanly", async () => {
    const { f } = setup({ works: [], records: [record("a")] })
    const stop = startAutomation(f.services, { tickMs: 60_000 })
    await Bun.sleep(20)
    f.watch.works = [work("a")]
    f.watch.emit({ workId: "a", to: "idle" })
    for (let i = 0; i < 50 && !acted(f).length; i++) await Bun.sleep(10)
    await stop()
    expect(acted(f)).toEqual(["harvest a", "sleep a"])
    expect(f.watch.listeners.size).toBe(0)
  })
})

describe("lease renewals (§C.2, L-2)", () => {
  const lease = (renewedHoursAgo: number, days = 1) => {
    const renewedAt = new Date(T0.getTime() - renewedHoursAgo * 3_600_000)
    return { days, renewedAt: renewedAt.toISOString(), expiresAt: new Date(renewedAt.getTime() + days * 86_400_000).toISOString() }
  }

  test("a busy work nobody calls is renewed by id once 6 hours passed, not before", async () => {
    const { f, loop } = setup({ options: { leaseDays: 1 }, works: [work("a", { phase: "busy" })], records: [record("a", { lease: lease(7) })] })
    const one = loop()
    await one.tick()
    expect(f.calls.filter((call) => call.startsWith("checkOwned") || call.startsWith("renewLease"))).toEqual(["checkOwned oc-a vm_a", "renewLease vm_a 1d"])
    expect(f.records.get("a")?.lease?.renewedAt).toBe(T0.toISOString())
    await one.tick()
    expect(f.calls.filter((call) => call.startsWith("renewLease"))).toHaveLength(1)
  })

  test("a 3-day busy work with leaseDays 1 and only notices is never deleted while the plugin runs", async () => {
    const { f, loop } = setup({ options: { leaseDays: 1 }, works: [work("a", { phase: "busy" })], records: [record("a", { lease: lease(0) })] })
    const one = loop()
    for (let hour = 0; hour <= 72; hour++) {
      f.clock.now = new Date(T0.getTime() + hour * 3_600_000)
      await one.tick()
      expect(Date.parse(f.records.get("a")!.lease!.expiresAt)).toBeGreaterThan(f.clock.now.getTime())
    }
    expect(f.calls.filter((call) => call.startsWith("renewLease")).length).toBe(Math.floor((72 * 3_600_000) / LEASE_RENEW_MS))
  })

  test("a saved idle work is not renewed; renewals need no automation consent", async () => {
    const saved = { at: T0.toISOString(), complete: true, guestVersion: "2.2.3", sessions: [] }
    const { f, loop } = setup({ options: { leaseDays: 2, access: "read-only" }, works: [work("s", { saved: "fresh" }), work("u", { phase: "busy" })], records: [record("s", { saved, lease: lease(10, 2) }), record("u", { lease: lease(10, 2) })] })
    await loop().tick()
    expect(f.calls.filter((call) => call.startsWith("renewLease"))).toEqual(["renewLease vm_u 2d"])
    expect(acted(f)).toEqual([])
  })

  test("leaseDays turned off (0) at ask-changes after works were leased: the loop still renews them, with their own length", async () => {
    const { f } = setup({ options: { leaseDays: 0, access: "ask-changes" }, works: [work("a", { phase: "busy", idleSince: undefined })], records: [record("a", { lease: lease(23, 3) })] })
    const stop = startAutomation(f.services, { tickMs: 60_000 })
    for (let i = 0; i < 50 && !f.calls.some((call) => call.startsWith("renewLease")); i++) await Bun.sleep(10)
    await stop()
    expect(f.calls.filter((call) => call.startsWith("renewLease"))).toEqual(["renewLease vm_a 3d"])
    expect(f.records.get("a")!.lease!.days).toBe(3)
    // Renewing protects the work; it is not a cleanup action, so nothing else ran.
    expect(acted(f)).toEqual([])
    // Status says the record holds a lease the current option would not set.
    expect(f.reports.get("lease")).toContain("a: 3d")
  })

  test("the lock holder has leaseDays 0 (another project leased the work for 3 days): it renews it", async () => {
    const { f, loop } = setup({ options: { leaseDays: 0 }, works: [work("a", { phase: "busy", idleSince: undefined })], records: [record("a", { lease: lease(23, 1) })] })
    await loop().tick()
    expect(f.calls.filter((call) => call.startsWith("renewLease"))).toEqual(["renewLease vm_a 1d"])
    expect(Date.parse(f.records.get("a")!.lease!.expiresAt)).toBe(T0.getTime() + 86_400_000)
  })

  test("the holder has leaseDays 1 and the work was leased for 7 days: renewed for 7, never shortened", async () => {
    const before = lease(7, 7)
    const { f, loop } = setup({ options: { leaseDays: 1 }, works: [work("a", { phase: "busy", idleSince: undefined })], records: [record("a", { lease: before })] })
    await loop().tick()
    expect(f.calls.filter((call) => call.startsWith("renewLease"))).toEqual(["renewLease vm_a 7d"])
    const after = f.records.get("a")!.lease!
    expect(after.days).toBe(7)
    expect(Date.parse(after.expiresAt)).toBeGreaterThan(Date.parse(before.expiresAt))
    expect(f.reports.get("lease")).toContain("a: 7d")
  })

  test("a lease equal to the option is not reported", async () => {
    const { f, loop } = setup({ options: { leaseDays: 1 }, works: [work("a", { phase: "busy", idleSince: undefined })], records: [record("a", { lease: lease(7, 1) })] })
    await loop().tick()
    expect(f.reports.has("lease")).toBe(false)
  })

  test("within 24 hours of the end, an idle unsaved work is harvested, and not slept for it", async () => {
    const { f, loop } = setup({ options: { leaseDays: 1, autoSleepMinutes: 0 }, works: [work("a", { idleSince: minutesAgo(T0, 1), touchedAt: minutesAgo(T0, 1) })], records: [record("a", { lease: lease(1) })] })
    f.calls.length = 0
    const one = loop()
    // Renewed 1 hour ago by a change call, so it is not renewed now; it ends in 23 hours.
    await one.tick()
    expect(acted(f)).toEqual(["harvest a"])
  })
})
