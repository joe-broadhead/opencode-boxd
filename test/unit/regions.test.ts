// Where a new work goes (design §3.4 step 3, §7.1 "Regions"): auto picks by free machines after keepFree, counts this
// process's creates in flight, prefers the region with the image unless the other has 50 or more free machines more,
// and answers MACHINE_LIMIT with every region's numbers.
import { describe, expect, test } from "bun:test"
import { BoxdError, boxdError } from "../../src/errors.js"
import { headroom, InFlight, inUseOf, limitAtCreate, pickRegion, PREFER_IMAGE_MARGIN, type InUse } from "../../src/fleet/regions.js"
import type { Region, RegionLimit } from "../../src/ports.js"

const limits = (fra: [number, number], nyc: [number, number]): RegionLimit[] => [
  { region: "fra", limit: fra[0], inUse: fra[1], free: fra[0] - fra[1] },
  { region: "nyc", limit: nyc[0], inUse: nyc[1], free: nyc[0] - nyc[1] },
]
const none = new Set<Region>()
/** What a listing taken at `since` shows in use: the machines the limits say are in use. */
const usedBy = (rows: readonly RegionLimit[], since = 0): InUse => ({ counts: { fra: rows[0]!.inUse, nyc: rows[1]!.inUse }, since })
const ALL: readonly Region[] = ["fra", "nyc"]
const pick = (input: Partial<Parameters<typeof pickRegion>[0]> & { limits: RegionLimit[] }) =>
  pickRegion({ choice: "auto", keepFree: { fra: 0, nyc: 0 }, inFlight: new InFlight(), withImage: none, used: usedBy(input.limits), allowed: ALL, ...input })

function refusal(run: () => unknown): BoxdError {
  try {
    run()
  } catch (error) {
    if (error instanceof BoxdError) return error
    throw error
  }
  throw new Error("expected a refusal")
}

describe("auto", () => {
  test("picks the region with the most free machines, and fra on a tie", () => {
    expect(pick({ limits: limits([300, 290], [300, 100]) })).toBe("nyc")
    expect(pick({ limits: limits([300, 10], [300, 100]) })).toBe("fra")
    expect(pick({ limits: limits([300, 100], [300, 100]) })).toBe("fra")
  })

  test("keepFree is taken off each region's free machines first", () => {
    // fra has 40 free and nyc 30, but fra keeps 20 for the CI pool: nyc has more to give.
    expect(pick({ limits: limits([300, 260], [300, 270]), keepFree: { fra: 20, nyc: 0 } })).toBe("nyc")
    // A region whose free machines are all kept is not a choice at all.
    expect(pick({ limits: limits([300, 295], [300, 299]), keepFree: { fra: 5, nyc: 0 } })).toBe("nyc")
  })

  test("counts this process's creates in flight, and a failed one no more once it ends", () => {
    const inFlight = new InFlight()
    const ends = Array.from({ length: 30 }, () => inFlight.reserve("fra"))
    expect(pick({ limits: limits([300, 260], [300, 270]), inFlight })).toBe("nyc")
    for (const end of ends) end(false)
    // Ending twice does nothing more.
    ends[0]!(true)
    expect(inFlight.of("fra", 0)).toBe(0)
    expect(pick({ limits: limits([300, 260], [300, 270]), inFlight })).toBe("fra")
  })

  test("a landed create stays counted until a listing asked for after it shows it (MEDIUM-3)", () => {
    let clock = 1_000
    const inFlight = new InFlight(() => clock)
    // The listing was asked for at 1000; three creates land in fra after it.
    for (let index = 0; index < 3; index++) {
      clock += 10
      inFlight.reserve("fra")(true)
    }
    const stale = inUseOf([{ region: "fra" }, { region: "fra" }], 1_000)
    expect(headroom([{ region: "fra", limit: 5, inUse: 0, free: 5 }, { region: "nyc", limit: 5, inUse: 0, free: 5 }], stale, inFlight, ALL)[0]).toEqual({ region: "fra", limit: 5, inUse: 5, free: 0 })
    // A listing asked for after they landed shows them itself: they are not counted twice.
    const fresh = inUseOf([{ region: "fra" }, { region: "fra" }, { region: "fra" }, { region: "fra" }, { region: "fra" }], clock + 1)
    expect(headroom([{ region: "fra", limit: 5, inUse: 0, free: 5 }, { region: "nyc", limit: 5, inUse: 0, free: 5 }], fresh, inFlight, ALL)[0]).toEqual({ region: "fra", limit: 5, inUse: 5, free: 0 })
  })

  test("prefers the region that has the golden image, unless the other has 50 or more free machines more", () => {
    const withImage = new Set<Region>(["nyc"])
    expect(pick({ limits: limits([300, 100], [300, 100 + PREFER_IMAGE_MARGIN - 1]), withImage })).toBe("nyc")
    expect(pick({ limits: limits([300, 100], [300, 100 + PREFER_IMAGE_MARGIN]), withImage })).toBe("fra")
    // An image in a full region does not help.
    expect(pick({ limits: limits([300, 100], [300, 300]), withImage })).toBe("fra")
  })

  test("every region full: MACHINE_LIMIT with limit, inUse and free per region, creates in flight included", () => {
    const inFlight = new InFlight()
    inFlight.reserve("nyc")
    const error = refusal(() => pick({ limits: limits([2, 2], [3, 2]), inFlight }))
    expect(error.code).toBe("MACHINE_LIMIT")
    expect(error.details.limit).toEqual([
      { region: "fra", limit: 2, inUse: 2, free: 0 },
      { region: "nyc", limit: 3, inUse: 3, free: 0 },
    ])
    expect(error.what).toContain("fra: 2 of 2 in use, 0 free; nyc: 3 of 3 in use, 0 free")
    expect(error.next).toContain("boxd manage machine-limit request --max-vms")
  })

  test("full only because of keepFree: MACHINE_LIMIT says what keepFree holds back", () => {
    const error = refusal(() => pick({ limits: limits([300, 290], [300, 295]), keepFree: { fra: 10, nyc: 5 } }))
    expect(error.code).toBe("MACHINE_LIMIT")
    expect(error.what).toContain("keepFree holds back 10 in fra and 5 in nyc")
  })
})

describe("a named region", () => {
  test("is used as asked, whatever keepFree says", () => {
    expect(pick({ choice: "nyc", limits: limits([300, 0], [300, 299]), keepFree: { fra: 0, nyc: 10 } })).toBe("nyc")
  })

  test("full: MACHINE_LIMIT names the other region when it has room", () => {
    const error = refusal(() => pick({ choice: "fra", limits: limits([300, 300], [300, 12]) }))
    expect(error.code).toBe("MACHINE_LIMIT")
    expect(error.what).toContain('nyc has 288 free: pass region: "nyc"')
    const both = refusal(() => pick({ choice: "fra", limits: limits([300, 300], [10, 10]) }))
    expect(both.what).toContain("No other region has room either")
  })
})

describe("boxd's own limit refusal at create", () => {
  test("carries every region's numbers, with the refusing region at zero free", () => {
    const rows = limits([300, 290], [300, 100])
    const error = limitAtCreate(boxdError("MACHINE_LIMIT", "your org has reached its machine limit"), "fra", rows, usedBy(rows), new InFlight(), ALL)
    expect(error.code).toBe("MACHINE_LIMIT")
    expect(error.details.limit).toEqual([
      { region: "fra", limit: 300, inUse: 290, free: 0 },
      { region: "nyc", limit: 300, inUse: 100, free: 200 },
    ])
    expect(error.what).toContain('nyc has 200 free: pass region: "nyc"')
  })

  test("headroom reports a region boxd did not list as having no room", () => {
    expect(headroom([{ region: "fra", limit: 5, inUse: 1, free: 4 }], { counts: { fra: 1, nyc: 0 }, since: 0 }, new InFlight(), ALL)).toEqual([
      { region: "fra", limit: 5, inUse: 1, free: 4 },
      { region: "nyc", limit: 0, inUse: 0, free: 0 },
    ])
  })
})

describe("the regions allowlist", () => {
  test("auto considers only allowed regions, even when another has more free machines", () => {
    // nyc has 200 free and fra 10, but only fra is allowed.
    expect(pick({ limits: limits([300, 290], [300, 100]), allowed: ["fra"] })).toBe("fra")
    expect(pick({ limits: limits([300, 290], [300, 100]), allowed: ["nyc"] })).toBe("nyc")
    // A region outside the allowlist is not even a row of headroom.
    expect(headroom(limits([300, 290], [300, 100]), usedBy(limits([300, 290], [300, 100])), new InFlight(), ["fra"])).toEqual([{ region: "fra", limit: 300, inUse: 290, free: 10 }])
  })

  test("auto on a full allowed region answers MACHINE_LIMIT with allowed rows only, never falling back to nyc", () => {
    const error = refusal(() => pick({ limits: limits([2, 2], [300, 0]), allowed: ["fra"] }))
    expect(error.code).toBe("MACHINE_LIMIT")
    expect(error.details.limit).toEqual([{ region: "fra", limit: 2, inUse: 2, free: 0 }])
    expect(error.what).toContain("fra: 2 of 2 in use, 0 free")
    expect(error.what).not.toContain("nyc")
    expect(error.what).toContain('The option "regions" allows only "fra", so no other region is tried')
    expect(error.next).toContain("boxd manage machine-limit request --max-vms")
  })

  test("keepFree still applies inside the allowlist: a kept region is not replaced by an unlisted one", () => {
    const error = refusal(() => pick({ limits: limits([300, 295], [300, 0]), keepFree: { fra: 5, nyc: 0 }, allowed: ["fra"] }))
    expect(error.code).toBe("MACHINE_LIMIT")
    expect(error.what).toContain("keepFree holds back 5 in fra")
    expect(error.details.limit).toEqual([{ region: "fra", limit: 300, inUse: 295, free: 5 }])
    // With the allowlist and keepFree both satisfied, fra is picked.
    expect(pick({ limits: limits([300, 294], [300, 0]), keepFree: { fra: 5, nyc: 0 }, allowed: ["fra"] })).toBe("fra")
  })

  test("a named region outside the allowlist is refused REGION_NOT_ALLOWED before anything is created", () => {
    const error = refusal(() => pick({ choice: "nyc", limits: limits([300, 0], [300, 0]), allowed: ["fra"] }))
    expect(error.code).toBe("REGION_NOT_ALLOWED")
    expect(error.details).toMatchObject({ region: "nyc", allowed: ["fra"] })
    expect(error.what).toContain('allows only "fra"')
    expect(error.next).toContain("/boxd-status")
  })

  test("boxd's own limit refusal carries rows for allowed regions only", () => {
    const rows = limits([300, 300], [300, 0])
    const error = limitAtCreate(boxdError("MACHINE_LIMIT", "your org has reached its machine limit"), "fra", rows, usedBy(rows), new InFlight(), ["fra"])
    expect(error.details.limit).toEqual([{ region: "fra", limit: 300, inUse: 300, free: 0 }])
    expect(error.what).toContain("No other region has room either")
    expect(error.what).toContain('The option "regions" allows only "fra"')
  })

  test("a resume rebuild outside the allowlist reports its own region and a next step resume can take", () => {
    const rows = limits([300, 0], [1, 1])
    const error = limitAtCreate(boxdError("MACHINE_LIMIT", "your org has reached its machine limit"), "nyc", rows, usedBy(rows), new InFlight(), ["fra"])
    expect(error.details.limit).toEqual([
      { region: "fra", limit: 300, inUse: 0, free: 300 },
      { region: "nyc", limit: 1, inUse: 1, free: 0 },
    ])
    expect(error.what).toContain("This work is rebuilt in nyc")
    expect(error.what).toContain("free a machine there with boxd_drop or boxd_reassign")
    expect(error.what).not.toContain('pass region: "fra"')
  })
})
