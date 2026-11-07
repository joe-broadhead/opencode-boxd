import { describe, expect, it } from "vitest"
import { BoxdError } from "../src/errors.js"
import { checkGuest, checkHost, inRange, parseVersion } from "../src/version.js"

describe("version", () => {
  it("accepts only 2.2.6 as the tested host and refuses the previous release", () => {
    expect(inRange("2.2.6")).toBe(true)
    expect(inRange("2.2.5")).toBe(false)
    expect(inRange("2.3.0")).toBe(false)
    expect(parseVersion("opencode v2.2.6")).toBe("2.2.6")
    expect(() => checkHost("2.2.5", false)).toThrow(BoxdError)
    expect(checkHost("2.2.6", false)).toBeUndefined()
    expect(() => checkGuest("opencode v2.2.5")).toThrow(BoxdError)
    expect(() => checkGuest("2.2.6")).not.toThrow()
  })
})
