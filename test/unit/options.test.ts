import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS, parseOptions, type Options } from "../../src/options.js"
import { isSupportedHost, isTestedHost, checkHost, parseVersion } from "../../src/host-version.js"
import { SUPPORTED_HOST, TESTED_HOSTS } from "../../src/constants.js"

const DEFAULTS: Options = {
  access: "all",
  allowedRoots: [],
  allowUntestedHost: false,
  regions: ["fra", "nyc"],
  region: "auto",
  keepFree: { fra: 0, nyc: 0 },
  keep: [],
  size: "2x8",
  goldenPrefix: "oc-golden",
  goldenBase: "stock",
  buildGolden: "auto",
  notices: "wake",
  autoHibernateMinutes: 120,
  automation: "auto",
  autoSleepMinutes: 10,
  orphanHours: 12,
  leaseDays: 0,
}

describe("plugin options", () => {
  test("every option is optional, with the design's defaults", () => {
    expect(parseOptions(undefined)).toEqual(DEFAULTS)
    expect(parseOptions({})).toEqual(DEFAULTS)
    expect(DEFAULT_OPTIONS).toEqual(DEFAULTS)
  })

  test("takes every documented value", () => {
    for (const access of ["all", "ask-changes", "read-only"]) expect(parseOptions({ access })).toMatchObject({ access })
    for (const regions of [["fra"], ["nyc"], ["nyc", "fra"]]) expect(parseOptions({ regions })).toMatchObject({ regions: ["fra", "nyc"].filter((region) => regions.includes(region)) })
    for (const region of ["auto", "fra", "nyc"]) expect(parseOptions({ region })).toMatchObject({ region })
    expect(parseOptions({ regions: ["fra"], region: "fra" })).toMatchObject({ regions: ["fra"], region: "fra" })
    expect(parseOptions({ regions: ["nyc"], region: "auto" })).toMatchObject({ regions: ["nyc"], region: "auto" })
    for (const size of ["1x4", "2x8", "4x16", "8x32"]) expect(parseOptions({ size })).toMatchObject({ size })
    for (const notices of ["wake", "queue", "off"]) expect(parseOptions({ notices })).toMatchObject({ notices })
    for (const buildGolden of ["auto", "never"]) expect(parseOptions({ buildGolden })).toMatchObject({ buildGolden })
    expect(parseOptions({ keepFree: { fra: 4 } })).toMatchObject({ keepFree: { fra: 4, nyc: 0 } })
    expect(parseOptions({ keep: ["role=lead", "runner", "owner=boxd", "role=lead"] })).toMatchObject({ keep: ["role=lead", "runner", "owner=boxd"] })
    expect(parseOptions({ keep: [] })).toMatchObject({ keep: [] })
    expect(parseOptions({ keep: ["team=lead", "runner", "team=lead"] })).toMatchObject({ keep: ["team=lead", "runner"] })
    expect(parseOptions({ git: { name: "Review Bot", email: "bot@example.invalid" } })).toMatchObject({ git: { name: "Review Bot", email: "bot@example.invalid" } })
    expect(parseOptions({ goldenPrefix: "team-golden", goldenBase: "opencode-golden", goldenSetup: "/srv/setup.sh" })).toMatchObject({
      goldenPrefix: "team-golden",
      goldenBase: "opencode-golden",
      goldenSetup: "/srv/setup.sh",
    })
    expect(parseOptions({ allowedRoots: ["/srv/work"], allowUntestedHost: true })).toMatchObject({ allowedRoots: ["/srv/work"], allowUntestedHost: true })
    for (const automation of ["auto", "on", "off"]) expect(parseOptions({ automation })).toMatchObject({ automation })
    expect(parseOptions({ autoHibernateMinutes: 30, autoSleepMinutes: 0, orphanHours: 1, leaseDays: 3 })).toMatchObject({ autoHibernateMinutes: 30, autoSleepMinutes: 0, orphanHours: 1, leaseDays: 3 })
    expect(parseOptions({ budget: { daily: 50, action: "refuse" } })).toMatchObject({ budget: { daily: 50, action: "refuse" } })
    expect(parseOptions({  })).toMatchObject({  })
  })

  test("refuses every value outside its rule, each as OPTIONS_INVALID with a next step", () => {
    const bad = [
      { regionn: "fra" },
      { region: "ams" },
      { regions: [] },
      { regions: ["ams"] },
      { regions: ["fra", "fra"] },
      { regions: "fra" },
      { regions: ["fra", 2] },
      { regions: ["fra"], region: "nyc" },
      { size: "16x64" },
      { size: 4 },
      { keepFree: { ams: 1 } },
      { keepFree: { fra: -1 } },
      { keepFree: { fra: 1.5 } },
      { keepFree: 3 },
      { keep: "role=lead" },
      { keep: ["Role=Lead"] },
      { keep: [""] },
      { keep: ["role lead"] },
      { keep: ["role=lead=extra"] },
      { keep: [1] },
      { keep: "team=lead" },
      { keep: ["team=lead", 2] },
      { keep: ["team=lead,bad"] },
      { git: { name: "x" } },
      { git: { name: "", email: "a@b.c" } },
      { git: { name: "x", email: "not an email" } },
      { goldenPrefix: "Not A Prefix" },
      { goldenPrefix: "x".repeat(40) },
      { goldenBase: "Not A Snapshot" },
      { goldenSetup: "relative/setup.sh" },
      { buildGolden: "always" },
      { notices: "loud" },
      { autoHibernateMinutes: 29 },
      { autoHibernateMinutes: 1441 },
      { automation: "yes" },
      { autoSleepMinutes: -1 },
      { orphanHours: 0 },
      { leaseDays: 1.5 },
      { budget: { daily: 50 } },
      { budget: { daily: 0, action: "warn" } },
      { budget: { daily: 50, action: "block" } },
      { budget: { dailyUsd: 50, action: "warn" } },
      { idleCheck: 1 },
      { allowUntestedHost: "yes" },
      { access: "write" },
      { allowedRoots: ["relative/path"] },
      [],
      "x",
    ]
    for (const raw of bad) expect(() => parseOptions(raw)).toThrow(/^OPTIONS_INVALID: .*Next step: /)
  })

  test("the regions allowlist defaults to every region, and names the accepted values when it refuses", () => {
    expect(parseOptions({})).toMatchObject({ regions: ["fra", "nyc"] })
    expect(parseOptions({ regions: ["fra"] })).toMatchObject({ regions: ["fra"] })
    expect(parseOptions({ regions: ["fra", "nyc"] })).toMatchObject({ regions: ["fra", "nyc"] })
    // "fra", "nyc", the accepted values, and the options example are all in the refusal.
    expect(() => parseOptions({ regions: ["ams"] })).toThrow(/^OPTIONS_INVALID: .*lists "ams", which is not a region; list "fra", "nyc"\..*"plugins": \[\{ "package": "github:we-the-rebel-alliance\/boxd-plugin#v<version>"/)
    expect(() => parseOptions({ regions: [] })).toThrow(/^OPTIONS_INVALID: .*at least one region, from "fra", "nyc"/)
    expect(() => parseOptions({ regions: ["fra"], region: "nyc" })).toThrow(/^OPTIONS_INVALID: .*option "region" is "nyc", which the option "regions" does not list \("fra"\)/)
    // The default region is inside the allowlist whenever both are set, and "auto" never contradicts it.
    expect(() => parseOptions({ regions: ["fra"], region: "auto" })).not.toThrow()
    expect(() => parseOptions({ regions: ["fra", "nyc"], region: "nyc" })).not.toThrow()
  })

})

describe("the host", () => {
  test("supports 2.4.1 up to, not including, 2.5.0", () => {
    expect(SUPPORTED_HOST).toBe(">=2.4.1 <2.5.0")
    expect(isSupportedHost("2.4.1")).toBe(true)
    expect(isSupportedHost("2.4.9")).toBe(true)
    expect(isSupportedHost("2.5.0")).toBe(false)
    expect(isSupportedHost("2.4.0")).toBe(false)
    expect(isSupportedHost("2.4.1-dev.1")).toBe(false)
  })

  test("the tested list is 2.4.1 only: the release the checks run on", () => {
    expect(TESTED_HOSTS).toEqual(["2.4.1"])
    expect(isTestedHost("2.4.1")).toBe(true)
    expect(isTestedHost("2.4.2")).toBe(false)
  })

  test("starts inside the range, and outside it only with the opt-in", () => {
    expect(checkHost("2.4.1", false)).toEqual({ version: "2.4.1", range: SUPPORTED_HOST, tested: true })
    expect(checkHost("2.4.2", false)).toEqual({ version: "2.4.2", range: SUPPORTED_HOST, tested: false })
    expect(() => checkHost("2.5.0", false)).toThrow(/^HOST_UNTESTED: .*Next step: /)
    expect(checkHost("2.5.0", true)).toMatchObject({ version: "2.5.0", tested: false })
    expect(checkHost("", true)).toMatchObject({ version: null, tested: false })
  })
})

describe("versions", () => {
  test("parses the CLI's own version line", () => {
    expect(parseVersion("opencode v2.4.1")).toEqual([2, 4, 1])
    expect(parseVersion("2.4.1-dev.1")).toBeUndefined()
  })
})
