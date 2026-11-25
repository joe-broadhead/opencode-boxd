// The two input rules every list method shares, and the result shape a refusal takes.
import { describe, expect, test } from "bun:test"
import { refusalResult, selectionOf } from "../../src/call.js"
import { boxdError } from "../../src/errors.js"

const spec = { id: "boxd_sleep", list: true, selects: ["idle", "finished"] } as const

describe("selectionOf", () => {
  test("takes exactly one of workId, works and select", () => {
    expect(selectionOf(spec, { workId: "a" })).toBeUndefined()
    expect(selectionOf(spec, { works: ["a"] })).toBeUndefined()
    expect(selectionOf(spec, { select: "idle" })).toBe("idle")
    for (const input of [{}, { workId: "a", works: ["b"] }, { workId: "a", select: "idle" }, { works: ["b"], select: "finished" }]) {
      expect(() => selectionOf(spec, input)).toThrow(/Pass exactly one of/)
    }
  })

  test("refuses a select on a method without selectors, and dryRun without select", () => {
    expect(() => selectionOf({ id: "boxd_ensure", list: true }, { select: "idle" })).toThrow(/takes no select/)
    expect(() => selectionOf(spec, { workId: "a", dryRun: true })).toThrow(/taken only with select/)
    expect(selectionOf(spec, { select: "finished", dryRun: true })).toBe("finished")
  })
})

describe("refusalResult", () => {
  test("keeps the code, the sentence, the next step, the facts and the work", () => {
    const refusal = refusalResult(boxdError("NOT_SAVED", "This machine has no harvest of the work."), { workId: "review-api" })
    expect(refusal).toMatchObject({ state: "refused", error: "NOT_SAVED", message: "This machine has no harvest of the work.", workId: "review-api", machine: "oc-review-api" })
    expect(refusal.next).toContain("boxd_harvest")
  })
})
