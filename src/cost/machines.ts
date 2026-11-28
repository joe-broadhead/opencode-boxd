/**
 * The machine figures a budget reads (design §C.5): every machine the all-region listing holds in any state but
 * `destroyed`, and those this ledger owns. Ownership is the ledger label, or an open record of this ledger naming the
 * machine, which covers a machine made before the label existed or one the automation pass has not labelled yet. A
 * create has no listing row yet, so a pending record or a create in flight adds one; the larger of the two is used, so
 * one create seen by both is never counted twice. Package E owns this file.
 */
import type { WorkRecord } from "../ledger/types.js"
import type { BudgetLabelMatch } from "../options.js"
import { LEDGER_LABEL, type Listing, type WorkLabels } from "../ports.js"

export interface MachineCounts {
  /** The machines this ledger holds: its labelled machines and its creates not in the listing yet. */
  readonly ledger: number
  /** Every machine in the organisation, by the same count boxd applies to its own limit. */
  readonly org: number
}

/**
 * Counts a listing's machines, plus the creates the listing cannot show yet. `pending` is the ledger's open records,
 * whose `pendingCreate` marks a claimed machine; `inFlight` is this process's creates, including the ones before their
 * record is written.
 */
export function machineCounts(listing: Listing, ledgerId: string, pending: readonly WorkRecord[], inFlight = 0): MachineCounts {
  const listed = listing.machines.filter((machine) => machine.status !== "destroyed")
  const shown = new Set(listed.map((machine) => `${machine.region}/${machine.name}`))
  const recorded = new Set<string>()
  const recordIds = new Set<string>()
  for (const record of pending) {
    if (record.state !== "open") continue
    if (record.region !== null) recorded.add(`${record.region}/${record.machine}`)
    if (record.machineId !== null) recordIds.add(record.machineId)
  }
  const ledgerNames = new Set(
    listed
      .filter((machine) => machine.labels["ledger"] === ledgerId || (machine.id !== null && recordIds.has(machine.id)) || recorded.has(`${machine.region}/${machine.name}`))
      .map((machine) => `${machine.region}/${machine.name}`),
  )
  let pendingCreates = 0
  for (const record of pending) {
    if (record.state !== "open" || record.pendingCreate === undefined || record.region === null) continue
    const key = `${record.region}/${record.machine}`
    // A create that landed after the listing was taken is counted once, and one that landed before it is already listed.
    if (!shown.has(key)) pendingCreates += 1
    // A machine that landed but lost its label is still this record's create.
    if (!ledgerNames.has(key)) ledgerNames.add(key)
  }
  const creating = Math.max(inFlight, pendingCreates)
  // A pending create is already in `ledgerNames`; only an in-flight create without a record yet is still missing.
  return { ledger: ledgerNames.size + (creating - pendingCreates), org: listed.length + creating }
}

/** Whether a work's labels carry the cap's one label. */
export const matchesLabel = (labels: WorkLabels | undefined, match: BudgetLabelMatch): boolean => labels?.[match.key] === match.value

/**
 * The machines this ledger's works with one label hold now, from its open records and a listed machine that carries
 * both this ledger's `ledger` label and the work label. A machine several slot works share is counted once, and another
 * ledger's matching machine is not counted.
 */
export function labelMachineCount(listing: Listing, records: readonly WorkRecord[], ledgerId: string, match: BudgetLabelMatch): number {
  const keys = new Set<string>()
  for (const record of records) {
    if (record.state !== "open" || record.region === null || !matchesLabel(record.labels, match)) continue
    keys.add(`${record.region}/${record.machine}`)
  }
  const label = `work.${match.key}`
  for (const machine of listing.machines) {
    if (machine.status === "destroyed" || machine.labels[LEDGER_LABEL] !== ledgerId || machine.labels[label] !== match.value) continue
    keys.add(`${machine.region}/${machine.name}`)
  }
  return keys.size
}
