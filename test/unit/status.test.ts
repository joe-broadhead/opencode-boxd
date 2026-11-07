import { describe, expect, test } from "bun:test"
import { buildStatus, formatStatus, readStatus, type StatusFacts } from "../../src/status.js"
import { defaultRules } from "../../src/permissions.js"
import { TOOLS } from "../../src/tools.js"
import { VERSION } from "../../src/version.js"

const host = { version: "2.2.6", range: ">=2.2.3 <2.3.0", tested: true }

const facts = (overrides: Partial<StatusFacts> = {}): StatusFacts => ({
  host,
  snapshot: "opencode-claude-final",
  guestVersion: "2.2.6",
  ledger: { snapshot: "opencode-claude-final", works: [], orphans: [] },
  tools: TOOLS.map((tool) => tool.id),
  agents: [{ id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }, ...defaultRules()] }],
  problems: [],
  ...overrides,
})

describe("the status model", () => {
  test("carries the shared fields under the family's names", () => {
    const status = buildStatus(facts())
    expect(status).toMatchObject({ version: VERSION, state: "connected", unguardedAgents: [], host, nextStep: "Nothing to do." })
  })

  test("is failed, with a reason, when the ledger cannot be read", () => {
    const status = buildStatus(facts({ ledger: undefined, ledgerError: "EACCES: permission denied, scandir /x" }))
    expect(status.state).toBe("failed")
    expect(status.error).toContain("EACCES")
    expect(status.nextStep).toBe("Restart OpenCode, then run /boxd-status again.")
  })

  test("asks for a harvest before sleep, image or drop, naming the works", () => {
    const status = buildStatus(
      facts({
        ledger: {
          snapshot: "opencode-claude-final",
          orphans: [],
          works: [
            { workId: "review-api", machine: "oc-review-api", sessionId: "ses_1", proof: "fresh", dirty: false, machineStatus: "running", warnings: [] },
            { workId: "docs", machine: "oc-docs", sessionId: null, proof: "missing", dirty: false, machineStatus: "hibernated", warnings: [] },
          ],
        },
      }),
    )
    expect(status.openWorks).toBe(2)
    expect(status.unharvested).toEqual(["docs"])
    expect(status.nextStep).toContain("boxd_harvest for docs")
  })

  test("names an agent that lacks the rules, with the block to paste", () => {
    const status = buildStatus(facts({ agents: [{ id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }] }] }))
    expect(status.unguardedAgents).toEqual(["build"])
    expect(status.nextStep).toContain("Put the default rules")
    expect(status.nextStep).toContain("/boxd-status")
  })

  test("takes the rules problem's own next step, because a restart is what fixes it", () => {
    const status = buildStatus(facts({ problems: ["RULES_NOT_ADDED: the rules could not be added. Next step: Restart OpenCode."] }))
    expect(status.nextStep).toBe("Restart OpenCode.")
  })

  test("counts a tool this version does not know, and names only plain names", () => {
    const status = buildStatus(facts({ tools: [...TOOLS.map((tool) => tool.id), "boxd_from_the_future", "bad name"] }))
    expect(status.tools).toBe(11)
    expect(status.unknownCount).toBe(2)
    expect(status.unknownTools).toEqual(["boxd_from_the_future"])
  })

  test("renders the S9 rows in order, with one next step", () => {
    const text = formatStatus(buildStatus(facts()))
    const labels = text
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2, line.indexOf(":", 3) === -1 ? undefined : line.indexOf(":", 3)))
    expect(labels).toEqual(["Connection", "Account", "Access", "Snapshot", "Guest", "Works", "Tools", "Agents without default rules", "OpenCode", "Next step"])
    expect(text.match(/- Next step:/g)).toHaveLength(1)
    expect(text).toContain("- Snapshot: opencode-claude-final")
    expect(text).toContain("the 7 machine changes")
  })

  test("the Access row is derived from the tool classes", () => {
    const text = formatStatus(buildStatus(facts()))
    expect(text).toContain("reads run without asking")
    expect(text).toContain("no agent runs a new boxd tool unasked")
  })
})

describe("reading the facts", () => {
  const context = (agents: unknown[], tools: unknown[]) =>
    ({ agent: { list: async () => ({ data: agents }) }, tool: { list: async () => tools } }) as never

  test("counts only the boxd namespace's tools", async () => {
    const status = await readStatus(context([], [{ id: "boxd_status", name: "status", options: { namespace: "boxd" } }, { id: "jobs_status", name: "jobs_status", options: { namespace: "jobs" } }]), {
      host,
      snapshot: "opencode-claude-final",
      guestVersion: "2.2.6",
      ledger: async () => ({ snapshot: "opencode-claude-final", works: [], orphans: [] }),
    })
    expect(status.tools).toBe(1)
    expect(status.unknownCount).toBe(0)
  })

  test("a ledger that throws is the failed state, not a crash", async () => {
    const status = await readStatus(context([], []), {
      host,
      snapshot: "opencode-claude-final",
      guestVersion: "2.2.6",
      ledger: async () => {
        throw new Error("EACCES: scandir the ledger directory")
      },
    })
    expect(status.state).toBe("failed")
    expect(status.error).toContain("EACCES")
  })
})
