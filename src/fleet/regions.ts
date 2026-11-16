/**
 * Where a new work goes (design §3.4 step 3), owned by package C1.
 *
 * - `auto` picks the region with the most free machines after the option `keepFree`, counting this process's creates
 *   still in flight. It prefers a region that already has the golden image for the size, unless another region has
 *   `PREFER_IMAGE_MARGIN` or more free machines than it.
 * - A named region is used as asked; `keepFree` is for `auto` only. It still answers `MACHINE_LIMIT` when the region is
 *   full, naming the other region when that has room.
 * - `MACHINE_LIMIT` carries `limit`, `inUse` and `free` per region, from boxd's machine limit (cached 60 s), with this
 *   process's creates in flight already taken off `free`.
 */
import { boxdError, BoxdError } from "../errors.js"
import type { RegionChoice } from "../options.js"
import { REGIONS, type Region, type RegionLimit } from "../ports.js"

/** `auto` gives up the region with the image only for one with at least this many more free machines. */
export const PREFER_IMAGE_MARGIN = 50

/** This process's creates in flight per region: a create counts from before its CLI call until it lands or fails. */
export class InFlight {
  readonly #count = new Map<Region, number>()

  of(region: Region): number {
    return this.#count.get(region) ?? 0
  }

  /** Counts one create in `region`; the returned function stops counting it (call it once, in a `finally`). */
  reserve(region: Region): () => void {
    this.#count.set(region, this.of(region) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.#count.set(region, Math.max(0, this.of(region) - 1))
    }
  }
}

export interface RegionInput {
  readonly choice: RegionChoice
  readonly limits: readonly RegionLimit[]
  readonly keepFree: Readonly<Record<Region, number>>
  readonly inFlight: InFlight
  /** The regions that hold the golden image this work needs. */
  readonly withImage: ReadonlySet<Region>
}

/** One region's headroom, as the refusal reports it: boxd's numbers, less this process's creates in flight. */
export function headroom(limits: readonly RegionLimit[], inFlight: InFlight): RegionLimit[] {
  return REGIONS.map((region) => {
    const known = limits.find((entry) => entry.region === region)
    const pending = inFlight.of(region)
    if (!known) return { region, limit: 0, inUse: pending, free: 0 }
    return { region, limit: known.limit, inUse: known.inUse + pending, free: Math.max(0, known.free - pending) }
  })
}

/** Picks the region for a new work, or throws `MACHINE_LIMIT` with every region's numbers. */
export function pickRegion(input: RegionInput): Region {
  const rows = headroom(input.limits, input.inFlight)
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
export function limitAtCreate(error: BoxdError, region: Region, limits: readonly RegionLimit[], inFlight: InFlight): BoxdError {
  const rows = headroom(limits, inFlight).map((row) => (row.region === region ? { ...row, free: 0 } : row))
  return limitError(rows, `boxd refused a new machine in ${region}: ${error.what} (${describe(rows)}).${otherAdvice(rows, region)}`)
}
