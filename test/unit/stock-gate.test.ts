import { describe, expect, test } from "bun:test"
import { stockGate } from "../support/stock-gate.js"

describe("stockGate", () => {
  test("runs a release whose stock binary is present, in CI or not", () => {
    expect(stockGate("2.4.1", "/opt/stock/opencode", true, { CI: "true" })).toBe("run")
    expect(stockGate("2.4.1", "/opt/stock/opencode", true, {})).toBe("run")
  })

  test("skips a missing release on a laptop, and says which variable runs it", () => {
    const lines: string[] = []
    const log = console.log
    console.log = (line: string) => lines.push(line)
    try {
      expect(stockGate("2.4.3", "/nowhere/opencode", false, {})).toBe("skip")
    } finally {
      console.log = log
    }
    expect(lines.join("\n")).toContain("OPENCODE_BIN_2_4_3")
  })

  test("fails a missing release in CI, so a tested release that did not run is never a pass", () => {
    expect(() => stockGate("2.4.2", "/nowhere/opencode", false, { CI: "true" })).toThrow(/did not run/)
    expect(() => stockGate("2.4.2", "/nowhere/opencode", false, { CI: "1" })).toThrow(/did not run/)
  })
})
