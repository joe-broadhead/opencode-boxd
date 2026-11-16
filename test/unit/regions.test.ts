// Where a new work goes (design §3.4 step 3, §7.1 "Regions"): auto picks by free machines after keepFree, counts this
// process's creates in flight, prefers the region with the image unless the other has 50 or more free machines more,
// and answers MACHINE_LIMIT with every region's numbers.
import { describe, expect, test } from "bun:test"
import { BoxdError, boxdError } from "../../src/errors.js"
import { headroom, InFlight, limitAtCreate, pickRegion, PREFER_IMAGE_MARGIN } from "../../src/fleet/regions.js"
import type { Region, RegionLimit } from "../../src/ports.js"

const limits = (fra: [number, number], nyc: [number, number]): RegionLimit[] => [
  { region: "fra", limit: fra[0], inUse: fra[1], free: fra[0] - fra[1] },
  { region: "nyc", limit: nyc[0], inUse: nyc[1], free: nyc[0] - nyc[1] },
]
const none = new Set<Region>()
const pick = (input: Partial<Parameters<typeof pickRegion>[0]> & { limits: RegionLimit[] }) =>
  pickRegion({ choice: "auto", keepFree: { fra: 0, nyc: 0 }, inFlight: new InFlight(), withImage: none, ...input })

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

  test("counts this process's creates still in flight, and stops counting one when it lands or fails", () => {
    const inFlight = new InFlight()
    const releases = Array.from({ length: 30 }, () => inFlight.reserve("fra"))
    expect(pick({ limits: limits([300, 260], [300, 270]), inFlight })).toBe("nyc")
    for (const release of releases) release()
    // Releasing twice does nothing more.
    releases[0]!()
    expect(inFlight.of("fra")).toBe(0)
    expect(pick({ limits: limits([300, 260], [300, 270]), inFlight })).toBe("fra")
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
    const error = limitAtCreate(boxdError("MACHINE_LIMIT", "your org has reached its machine limit"), "fra", limits([300, 290], [300, 100]), new InFlight())
    expect(error.code).toBe("MACHINE_LIMIT")
    expect(error.details.limit).toEqual([
      { region: "fra", limit: 300, inUse: 290, free: 0 },
      { region: "nyc", limit: 300, inUse: 100, free: 200 },
    ])
    expect(error.what).toContain('nyc has 200 free: pass region: "nyc"')
  })

  test("headroom reports a region boxd did not list as having no room", () => {
    expect(headroom([{ region: "fra", limit: 5, inUse: 1, free: 4 }], new InFlight())).toEqual([
      { region: "fra", limit: 5, inUse: 1, free: 4 },
      { region: "nyc", limit: 0, inUse: 0, free: 0 },
    ])
  })
})
