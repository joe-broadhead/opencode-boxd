// The /boxd report and the contract status answer never echo a credential: a provider's line is redacted, and an
// unreadable fleet is `error` with one next step, never a zero.
import { describe, expect, test } from "bun:test"
import { statusAnswer } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { boxdError } from "../../src/errors.js"
import { manifest } from "../../src/manifest.js"
import { readReport, worksSnapshot } from "../../src/status.js"
import { fleet } from "../support/fleet.js"

const token = "ghp_abcdefghijklmnop123456"
const sources = (over: Partial<Parameters<typeof readReport>[0]> = {}) => ({
  version: "0.0.0",
  hostVersion: "2.4.1",
  access: "all" as const,
  options: {
    access: "all" as const,
    accounts: {},
    allowedRoots: [],
    allowUntestedHost: false,
    regions: ["fra", "nyc"] as const,
    region: "auto" as const,
    keepFree: { fra: 0, nyc: 0 },
    size: "2x8" as const,
    goldenPrefix: "oc-golden",
    goldenBase: "stock",
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
  test("redacts a problem and reports the host range and the one account", () => {
    const answer = statusAnswer({ manifest, version: "0.0.0", hostVersion: "2.4.1", accounts: [{ alias: "default", state: "ready" }], problems: [`the CLI said ${token}`], unguardedAgents: { ok: true, agents: [] } })
    expect(answer.state).toBe("error")
    expect(answer.nextStep).not.toContain(token)
    expect(answer.host).toEqual({ version: "2.4.1", range: ">=2.4.1 <2.5.0", tested: ["2.4.1"] })
    expect(answer.accounts).toEqual([{ alias: "default", state: "ready" }])
  })
})
