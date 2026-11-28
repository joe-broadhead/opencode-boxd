// The machines block of status: every machine boxd counts, in every state, across two regions, against the
// organisation's limit, with the share this ledger's open works name; a limit that could not be read leaves the
// counts and is null.
import { describe, expect, test } from "bun:test"
import { machinesAgainstLimit } from "../../src/fleet/status.js"
import type { Classified } from "../../src/fleet/orphans.js"
import { LEDGER_LABEL, type MachineRow } from "../../src/ports.js"
import type { MachineClass } from "../../src/results.js"

const LEDGER = "a1b2c3d4e5"
const OTHER = "f6e5d4c3b2"

const machine = (name: string, region: "fra" | "nyc", status: MachineRow["status"], machineClass: MachineClass, ledger?: string): Classified => ({
  row: { name, region, id: null, status, size: "2x8", labels: ledger === undefined ? {} : { [LEDGER_LABEL]: ledger }, sharing: "private", isolated: null },
  machineClass,
  actionable: false,
})

/**
 * Machines in every state across both regions. Four are this ledger's works: `oc-a` and `oc-i` carry no label at all,
 * because a record names them, while `oc-f` carries this ledger's label with no record and stays an orphan.
 */
const MACHINES: readonly Classified[] = [
  machine("oc-a", "fra", "running", "work"),
  machine("oc-b", "fra", "running", "work", LEDGER),
  machine("oc-c", "fra", "starting", "other-ledger", OTHER),
  machine("oc-d", "fra", "standby", "orphan"),
  machine("oc-e", "fra", "hibernated", "work", LEDGER),
  machine("oc-f", "fra", "hibernated", "orphan", LEDGER),
  machine("oc-g", "fra", "stopped", "kept"),
  machine("oc-h", "nyc", "running", "golden"),
  machine("oc-i", "nyc", "hibernated", "work"),
  machine("oc-j", "nyc", "other", "orphan"),
  machine("oc-k", "nyc", "destroyed", "orphan"),
]

const LIMIT = {
  org: 1250,
  regions: [
    { region: "fra" as const, limit: 600, inUse: 7, free: 593 },
    { region: "nyc" as const, limit: 650, inUse: 3, free: 647 },
  ],
}

describe("the machines block", () => {
  test("counts every state across two regions, never the destroyed machine, and this ledger's works by their record, label or not", () => {
    expect(machinesAgainstLimit(MACHINES, LIMIT)).toEqual({
      limit: 1250,
      inUse: 10,
      free: 1240,
      byState: { running: 3, starting: 1, standby: 1, hibernated: 3, stopped: 1, other: 1 },
      works: 4,
      perRegion: [
        { region: "fra", limit: 600, inUse: 7, free: 593, byState: { running: 2, starting: 1, standby: 1, hibernated: 2, stopped: 1, other: 0 }, works: 3 },
        { region: "nyc", limit: 650, inUse: 3, free: 647, byState: { running: 1, starting: 0, standby: 0, hibernated: 1, stopped: 0, other: 1 }, works: 1 },
      ],
    })
  })

  test("a limit that could not be read is null, and every count still shows", () => {
    const block = machinesAgainstLimit(MACHINES, undefined)
    expect(block).toMatchObject({
      limit: null,
      inUse: 10,
      free: null,
      byState: { running: 3, starting: 1, standby: 1, hibernated: 3, stopped: 1, other: 1 },
      works: 4,
    })
    expect(block.perRegion.map(({ region, limit, inUse, free }) => ({ region, limit, inUse, free }))).toEqual([
      { region: "fra", limit: null, inUse: 7, free: null },
      { region: "nyc", limit: null, inUse: 3, free: null },
    ])
  })

  test("a region the limit answer omits keeps its counts and has a null limit", () => {
    const block = machinesAgainstLimit(MACHINES, { org: 700, regions: [{ region: "fra", limit: 700, inUse: 7, free: 693 }] })
    expect(block.perRegion[1]).toMatchObject({ region: "nyc", limit: null, inUse: 3, free: null })
  })
})
