// A failed run's error line, and the code (with its next step) a failed run gets.
import { describe, expect, test } from "bun:test"
import { CODES } from "../../src/errors.js"
import { errorLine, failureCode, isCredentialFailure } from "../../src/outcome.js"

describe("a failed run", () => {
  test("a failure's line is redacted and cut, and its response body is never read", () => {
    // An invented credential, never a real one: the provider's error line must be redacted.
    const key = ["sk", "live", "0123456789abcdef"].join("-")
    const line = errorLine({ type: "provider.auth", message: `denied for key=${key}`, response: { body: "secret-body" } })
    expect(line).toBe("provider.auth: denied for key=[redacted]")
    expect(line).not.toContain("sk-live")
    expect(line).not.toContain("secret-body")
    expect(errorLine({ type: "provider.other", message: "" })).toBeUndefined()
  })

  test("a credential failure has its own next step", () => {
    const run = { outcome: "failed" as const, error: "provider.auth: nope" }
    expect(isCredentialFailure(run)).toBe(true)
    expect(failureCode(run)).toBe("GUEST_AUTH_FAILED")
    expect(CODES[failureCode(run)].next).toContain("host-bound boxd env secret")
    expect(failureCode({ outcome: "failed", error: "tool.timeout: took too long" })).toBe("RUN_FAILED")
    expect(failureCode({ outcome: "completed" })).toBe("RUN_FAILED")
  })
})
