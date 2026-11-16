// Package D's test helpers: a `boxd_status` answer to build the status model from, and the facts around it.
import type { StatusResult } from "../../src/results.js"
import type { StatusFacts } from "../../src/status.js"
import { defaultRules } from "../../src/permissions.js"
import { TOOLS } from "../../src/tools.js"

export const HOST = { version: "2.2.6", range: ">=2.2.3 <2.4.0", tested: true }

/** A fleet answer with nothing in it, and every block present. */
export function fleet(overrides: Partial<StatusResult> = {}): StatusResult {
  return {
    state: "ok",
    cursor: 0,
    asOf: "2026-11-16T10:00:00.000Z",
    counts: {},
    regions: [
      { region: "fra", limit: 300, inUse: 2, free: 298, keepFree: 0, works: 0 },
      { region: "nyc", limit: 300, inUse: 0, free: 300, keepFree: 0, works: 0 },
    ],
    groups: [],
    attention: [],
    more: 0,
    cursorExpired: false,
    orphans: [],
    fleet: {},
    cost: { currency: "EUR", perHour: { estimate: 0, running: 0, asleep: 0, basis: "rates × resident GiB", ratesSource: "usage" }, today: { machines: 0, models: { currency: "USD", total: 0 }, complete: false } },
    cleanup: [],
    automation: "on",
    cli: { signedIn: true, version: null },
    health: { loopLagMaxMs: 3, children: { now: 0, cap: 12 } },
    ...overrides,
  }
}

export function statusFacts(overrides: Partial<StatusFacts> = {}): StatusFacts {
  return {
    access: "all",
    host: HOST,
    image: "oc-golden-2.2.6-2x8",
    buildGolden: "auto",
    guestVersion: "2.2.6",
    notices: "wake",
    fleet: fleet(),
    tools: TOOLS.map((tool) => tool.id),
    agents: [{ id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }, ...defaultRules()] }],
    problems: [],
    ...overrides,
  }
}
