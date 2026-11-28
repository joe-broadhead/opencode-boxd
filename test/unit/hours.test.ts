// The ledger's machine-hours (design §C.4): every phase change adds the elapsed interval to the phase that was current,
// so creating, busy, idle and unreachable count as running, asleep counts as existing only, and gone or closed add
// neither. A restart, or a change missed while OpenCode was closed, counts from the record's last change and never twice.
import { afterEach, describe, expect, test } from "bun:test"
import { ledgerPort } from "../../src/ledger/index.js"
import { asHours, hoursAt, localDay, shownHours } from "../../src/ledger/hours.js"
import { Ledger } from "../../src/ledger/store.js"
import type { Phase, WorkRecord } from "../../src/ledger/types.js"
import type { MachineId } from "../../src/ports.js"
import { removeRoot, tempRoot } from "../support/ledger-fakes.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) removeRoot(root)
})

const record = (workId: string, over: Partial<WorkRecord> = {}): WorkRecord => ({
  format: 1,
  workId,
  state: "open",
  region: "fra",
  machine: `oc-${workId}`,
  machineId: `vm_${workId}` as MachineId,
  size: "2x8",
  image: { name: "oc-golden-2.4.1-2x8", opencode: "2.4.1" },
  laptopDirectory: "/work/projects/api",
  guestDirectory: `/home/boxd/work/${workId}`,
  createdAt: "2026-11-16T09:00:00.000Z",
  ...over,
})

const minutes = (count: number) => count * 60_000

describe("the ledger's machine-hours", () => {
  test("creating, busy, idle, asleep and gone: existed and running, across a restart and a change missed while closed", async () => {
    const root = tempRoot("boxd-hours-")
    roots.push(root)
    const clock = { now: new Date(2026, 10, 16, 9, 0, 0) }
    const ledger = new Ledger(root, { now: () => clock.now })
    const port = ledgerPort(ledger)
    await ledger.mutate("metered", () => record("metered", { createdAt: clock.now.toISOString() }))
    const context = { call: { callId: "hours", source: "watcher" as const } }
    const change = async (from: Phase | null, to: Phase) => {
      await port.appendEvent({ at: clock.now.toISOString(), workId: "metered", from, to }, context)
    }

    await change(null, "creating")
    clock.now = new Date(clock.now.getTime() + minutes(10))
    await change("creating", "busy")
    clock.now = new Date(clock.now.getTime() + minutes(20))
    await change("busy", "idle")
    expect((await ledger.get("metered"))?.hours).toMatchObject({ existedSeconds: 30 * 60, runningSeconds: 30 * 60, phase: "idle" })

    // The plugin restarts between two phase changes; the new ledger counts from what the record keeps, not from zero.
    const restarted = new Ledger(root, { now: () => clock.now })
    const after = ledgerPort(restarted)
    clock.now = new Date(clock.now.getTime() + minutes(15))
    await after.appendEvent({ at: clock.now.toISOString(), workId: "metered", from: "idle", to: "asleep" }, context)
    expect((await restarted.get("metered"))?.hours).toMatchObject({ existedSeconds: 45 * 60, runningSeconds: 45 * 60, phase: "asleep" })

    // A phase change OpenCode missed while it was closed: the gap counts from the record's last change, once.
    clock.now = new Date(clock.now.getTime() + minutes(30))
    await after.appendEvent({ at: clock.now.toISOString(), workId: "metered", from: "asleep", to: "gone" }, context)
    expect((await restarted.get("metered"))?.hours).toMatchObject({ existedSeconds: 75 * 60, runningSeconds: 45 * 60, phase: "gone" })

    // Gone adds nothing until the work comes back; creating and busy do.
    clock.now = new Date(clock.now.getTime() + minutes(60))
    await after.appendEvent({ at: clock.now.toISOString(), workId: "metered", from: "gone", to: "creating" }, context)
    clock.now = new Date(clock.now.getTime() + minutes(5))
    await after.appendEvent({ at: clock.now.toISOString(), workId: "metered", from: "creating", to: "busy" }, context)
    const hours = (await restarted.get("metered"))!.hours!
    expect(hours).toMatchObject({ existedSeconds: 80 * 60, runningSeconds: 50 * 60, phase: "busy", at: clock.now.toISOString() })
    expect(shownHours(hours)).toEqual({ existed: asHours(80 * 60), running: asHours(50 * 60) })
    // Reading it now adds no second to the record.
    expect(hoursAt((await restarted.get("metered"))!, clock.now)).toMatchObject({ existedSeconds: 80 * 60, runningSeconds: 50 * 60 })
  })

  test("today's counters keep only the part after local midnight, while the cumulative counters keep the whole interval", async () => {
    const root = tempRoot("boxd-hours-day-")
    roots.push(root)
    const clock = { now: new Date(2026, 10, 16, 23, 30, 0) }
    const ledger = new Ledger(root, { now: () => clock.now })
    const port = ledgerPort(ledger)
    await ledger.mutate("day", () => record("day", { createdAt: clock.now.toISOString() }))
    const context = { call: { callId: "hours", source: "watcher" as const } }
    const change = async (from: Phase | null, to: Phase) => {
      await port.appendEvent({ at: clock.now.toISOString(), workId: "day", from, to }, context)
    }

    await change(null, "creating")
    clock.now = new Date(clock.now.getTime() + minutes(20))
    await change("creating", "idle")
    expect((await ledger.get("day"))!.hours).toMatchObject({ existedSeconds: 20 * 60, runningSeconds: 20 * 60, todayExistedSeconds: 20 * 60, todayRunningSeconds: 20 * 60 })

    // 23:50 to 00:10: the cumulative counters take 20 minutes, today's only the 10 after midnight.
    clock.now = new Date(clock.now.getTime() + minutes(20))
    await change("idle", "asleep")
    expect((await ledger.get("day"))!.hours).toMatchObject({
      existedSeconds: 40 * 60,
      runningSeconds: 40 * 60,
      todayExistedSeconds: 10 * 60,
      todayRunningSeconds: 10 * 60,
      day: localDay(clock.now),
    })

    clock.now = new Date(clock.now.getTime() + minutes(30))
    await change("asleep", "gone")
    const hours = (await ledger.get("day"))!.hours!
    expect(hours).toMatchObject({ existedSeconds: 70 * 60, runningSeconds: 40 * 60, todayExistedSeconds: 40 * 60, todayRunningSeconds: 10 * 60 })
  })
})
