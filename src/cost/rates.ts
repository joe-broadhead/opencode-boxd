/**
 * boxd's rates and the per-hour estimate (design §C.1, §C.4). Package E owns `src/cost/*`.
 *
 * boxd bills active vCPU time and resident memory while a machine runs, resident memory in standby, and written disk in
 * every state but deleted. An idle running work therefore costs about what its resident RAM and disk cost, and a
 * hibernated one only its disk. The estimate here is that arithmetic on the watcher's last guest reading: the 1-minute
 * load (capped at the machine's vCPUs) and the resident GiB, plus a fixed figure for the disk a work has written,
 * because boxd's listing does not report it.
 */
import { RUNNING_PHASES, type Phase } from "../ledger/types.js"
import { SIZE_VCPU, type Rates, type Reading, type Size } from "../ports.js"

/** boxd's published rates (boxd.sh/pricing), for a member who cannot read the organisation's own. */
export const PUBLIC_RATES: Readonly<Record<"EUR" | "USD", Rates>> = {
  EUR: { currency: "EUR", vcpuHour: 0.039, ramGiBHour: 0.012, diskGiBHour: 0.00008, source: "public" },
  USD: { currency: "USD", vcpuHour: 0.047, ramGiBHour: 0.014, diskGiBHour: 0.000096, source: "public" },
}

/** The disk a work is taken to have written: a checkout, its dependencies and OpenCode's data. */
export const DISK_GIB_ESTIMATE = 20
/** A running work with no guest reading yet: OpenCode's server at rest. */
export const DEFAULT_READING: Reading = { residentGiB: 1, load1: 0 }

export { RUNNING_PHASES }

export const isRunning = (phase: Phase) => RUNNING_PHASES.has(phase)

/** Money rounded to 4 decimals, so the per-hour figure of a hibernated work (about 0.0016) is not lost. */
export const money = (value: number) => Math.round(value * 10_000) / 10_000

/** One work's estimated cost per hour in the rates' currency. */
export function perHour(phase: Phase, size: Size, reading: Reading | undefined, rates: Rates): number {
  const disk = DISK_GIB_ESTIMATE * rates.diskGiBHour
  if (phase === "asleep") return disk
  if (!isRunning(phase)) return 0
  const read = reading ?? DEFAULT_READING
  const load = Math.min(Math.max(read.load1, 0), SIZE_VCPU[size])
  return load * rates.vcpuHour + Math.max(read.residentGiB, 0) * rates.ramGiBHour + disk
}

/** What sleeping a running work saves per hour: everything but its disk. */
export const sleepSaving = (size: Size, reading: Reading | undefined, rates: Rates) => perHour("idle", size, reading, rates) - perHour("asleep", size, reading, rates)

const READING_BASIS =
  "the last guest reading (1-minute load, capped at the machine's vCPUs, and resident GiB; 1 GiB before the first reading) + 20 GiB of written disk; disk only for asleep works"

/** How `perHour` is made, naming whose rates: the organisation's, or boxd's public ones in their own currency. */
export const basis = (rates: Pick<Rates, "source" | "currency">) =>
  rates.source === "usage"
    ? `the organisation's rates × ${READING_BASIS}`
    : `boxd's public ${rates.currency} rates (this sign-in cannot read the organisation's rates or its billing currency) × ${READING_BASIS}`
