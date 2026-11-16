// Package E's automation (design §C.2, §C.3, §7.1 "Cost and cleanup"): harvest then sleep of finished and orphaned
// works through C2's FleetActions (faked), gated by access, one owner, one guest read just before acting, lease
// renewals by id, and never a drop.
import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { automation, LEASE_RENEW_MS, startAutomation, type Automation } from "../../src/automation.js"
import { costHooks } from "../../src/hooks.js"
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
  test("idle past 10 minutes: one guest read, then harvest and sleep, tagged automation", async () => {
    const { f, loop } = setup({ works: [work("a", { idleSince: minutesAgo(T0, 11) })], records: [record("a")] })
    await loop().tick()
    expect(acted(f)).toEqual(["harvest a", "sleep a"])
    for (const call of f.actions.calls) {
      expect(call.context.by).toBe("automation")
      expect(call.context.call.source).toBe("automation")
    }
    expect(f.calls.filter((call) => call.startsWith("phase"))).toEqual(["phase oc-a"])
  })

  test("not yet due: no read, no action", async () => {
    const { f, loop } = setup({ works: [work("a", { idleSince: minutesAgo(T0, 9), touchedAt: minutesAgo(T0, 9) })], records: [record("a")] })
    await loop().tick()
    expect(acted(f)).toEqual([])
    expect(f.calls.filter((call) => call.startsWith("phase") || call === "list")).toEqual([])
  })

  test("a new prompt in the window cancels it: busy in the snapshot, or busy on the guest", async () => {
    const { f, loop } = setup({ works: [work("a", { phase: "busy", idleSince: undefined })], records: [record("a")] })
    const one = loop()
    await one.tick()
    expect(acted(f)).toEqual([])
    f.watch.works = [work("b", { idleSince: minutesAgo(T0, 30) })]
    f.records.set("b", record("b"))
    f.phases.set("b", { phase: "busy" })
    await one.tick()
    expect(acted(f)).toEqual([])
    expect(one.log.at(-1)).toMatchObject({ workId: "b", step: "skip", result: "skip" })
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

  test("a failed harvest still sleeps, and the work gets UNHARVESTED_SLEEP", async () => {
    const { f, loop } = setup({ works: [work("a")], records: [record("a")] })
    f.actions.failing.harvest = { a: "GUEST_VERSION" }
    const one = loop()
    await one.tick()
    expect(acted(f)).toEqual(["harvest a", "sleep a"])
    expect(f.records.get("a")?.warnings?.map((warning) => warning.code)).toEqual(["UNHARVESTED_SLEEP"])
    expect(one.log.filter((entry) => entry.workId === "a").map((entry) => `${entry.step}:${entry.result}`)).toEqual(["harvest:GUEST_VERSION", "sleep:ok"])
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

  test("a work waiting on a person is never slept, in the snapshot or on the guest", async () => {
    const { f, loop } = setup({ works: [work("a", { needsInput: "form" }), work("b")], records: [record("a"), record("b")] })
    f.phases.set("b", { needsInput: "permission" })
    await loop().tick()
    expect(acted(f)).toEqual([])
  })

  test("a v0 guest is read through the import port, never uploaded to", async () => {
    const { f, loop } = setup({ works: [work("old")], records: [record("old", { guestHelper: "v0" })] })
    await loop().tick()
    expect(f.calls).toContain("v0-phase oc-old")
    expect(acted(f)).toEqual(["harvest old", "sleep old"])
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

  test("the coordinator deleted (the session event): harvested and slept", async () => {
    const { f, loop } = setup({ works: [work("a", { ...fresh, notify: "ses_gone" })], records: [record("a")] })
    costHooks(f.services).sessionGone("ses_gone")
    await loop().tick()
    expect(acted(f)).toEqual(["harvest a", "sleep a"])
  })

  test("the coordinator archived or not found (the sweep's own check)", async () => {
    const { f, loop } = setup({ works: [work("a", { ...fresh, notify: "ses_arch" }), work("b", { ...fresh, notify: "ses_missing" }), work("c", { ...fresh, notify: "ses_live" })], records: [record("a"), record("b"), record("c")] })
    f.sessions.set("ses_arch", { archived: 1 })
    f.sessions.set("ses_missing", "missing")
    await loop().tick()
    expect(acted(f)).toEqual(["harvest a,b", "sleep a,b"])
  })

  test("untouched for orphanHours", async () => {
    const { f, loop } = setup({ works: [work("a", { idleSince: minutesAgo(T0, 1), touchedAt: minutesAgo(T0, 12 * 60) })], records: [record("a")] })
    await loop().tick()
    expect(acted(f)).toEqual(["harvest a", "sleep a"])
  })

  test("a busy orphan is left to finish", async () => {
    const { f, loop } = setup({ works: [work("a", { phase: "busy", notify: "ses_gone", touchedAt: minutesAgo(T0, 24 * 60) })], records: [record("a")] })
    costHooks(f.services).sessionGone("ses_gone")
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
    f.actions.matches.boxd_drop = ["a", "b", "c"]
    const one = loop()
    for (let i = 0; i < 5; i++) {
      f.clock.now = new Date(T0.getTime() + i * 40 * 60_000)
      await one.tick()
    }
    expect(f.actions.calls.some((call) => call.method === "drop")).toBe(false)
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

  test("startAutomation with no consent, no lease and no budget starts nothing", async () => {
    const { f } = setup({ options: { access: "read-only" }, ...due() })
    const stop = startAutomation(f.services, { tickMs: 5 })
    await Bun.sleep(30)
    await stop()
    expect(f.calls).toEqual([])
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

  test("within 24 hours of the end, an idle unsaved work is harvested, and not slept for it", async () => {
    const { f, loop } = setup({ options: { leaseDays: 1, autoSleepMinutes: 0 }, works: [work("a", { idleSince: minutesAgo(T0, 1), touchedAt: minutesAgo(T0, 1) })], records: [record("a", { lease: lease(1) })] })
    f.calls.length = 0
    const one = loop()
    // Renewed 1 hour ago by a change call, so it is not renewed now; it ends in 23 hours.
    await one.tick()
    expect(acted(f)).toEqual(["harvest a"])
  })
})
