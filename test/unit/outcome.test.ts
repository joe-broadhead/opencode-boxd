// The guest session's last run, read from what OpenCode records, and the next step a failed one gets.
import { describe, expect, test } from "bun:test"
import { errorLine, isCredentialFailure, mapOutcome, nextStepFor, readRun } from "../../src/outcome.js"

const AUTH_ERROR = {
  type: "provider.auth",
  message: "Go Teams covers workspace members, not service accounts. Use a personal API key to call Go models.",
}

describe("reading a run", () => {
  test("maps OpenCode's three words, and nothing else", () => {
    expect(mapOutcome("succeeded")).toBe("completed")
    expect(mapOutcome("failed")).toBe("failed")
    expect(mapOutcome("interrupted")).toBe("aborted")
    expect(mapOutcome("running")).toBeNull()
    expect(mapOutcome(undefined)).toBeNull()
  })

  test("the session's own outcome wins, and the last idle message carries the error", () => {
    const run = readRun({ outcome: "failed" }, [{ type: "idle", outcome: "failed", error: AUTH_ERROR }])
    expect(run).toEqual({ outcome: "failed", error: "provider.auth: Go Teams covers workspace members, not service accounts. Use a personal API key to call Go models" })
  })

  test("a failure's line is redacted and cut, and its response body is never read", () => {
    const line = errorLine({ type: "provider.auth", message: "denied for key=sk-live-0123456789abcdef", response: { body: "secret-body" } })
    expect(line).toBe("provider.auth: denied for key=[redacted]")
    expect(line).not.toContain("sk-live")
    expect(line).not.toContain("secret-body")
    expect(errorLine({ type: "provider.other", message: "" })).toBeUndefined()
  })

  test("a credential failure has its own next step", () => {
    const run = { outcome: "failed" as const, error: "provider.auth: nope" }
    expect(isCredentialFailure(run)).toBe(true)
    expect(nextStepFor(run)).toContain("host-bound boxd env secret")
    expect(nextStepFor({ outcome: "failed", error: "tool.timeout: took too long" })).toBe("Read lastText with boxd_job, then boxd_submit again.")
    expect(nextStepFor({ outcome: "completed" })).toBe("Read lastText with boxd_job, then boxd_submit again.")
  })
})
