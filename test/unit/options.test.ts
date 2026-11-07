import { describe, expect, test } from "bun:test"
import { parseOptions } from "../../src/options.js"
import { isSupportedHost, isTestedHost, checkHost, checkGuest, parseVersion } from "../../src/host-version.js"
import { SUPPORTED_HOST, TESTED_HOSTS } from "../../src/constants.js"

describe("plugin options", () => {
  test("defaults to the golden snapshot and a tested host", () => {
    expect(parseOptions(undefined)).toEqual({ snapshot: "opencode-golden", allowUntestedHost: false })
    expect(parseOptions({})).toEqual({ snapshot: "opencode-golden", allowUntestedHost: false })
  })

  test("takes a snapshot name and the opt-in", () => {
    expect(parseOptions({ snapshot: "opencode-next", allowUntestedHost: true })).toEqual({ snapshot: "opencode-next", allowUntestedHost: true })
  })

  test("refuses an unknown option, a bad snapshot name and a non-boolean, each as OPTIONS_INVALID", () => {
    for (const raw of [{ snapshott: "x" }, { snapshot: "Not A Snapshot" }, { snapshot: "x".repeat(80) }, { allowUntestedHost: "yes" }, [], "x"]) {
      expect(() => parseOptions(raw)).toThrow(/^OPTIONS_INVALID: .*Next step: /)
    }
  })
})

describe("the host", () => {
  test("supports 2.2.3 up to, not including, 2.3.0", () => {
    expect(SUPPORTED_HOST).toBe(">=2.2.3 <2.3.0")
    expect(isSupportedHost("2.2.3")).toBe(true)
    expect(isSupportedHost("2.2.6")).toBe(true)
    expect(isSupportedHost("2.2.9")).toBe(true)
    expect(isSupportedHost("2.3.0")).toBe(false)
    expect(isSupportedHost("2.2.2")).toBe(false)
    expect(isSupportedHost("2.2.6-dev.1")).toBe(false)
  })

  test("the tested list holds every release the checks run on, 2.2.6 included", () => {
    expect(TESTED_HOSTS).toEqual(["2.2.3", "2.2.4", "2.2.5", "2.2.6"])
    expect(isTestedHost("2.2.6")).toBe(true)
    expect(isTestedHost("2.2.7")).toBe(false)
  })

  test("starts inside the range, and outside it only with the opt-in", () => {
    expect(checkHost("2.2.4", false)).toEqual({ version: "2.2.4", range: SUPPORTED_HOST, tested: true })
    expect(checkHost("2.2.7", false)).toEqual({ version: "2.2.7", range: SUPPORTED_HOST, tested: false })
    expect(() => checkHost("2.3.0", false)).toThrow(/^HOST_UNTESTED: .*Next step: /)
    expect(checkHost("2.3.0", true)).toMatchObject({ version: "2.3.0", tested: false })
    expect(checkHost("", true)).toMatchObject({ version: null, tested: false })
  })
})

describe("the guest", () => {
  test("must run the same OpenCode as this laptop, not a hard-coded release", () => {
    expect(() => checkGuest("opencode v2.2.6", "2.2.6")).not.toThrow()
    expect(() => checkGuest("opencode v2.2.3", "2.2.3")).not.toThrow()
    expect(() => checkGuest("2.2.5", "2.2.6")).toThrow(/^GUEST_VERSION: /)
    expect(() => checkGuest("unknown", "2.2.6")).toThrow(/^GUEST_VERSION: /)
    expect(() => checkGuest("2.2.6", null)).toThrow(/^GUEST_VERSION: /)
  })

  test("parses the CLI's own version line", () => {
    expect(parseVersion("opencode v2.2.6")).toEqual([2, 2, 6])
    expect(parseVersion("2.2.6-dev.1")).toBeUndefined()
  })
})
