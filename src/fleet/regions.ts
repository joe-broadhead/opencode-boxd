/**
 * Where a new work goes (design §3.4 step 3), owned by package C1.
 *
 * - The option `regions` is the allowlist: a new machine is placed only in one of those regions, and a region outside it
 *   answers `REGION_NOT_ALLOWED` before anything is created. The allowlist never moves, reads or resumes an existing
 *   work; it pins new placement only.
 * - `auto` picks the region with the most free machines after the option `keepFree`, among the allowed regions and no
 *   other, counting this process's creates still in flight. It prefers a region that already has the golden image for
 *   the size, unless another allowed region has `PREFER_IMAGE_MARGIN` or more free machines than it.
 * - A named region is used as asked when it is allowed; `keepFree` is for `auto` only. It still answers `MACHINE_LIMIT`
 *   when the region is full, naming another allowed region when that has room. `MACHINE_LIMIT` carries a row per allowed
 *   region, and says the allowlist when it excludes one.
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

/** A list of regions, spelled the same way in every message: `"fra", "nyc"`. */
export const regionsText = (regions: readonly Region[]) => regions.map((region) => `"${region}"`).join(", ")

/** The allowlist in boxd's region order, without repeats: the one order a pick, its rows and its refusal use. */
const ordered = (regions: readonly Region[]) => REGIONS.filter((region) => regions.includes(region))

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
  /** The option `regions`: where a new machine may be placed. Never empty when it comes from the plugin options. */
  readonly allowed: readonly Region[]
}

/**
 * Each allowed region's headroom, as the refusal reports it: boxd's limit, the listing's machines and this process's
 * creates. A region outside the allowlist has no row: no new work goes there.
 */
export function headroom(limits: readonly RegionLimit[], used: InUse, inFlight: InFlight, allowed: readonly Region[]): RegionLimit[] {
  return ordered(allowed).map((region) => {
    const limit = limits.find((entry) => entry.region === region)?.limit ?? 0
    const inUse = used.counts[region] + inFlight.of(region, used.since)
    return { region, limit, inUse, free: Math.max(0, limit - inUse) }
  })
}

/** Picks the region for a new work, or throws `MACHINE_LIMIT` with every allowed region's numbers. */
export function pickRegion(input: RegionInput): Region {
  const allowed = ordered(input.allowed)
  // The options refuse an empty list; a caller that still passes one places nothing rather than falling back to every region.
  if (allowed.length === 0) throw boxdError("REGION_NOT_ALLOWED", 'The plugin option "regions" lists no region, so nothing can be placed. Add one and restart OpenCode.')
  const rows = headroom(input.limits, input.used, input.inFlight, allowed)
  const free = (region: Region) => rows.find((row) => row.region === region)!.free
  if (input.choice !== "auto") {
    if (!allowed.includes(input.choice)) {
      throw boxdError("REGION_NOT_ALLOWED", `A new work was asked for region "${input.choice}", and the plugin option "regions" allows only ${regionsText(allowed)}; nothing was created.`, {
        region: input.choice,
        allowed,
      })
    }
    if (free(input.choice) > 0) return input.choice
    throw limitError(rows, `${input.choice} has no free machine (${describe(rows)}).${otherAdvice(rows, input.choice)}`, allowed)
  }
  // After keepFree: the machines auto may take in each allowed region.
  const spare = (region: Region) => free(region) - (input.keepFree[region] ?? 0)
  const open = allowed.filter((region) => spare(region) > 0)
  if (open.length === 0) {
    const kept = allowed.filter((region) => (input.keepFree[region] ?? 0) > 0)
    const keep = kept.length ? ` keepFree holds back ${kept.map((region) => `${input.keepFree[region]} in ${region}`).join(" and ")}.` : ""
    throw limitError(rows, `No region has a free machine for region "auto" (${describe(rows)}).${keep}`, allowed)
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

function limitError(rows: readonly RegionLimit[], message: string, allowed: readonly Region[]): BoxdError {
  const note = allowed.length === REGIONS.length ? "" : ` The option "regions" allows only ${regionsText(allowed)}, so no other region is tried.`
  return boxdError("MACHINE_LIMIT", `${message}${note}`, { limit: rows })
}

/**
 * boxd's own limit refusal at create time, as `MACHINE_LIMIT` with every allowed region's numbers (the cached ones,
 * which the refusal has just shown to be optimistic for `region`).
 */
export function limitAtCreate(error: BoxdError, region: Region, limits: readonly RegionLimit[], used: InUse, inFlight: InFlight, allowed: readonly Region[]): BoxdError {
  const listed = ordered(allowed)
  const rows = headroom(limits, used, inFlight, listed).map((row) => (row.region === region ? { ...row, free: 0 } : row))
  return limitError(rows, `boxd refused a new machine in ${region}: ${error.what} (${describe(rows)}).${otherAdvice(rows, region)}`, listed)
}
