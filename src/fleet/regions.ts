/**
 * Where a new work goes (design §3.4 step 3), owned by package C1.
 *
 * - `auto` picks the region with the most free machines after the option `keepFree`, counting this process's creates
 *   still in flight. It prefers a region that already has the golden image for the size, unless another region has
 *   `PREFER_IMAGE_MARGIN` or more free machines than it.
 * - A named region is used as asked; `keepFree` is for `auto` only. It still answers `MACHINE_LIMIT` when the region is
 *   full, naming the other region when that has room.
 * - **What is in use** comes from the all-region listing the caller took in this call, not from the machine-limit
 *   answer, which boxd's port caches for 60 s and which a create does not refresh. The listing shows every machine that
 *   landed before it was asked for; this process's creates still in flight, and those that landed after the listing
 *   was asked for, are added on top. So a list of creates never counts a landed machine as free again.
 * - `MACHINE_LIMIT` carries `limit`, `inUse` and `free` per region: boxd's limit, and that count.
 */
import { boxdError, BoxdError } from "../errors.js"
import type { RegionChoice } from "../options.js"
import { REGIONS, type Region, type RegionLimit } from "../ports.js"

/** `auto` gives up the region with the image only for one with at least this many more free machines. */
export const PREFER_IMAGE_MARGIN = 50

/** How long a landed create is remembered: far longer than any listing a caller could still be holding. */
const LANDED_MEMORY_MS = 10 * 60_000

/**
 * This process's creates per region: those in flight (from before the CLI call until it answers), and those that
 * landed, with when, so a listing asked for before a create landed does not miss it.
 */
export class InFlight {
  readonly #flying = new Map<Region, number>()
  #landed: Array<{ readonly region: Region; readonly at: number }> = []
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /** Creates in `region` that a listing asked for at `since` cannot show: in flight, or landed at or after `since`. */
  of(region: Region, since: number): number {
    const floor = this.#now() - LANDED_MEMORY_MS
    this.#landed = this.#landed.filter((entry) => entry.at >= floor)
    return (this.#flying.get(region) ?? 0) + this.#landed.filter((entry) => entry.region === region && entry.at >= since).length
  }

  /** Counts one create in `region`; the returned function ends it, as landed or not (call it once, in a `finally`). */
  reserve(region: Region): (landed: boolean) => void {
    this.#flying.set(region, (this.#flying.get(region) ?? 0) + 1)
    let ended = false
    return (landed) => {
      if (ended) return
      ended = true
      this.#flying.set(region, Math.max(0, (this.#flying.get(region) ?? 0) - 1))
      if (landed) this.#landed.push({ region, at: this.#now() })
    }
  }
}

/** The machines in use per region, from an all-region listing, and when that listing was asked for. */
export interface InUse {
  readonly counts: Readonly<Record<Region, number>>
  readonly since: number
}

/** Counts a listing's machines per region; `since` is when the caller asked for it. */
export function inUseOf(machines: ReadonlyArray<{ readonly region: Region }>, since: number): InUse {
  const counts = Object.fromEntries(REGIONS.map((region) => [region, machines.filter((machine) => machine.region === region).length])) as Record<Region, number>
  return { counts, since }
}

export interface RegionInput {
  readonly choice: RegionChoice
  readonly limits: readonly RegionLimit[]
  readonly keepFree: Readonly<Record<Region, number>>
  readonly inFlight: InFlight
  /** What is in use now, from this call's all-region listing. */
  readonly used: InUse
  /** The regions that hold the golden image this work needs. */
  readonly withImage: ReadonlySet<Region>
}

/** Each region's headroom, as the refusal reports it: boxd's limit, the listing's machines and this process's creates. */
export function headroom(limits: readonly RegionLimit[], used: InUse, inFlight: InFlight): RegionLimit[] {
  return REGIONS.map((region) => {
    const limit = limits.find((entry) => entry.region === region)?.limit ?? 0
    const inUse = used.counts[region] + inFlight.of(region, used.since)
    return { region, limit, inUse, free: Math.max(0, limit - inUse) }
  })
}

/** Picks the region for a new work, or throws `MACHINE_LIMIT` with every region's numbers. */
export function pickRegion(input: RegionInput): Region {
  const rows = headroom(input.limits, input.used, input.inFlight)
  const free = (region: Region) => rows.find((row) => row.region === region)!.free
  if (input.choice !== "auto") {
    if (free(input.choice) > 0) return input.choice
    throw limitError(rows, `${input.choice} has no free machine (${describe(rows)}).${otherAdvice(rows, input.choice)}`)
  }
  // After keepFree: the machines auto may take in each region.
  const spare = (region: Region) => free(region) - (input.keepFree[region] ?? 0)
  const open = REGIONS.filter((region) => spare(region) > 0)
  if (open.length === 0) {
    const kept = REGIONS.filter((region) => (input.keepFree[region] ?? 0) > 0)
    const keep = kept.length ? ` keepFree holds back ${kept.map((region) => `${input.keepFree[region]} in ${region}`).join(" and ")}.` : ""
    throw limitError(rows, `No region has a free machine for region "auto" (${describe(rows)}).${keep}`)
  }
  const ranked = [...open].sort((a, b) => spare(b) - spare(a) || REGIONS.indexOf(a) - REGIONS.indexOf(b))
  const best = ranked[0]!
  const imaged = ranked.find((region) => input.withImage.has(region))
  if (imaged && imaged !== best && spare(best) - spare(imaged) < PREFER_IMAGE_MARGIN) return imaged
  return best
}

function describe(rows: readonly RegionLimit[]): string {
  return rows.map((row) => `${row.region}: ${row.inUse} of ${row.limit} in use, ${row.free} free`).join("; ")
}

function otherAdvice(rows: readonly RegionLimit[], full: Region): string {
  const other = rows.find((row) => row.region !== full && row.free > 0)
  return other ? ` ${other.region} has ${other.free} free: pass region: "${other.region}".` : " No other region has room either."
}

function limitError(rows: readonly RegionLimit[], message: string): BoxdError {
  return boxdError("MACHINE_LIMIT", message, { limit: rows })
}

/**
 * boxd's own limit refusal at create time, as `MACHINE_LIMIT` with every region's numbers (the cached ones, which the
 * refusal has just shown to be optimistic for `region`).
 */
export function limitAtCreate(error: BoxdError, region: Region, limits: readonly RegionLimit[], used: InUse, inFlight: InFlight): BoxdError {
  const rows = headroom(limits, used, inFlight).map((row) => (row.region === region ? { ...row, free: 0 } : row))
  return limitError(rows, `boxd refused a new machine in ${region}: ${error.what} (${describe(rows)}).${otherAdvice(rows, region)}`)
}
