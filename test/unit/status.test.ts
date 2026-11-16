// The status model: one model for /boxd-status, the /boxd dialog and the status RPC, built from the fleet view, with the
// family's shared fields, a Cost row, and one next step.
import { describe, expect, test } from "bun:test"
import { boxdError } from "../../src/errors.js"
import { buildStatus, formatStatus, readStatus } from "../../src/status.js"
import { TOOLS } from "../../src/tools.js"
import { VERSION } from "../../src/version.js"
import { fleet, HOST, statusFacts } from "../support/fleet.js"

describe("the status model", () => {
  test("carries the shared fields under the family's names", () => {
    const status = buildStatus(statusFacts())
    expect(status).toMatchObject({ version: VERSION, state: "connected", unguardedAgents: [], host: HOST, nextStep: "Nothing to do." })
  })

  test("is failed, with a reason, when the fleet cannot be read", () => {
    const status = buildStatus(statusFacts({ fleet: undefined, fleetError: { reason: "EACCES: permission denied, scandir /x" } }))
    expect(status.state).toBe("failed")
    expect(status.error).toContain("EACCES")
    expect(status.signedIn).toBeNull()
    expect(status.nextStep).toBe("Restart OpenCode, then run /boxd-status again.")
  })

  test("a ledger still importing says to look again in a few seconds", async () => {
    const status = await readStatus({ agent: { list: async () => ({ data: [] }) }, tool: { list: async () => [] } } as never, {
      ...statusFacts(),
      fleet: async () => {
        throw boxdError("LEDGER_IMPORTING", undefined, { progress: { done: 3, total: 170 } })
      },
    })
    expect(status.state).toBe("failed")
    expect(status.error).toContain("LEDGER_IMPORTING")
    expect(status.nextStep).toBe("Run /boxd-status again in a few seconds.")
  })

  test("counts open works by phase, in the one phase order", () => {
    const status = buildStatus(statusFacts({ fleet: fleet({ counts: { idle: 2, busy: 3, asleep: 1, closed: 4 } }) }))
    expect(status.openWorks).toBe(6)
    expect(formatStatus(status)).toContain("- Works: 6 open: 3 busy, 2 idle, 1 asleep")
  })

  test("the worst work's next call is the next step, and a folded cause comes first when it is as bad", () => {
    const one = fleet({ attention: [{ workId: "db-mig", region: "fra", phase: "idle", outcome: "completed", saved: "stale", why: "idle-unsaved", next: 'boxd_harvest({ workId: "db-mig" })' }] })
    expect(buildStatus(statusFacts({ fleet: one })).nextStep).toBe('db-mig (idle-unsaved): boxd_harvest({ workId: "db-mig" }).')
    const folded = fleet({ ...one, groups: [{ why: "failed", error: "GUEST_AUTH_FAILED", count: 15, workIds: ["a"], next: "Set or rotate the shared model credential" }] })
    const status = buildStatus(statusFacts({ fleet: folded }))
    expect(status.nextStep).toBe("15 works: Set or rotate the shared model credential.")
    expect(formatStatus(status)).toContain("- Attention: 15 works failed (GUEST_AUTH_FAILED); db-mig idle-unsaved; boxd_status has each next call")
  })

  test("names an agent that lacks the rules, with the block to paste", () => {
    const status = buildStatus(statusFacts({ agents: [{ id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }] }] }))
    expect(status.unguardedAgents).toEqual(["build"])
    expect(status.nextStep).toContain("Put the default rules")
    expect(status.nextStep).toContain("/boxd-status")
  })

  test("takes the rules problem's own next step, because a restart is what fixes it", () => {
    const status = buildStatus(statusFacts({ problems: ["RULES_NOT_ADDED: the rules could not be added. Next step: Restart OpenCode."] }))
    expect(status.nextStep).toBe("Restart OpenCode.")
  })

  test("counts a tool this version does not know, and names only plain names", () => {
    const status = buildStatus(statusFacts({ tools: [...TOOLS.map((tool) => tool.id), "boxd_from_the_future", "bad name"] }))
    expect(status.tools).toBe(TOOLS.length + 2)
    expect(status.unknownCount).toBe(2)
    expect(status.unknownTools).toEqual(["boxd_from_the_future"])
  })

  test("renders the rows in order, with one next step", () => {
    const text = formatStatus(buildStatus(statusFacts()))
    const labels = text
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2, line.indexOf(":", 3) === -1 ? undefined : line.indexOf(":", 3)))
    expect(labels).toEqual(["boxd CLI", "Connection", "Access", "Image", "Guest", "Works", "Attention", "Machines", "Cost", "Automation", "Health", "Tools", "Agents without default rules", "OpenCode", "Next step"])
    expect(text.match(/- Next step:/g)).toHaveLength(1)
    expect(text).toContain("- Image: oc-golden-2.2.6-2x8 for a new work in the default size; boxd_ensure builds it when it is missing")
    expect(text).toContain("the 9 machine changes")
    expect(text).toContain("- Machines: fra 2 of 300 in use, 298 free; nyc 0 of 300 in use, 300 free")
  })

  test("the Cost row: counts, the estimate per hour, today, and the top cleanup action", () => {
    const status = buildStatus(
      statusFacts({
        fleet: fleet({
          cost: { currency: "EUR", perHour: { estimate: 0.41, running: 21, asleep: 10, basis: "x", ratesSource: "usage" }, today: { machines: 6.12, models: { currency: "USD", total: 48.3 }, complete: false } },
          cleanup: [{ action: "sleep", select: "finished", works: 9, savesPerHour: 0.33, call: 'boxd_sleep({ select: "finished" })' }],
        }),
      }),
    )
    expect(formatStatus(status)).toContain('- Cost: 21 running, 10 asleep, ~€0.41/h (an estimate); today €6.12 on machines; cleanup: boxd_sleep({ select: "finished" }) saves ~€0.33/h, or /boxd-cleanup')
  })

  test("the Cost row says why a figure is missing: a member's sign-in, or no cost service", () => {
    const member = buildStatus(
      statusFacts({ fleet: fleet({ cost: { currency: "USD", perHour: { estimate: 0.2, running: 2, asleep: 0, basis: "x", ratesSource: "public" }, today: { machines: null, models: { currency: "USD", total: 0 }, complete: false } } }) }),
    )
    expect(formatStatus(member)).toContain("~$0.20/h (an estimate) (today's machine cost needs an owner's or admin's boxd sign-in)")
    const none = buildStatus(
      statusFacts({ fleet: fleet({ cost: { currency: "unknown", perHour: { estimate: 0, running: 0, asleep: 0, basis: "x", ratesSource: "public" }, today: { machines: null, models: { currency: "USD", total: 0 }, complete: false, unavailable: "The cost service is not available (not built)." } } }) }),
    )
    expect(none.cost?.perHour).toBeNull()
    expect(formatStatus(none)).toContain("no estimate")
  })

  test("the Automation row says what runs at this access level, and the notices mode", () => {
    expect(formatStatus(buildStatus(statusFacts()))).toContain("- Automation: on: finished works are harvested, then hibernated, after autoSleepMinutes; notices: wake")
    const off = formatStatus(buildStatus(statusFacts({ access: "ask-changes", notices: "queue", fleet: fleet({ automation: "off (access)" }) })))
    expect(off).toContain('- Automation: off at this access level; set automation: "on" to consent, or clean up with boxd_sleep; notices: queue')
  })

  test("the boxd CLI row comes first: signed in when the listing answered, and the sign-in is the first next step when not", () => {
    expect(formatStatus(buildStatus(statusFacts()))).toContain("- boxd CLI: signed in")
    const signedOut = buildStatus(statusFacts({ fleet: fleet({ cli: { signedIn: false, version: null } }) }))
    expect(signedOut.signedIn).toBe(false)
    expect(signedOut.nextStep).toContain("boxd auth login")
    expect(formatStatus(signedOut)).toContain("- boxd CLI: not signed in, or not reachable (")
  })

  test("the Health row names the watcher's problem and dropped notices", () => {
    const status = buildStatus(statusFacts({ fleet: fleet({ health: { loopLagMaxMs: 12, children: { now: 3, cap: 12 }, notices: [{ session: "ses_a", dropped: "the session is gone", at: "t" }], watcher: "The watcher stopped after 3 failed sweeps in a row: x." } }) }))
    expect(formatStatus(status)).toContain("- Health: event-loop delay at most 12 ms; 3 of 12 boxd processes; 1 notices dropped; The watcher stopped after 3 failed sweeps in a row: x")
  })

  test("the Access row is derived from the tool classes", () => {
    const text = formatStatus(buildStatus(statusFacts()))
    expect(text).toContain("every tool is allowed without asking")
    expect(text).toContain('option access is "all"')
    expect(text).toContain("no agent runs a new boxd tool unasked")
  })
})

describe("reading the facts", () => {
  const context = (agents: unknown[], tools: unknown[]) => ({ agent: { list: async () => ({ data: agents }) }, tool: { list: async () => tools } }) as never

  test("counts only the boxd namespace's tools", async () => {
    const status = await readStatus(context([], [{ id: "boxd_status", name: "status", options: { namespace: "boxd" } }, { id: "jobs_status", name: "jobs_status", options: { namespace: "jobs" } }]), {
      ...statusFacts(),
      fleet: async () => fleet(),
    })
    expect(status.tools).toBe(1)
    expect(status.unknownCount).toBe(0)
  })

  test("a fleet read that throws is the failed state, not a crash", async () => {
    const status = await readStatus(context([], []), {
      ...statusFacts(),
      fleet: async () => {
        throw new Error("EACCES: scandir the ledger directory")
      },
    })
    expect(status.state).toBe("failed")
    expect(status.error).toContain("EACCES")
  })
})
