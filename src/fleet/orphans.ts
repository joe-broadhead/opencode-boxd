/**
 * The machine classes of design §3.1 (#83): every machine in the organisation is one of a work here, a work in another
 * ledger, a kept machine, a golden builder, or an orphan. An orphan says why it has no owner and whether the plugin may
 * act on it: only a session machine is ever actionable, so a machine the plugin did not make stays out of every rule.
 *
 * One classification serves both the status read and the orphan adoption, so a machine's class never differs between
 * the list and the call that acts on it.
 */
import type { WorkRecord } from "../ledger/types.js"
import { BUILDER_LABELS, LEDGER_LABEL, WORK_LABELS, type MachineRow, type Region } from "../ports.js"
import type { MachineClass, MachineSummary, OrphanMachine, OrphanReason } from "../results.js"

/** A work id as a machine name carries it: `oc-<id>`. */
export const WORK_ID = /^[a-z][a-z0-9-]{0,24}$/

/** The work id a machine name names, when it is `oc-<id>`. */
export function workIdOf(name: string): string | undefined {
  const id = name.startsWith("oc-") ? name.slice(3) : undefined
  return id !== undefined && WORK_ID.test(id) ? id : undefined
}

/** The plugin's labels before `ledger`: an owner label, or `role=session` with a `work` label. */
function legacyLabels(labels: Readonly<Record<string, string>>): boolean {
  return labels.owner === WORK_LABELS.owner || (labels.role === WORK_LABELS.role && labels.work !== undefined)
}

/** Whether a `keep` selector matches: a bare key by its presence, `key=value` by its value. */
function kept(labels: Readonly<Record<string, string>>, selectors: readonly string[]): boolean {
  return selectors.some((selector) => {
    const at = selector.indexOf("=")
    return at < 0 ? labels[selector] !== undefined : labels[selector.slice(0, at)] === selector.slice(at + 1)
  })
}

/** One machine, classified: the listing row and what it is. */
export interface Classified {
  readonly row: MachineRow
  readonly machineClass: MachineClass
  readonly why?: OrphanReason
  readonly actionable: boolean
  /** The work id its name names, when the name is `oc-<id>`. */
  readonly workId?: string
}

/** The one call that adopts an actionable orphan. */
const adopts = (workId: string) => `boxd_ensure({ workId: ${JSON.stringify(workId)} }) adopts it`

/**
 * Every machine's class, in listing order, within the optional region. A record, a builder, another ledger's label and
 * a `keep` selector win over orphan, in that order: a selector cannot take a machine that an owner already names.
 */
export function classifyMachines(machines: readonly MachineRow[], records: readonly WorkRecord[], ledgerId: string | undefined, keep: readonly string[], region?: Region): readonly Classified[] {
  const byId = new Map(records.flatMap((record) => (record.machineId === null ? [] : [[record.machineId, record] as const])))
  const byName = new Set(records.map((record) => `${record.region}/${record.machine}`))
  return machines
    .filter((machine) => machine.status !== "destroyed" && (region === undefined || machine.region === region))
    .map((machine): Classified => {
      const labels = machine.labels
      const legacy = legacyLabels(labels)
      const recorded = byName.has(`${machine.region}/${machine.name}`) || (machine.id !== null && byId.has(machine.id))
      const machineClass: MachineClass = recorded
        ? "work"
        : machine.name.startsWith("oc-gb-") || labels.role === BUILDER_LABELS.role
          ? "golden"
          : labels[LEDGER_LABEL] !== undefined && labels[LEDGER_LABEL] !== ledgerId
            ? "other-ledger"
            : kept(labels, keep)
              ? "kept"
              : "orphan"
      if (machineClass !== "orphan") return { row: machine, machineClass, actionable: false }
      const why: OrphanReason = labels[LEDGER_LABEL] === undefined ? (legacy ? "legacy-labels" : "no-ledger") : "no-record"
      // A session machine is the plugin's to act on; any other orphan is someone else's, whatever its name.
      const actionable = labels.role === WORK_LABELS.role || (machine.name.startsWith("oc-") && legacy)
      const workId = workIdOf(machine.name)
      return { row: machine, machineClass, why, actionable, ...(workId ? { workId } : {}) }
    })
}

/** Every machine's class counted, with the orphans listed and capped, actionable first; the limit figures are the caller's. */
export function machineSummary(classified: readonly Classified[], limit: number): Pick<MachineSummary, "counts" | "orphans" | "more"> {
  const counts: Record<MachineClass, number> = { work: 0, "other-ledger": 0, kept: 0, golden: 0, orphan: 0 }
  const found: OrphanMachine[] = []
  for (const item of classified) {
    counts[item.machineClass] += 1
    if (item.machineClass !== "orphan") continue
    const next = !item.actionable ? "label it, or add a selector to keep" : item.workId ? adopts(item.workId) : "Remove it with the boxd CLI"
    found.push({ machine: item.row.name, region: item.row.region, status: item.row.status, why: item.why ?? "no-ledger", actionable: item.actionable, next })
  }
  found.sort((left, right) => Number(right.actionable) - Number(left.actionable) || left.machine.localeCompare(right.machine) || left.region.localeCompare(right.region))
  return { counts, orphans: found.slice(0, limit), more: Math.max(0, found.length - limit) }
}

/** A machine class's own words, for a result that skipped it. */
export function classReason(item: Classified): string {
  switch (item.machineClass) {
    case "work":
      return "a work in this ledger already records it"
    case "other-ledger":
      return "another ledger's label names it"
    case "kept":
      return "a selector in keep names it"
    case "golden":
      return "it is a golden builder"
    case "orphan":
      return item.actionable ? "an actionable orphan" : "it is not a session machine"
  }
}
