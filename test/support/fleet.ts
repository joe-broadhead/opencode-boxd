// A fleet answer with every block present, for the status report tests.
import type { StatusResult } from "../../src/results.js"

export function fleet(overrides: Partial<StatusResult> = {}): StatusResult {
  return {
    state: "ok",
    cursor: 0,
    asOf: "2026-11-16T10:00:00.000Z",
    counts: {},
    region: "auto",
    allowedRegions: ["fra", "nyc"],
    regions: [
      { region: "fra", limit: 300, inUse: 0, free: 300, keepFree: 0, works: 0 },
      { region: "nyc", limit: 300, inUse: 0, free: 300, keepFree: 0, works: 0 },
    ],
    groups: [],
    attention: [],
    more: 0,
    cursorExpired: false,
    machines: { counts: { work: 0, "other-ledger": 0, kept: 0, golden: 0, orphan: 0 }, orphans: [], more: 0 },
    fleet: {},
    cost: {
      currency: "EUR",
      perHour: { estimate: 0, running: 0, asleep: 0, basis: "rates x resident GiB", ratesSource: "usage" },
      today: { machines: 0, complete: true },
    },
    cleanup: [],
    automation: "on",
    cli: { signedIn: true, version: "0.3.8" },
    health: { loopLagMaxMs: 0, children: { now: 0, cap: 12 } },
    ...overrides,
  }
}
