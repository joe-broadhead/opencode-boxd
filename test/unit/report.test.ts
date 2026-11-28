// The /boxd report and the contract status answer never echo a credential: a provider's line is redacted, and an
// unreadable fleet is `error` with one next step, never a zero.
import { describe, expect, test } from "bun:test"
import { statusAnswer } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { boxdError } from "../../src/errors.js"
import { manifest } from "../../src/manifest.js"
import { readReport, worksSnapshot } from "../../src/status.js"
import { fleet } from "../support/fleet.js"

// An invented credential, never a real one: a token the report and status redaction must cut.
const token = ["ghp", "abcdefghijklmnop123456"].join("_")
const sources = (over: Partial<Parameters<typeof readReport>[0]> = {}) => ({
  version: "0.0.0",
  hostVersion: "2.4.1",
  access: "all" as const,
  options: {
    access: "all" as const,
    allowedRoots: [],
    allowUntestedHost: false,
    regions: ["fra", "nyc"] as const,
    region: "auto" as const,
    keepFree: { fra: 0, nyc: 0 },
    keep: [],
    size: "2x8" as const,
    slotsPerMachine: 4,
    goldenPrefix: "oc-golden",
    goldenBase: "stock",
    warm: [] as const,
    buildGolden: "auto" as const,
    notices: "wake" as const,
    autoHibernateMinutes: 120,
    automation: "auto" as const,
    autoSleepMinutes: 10,
    orphanHours: 12,
    leaseDays: 0,
  },
  problems: () => [],
  fleet: async () => fleet(),
  rules: [],
  agents: async () => [],
  changes: 12,
  ...over,
})

describe("the /boxd report", () => {
  test("redacts a provider's failure line and keeps one next step", async () => {
    const model = await readReport(sources({ fleet: async () => Promise.reject(boxdError("BOXD_FAILED", `the CLI said ${token}`, { retryAfterSec: 5 })) }))
    expect(model.report).toContain("failed")
    expect(model.report).not.toContain(token)
    expect(model.report).toMatch(/- Next step: .+/)
  })

  test("a connected fleet renders its works, cost and posture", async () => {
    const model = await readReport(sources())
    expect(model.report).toContain("- Connection: connected")
    expect(model.report).toContain("- Access: every method is allowed without asking")
    expect(model.report).toContain("- Cost:")
    expect(model.report).toContain('- Regions: default "auto"; allowed "fra", "nyc"')
    expect(model.report).toContain("- Machine classes: 0 works, 0 registries, 0 works in another ledger, 0 kept machines, 0 golden builders, 0 orphans")
    expect(model.report).toContain("- Orphans: none")
    expect(model.report).toContain("- Registry: none yet")
  })

  test("lists each orphan with its region, status, why and whether a rule may act on it", async () => {
    const model = await readReport(
      sources({
        fleet: async () =>
          fleet({
            machines: {
              counts: { work: 1, registry: 0, "other-ledger": 1, kept: 0, golden: 0, orphan: 1 },
              orphans: [{ machine: "oc-stray", region: "nyc", status: "hibernated", why: "legacy-labels", actionable: true, next: 'boxd_ensure({ workId: "stray" }) adopts it' }],
              more: 0,
              limit: 600,
              inUse: 3,
              free: 597,
              byState: { running: 2, starting: 0, standby: 0, hibernated: 1, stopped: 0, other: 0 },
              works: 1,
              perRegion: [],
            },
          }),
      }),
    )
    expect(model.report).toContain("- Machine classes: 1 work, 0 registries, 1 work in another ledger, 0 kept machines, 0 golden builders, 1 orphan")
    expect(model.report).toContain("- Orphans: oc-stray (nyc, hibernated, legacy labels only, actionable)")
  })

  test("the Machines line shows the organisation against its limit, by state, and this ledger's share", async () => {
    const model = await readReport(
      sources({
        fleet: async () =>
          fleet({
            machines: {
              counts: { work: 31, registry: 0, "other-ledger": 0, kept: 0, golden: 0, orphan: 0 },
              orphans: [],
              more: 0,
              limit: 1250,
              inUse: 1180,
              free: 70,
              byState: { running: 40, starting: 0, standby: 12, hibernated: 1128, stopped: 0, other: 0 },
              works: 31,
              perRegion: [],
            },
          }),
      }),
    )
    expect(model.report).toContain("- Machines: 1,180 of 1,250 in use (40 running, 12 standby, 1,128 hibernated); 31 are this ledger's works")
  })

  test("the Budget line shows each label cap with its use", async () => {
    const model = await readReport(
      sources({
        fleet: async () =>
          fleet({
            budget: {
              today: null,
              action: "refuse",
              state: "reached",
              labels: [{ match: "product=alpha", machines: { inUse: 2, limit: 6 }, machineHours: { today: 1.5, cap: 4 }, daily: { perDay: 12, cap: 20 }, state: "reached" }],
            },
          }),
      }),
    )
    expect(model.report).toContain("- Budget: product=alpha: 2 of 6 machines, 1.50 of 4.00 h today, €12.00 of €20.00 per day (reached)")
  })

  test("a limit that could not be read still shows the counts, and says the limit is unknown", async () => {
    const model = await readReport(
      sources({
        fleet: async () =>
          fleet({
            machines: {
              counts: { work: 2, registry: 0, "other-ledger": 0, kept: 0, golden: 0, orphan: 0 },
              orphans: [],
              more: 0,
              limit: null,
              inUse: 2,
              free: null,
              byState: { running: 1, starting: 0, standby: 0, hibernated: 1, stopped: 0, other: 0 },
              works: 0,
              perRegion: [],
            },
          }),
      }),
    )
    expect(model.report).toContain("- Machines: 2 in use (1 running, 1 hibernated); the machine limit could not be read; none are this ledger's works")
  })
})

describe("the works list snapshot", () => {
  test("is empty, marked untrusted, and still carries an asOf when the fleet cannot be read", () => {
    const snapshot = worksSnapshot(null)
    expect(snapshot).toMatchObject({ data: { items: [], editable: false }, trust: "untrusted" })
    expect(Number.isFinite(Date.parse(snapshot.asOf))).toBe(true)
  })
})

describe("the contract status answer", () => {
  test("redacts a problem and reports the host range with no account profiles", () => {
    const answer = statusAnswer({ manifest, version: "0.0.0", hostVersion: "2.4.1", accounts: [], problems: [`the CLI said ${token}`], unguardedAgents: { ok: true, agents: [] } })
    expect(answer.state).toBe("error")
    expect(answer.nextStep).not.toContain(token)
    expect(answer.host).toEqual({ version: "2.4.1", range: ">=2.4.1 <2.5.0", tested: ["2.4.1"] })
    expect(answer.accounts).toEqual([])
  })
})
