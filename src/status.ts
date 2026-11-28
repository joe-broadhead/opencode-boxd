/**
 * The `/boxd` report a person reads: the fleet overview, cost, machine headroom and the permission posture.
 *
 * The contract's `status` method answers the fixed contract shape from `statusAnswer`; the fleet
 * numbers and the cost are the plugin's own status, so they live here rather than as extra keys on that answer. One
 * fleet read fills the report, and nothing here reads a guest, so opening the report never wakes a machine.
 */
import { unguardedAgents, type PermissionRule } from "@we-the-rebel-alliance/plugin-contract/access"
import { redactReason } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { COMMAND_STEM, DISPLAY_NAME, SUPPORTED_HOST } from "./constants.js"
import { isSupportedHost } from "./host-version.js"
import type { Access, Options } from "./options.js"
import { CAPS } from "./ports.js"
import type { AttentionItem, AutomationState, CostBlock, MachineCounts, StatusResult } from "./results.js"
import { workList } from "./fleet/status.js"

/** What one report read needs. The fleet read is the plugin's own, with no guest read. */
export interface ReportSources {
  readonly version: string
  readonly hostVersion: string | null
  readonly access: Access
  readonly options: Options
  readonly problems: () => readonly string[]
  /** How many methods are not reads, for the report's access sentence. */
  readonly changes: number
  readonly fleet: () => Promise<StatusResult>
  readonly rules: readonly PermissionRule[]
  readonly agents: () => Promise<readonly { readonly id: string; readonly permissions: readonly PermissionRule[] }[]>
}

/** One report, with the fleet read behind it; a failed read is `state: "error"` with one redacted next step. */
export interface ReportModel {
  readonly fleet: StatusResult | null
  readonly error?: { readonly reason: string; readonly nextStep?: string }
  readonly report: string
}

/** The `list` snapshot the `boxd.works.list` source reads from `status` with `{ list: "works" }`. */
export interface WorksSnapshot {
  readonly data: { readonly items: readonly { readonly id: string; readonly text: string; readonly note?: string }[]; readonly editable: false }
  readonly asOf: string
  readonly trust: "untrusted"
}

/** The snapshot for a fleet read, or an empty list when the fleet could not be read. */
export const worksSnapshot = (fleet: StatusResult | null): WorksSnapshot => workList(fleet?.works ?? [], undefined, fleet?.asOf ?? new Date().toISOString()) as WorksSnapshot

const NOTHING_TO_DO = "Nothing to do."
const SIGN_IN_NEXT_STEP = "Run boxd auth login in a terminal, check that the boxd CLI is on OpenCode's PATH here, then run /boxd again."
const AGENTS_NEXT_STEP = "Put the default rules shown by /boxd first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for boxd tools."
const RULES_NOT_ADDED = "RULES_NOT_ADDED:"

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** A coded error's reason and its own next step; any other error's message. */
function failureOf(error: unknown): { reason: string; nextStep?: string } {
  if (typeof error === "object" && error !== null && "code" in error && "what" in error && "next" in error) {
    const coded = error as { code: string; what: string; next: string; state?: string | null }
    const again = coded.state === "busy" ? "Run /boxd again in a few seconds." : `${coded.next.replace(/\.$/, "")}, then run /boxd again.`
    return { reason: `${coded.code}: ${redactReason(coded.what)}`, nextStep: again }
  }
  return { reason: error instanceof Error ? error.message : String(error) }
}

/** One fleet read and the report; never throws. */
export async function readReport(sources: ReportSources): Promise<ReportModel> {
  const [agents, fleet] = await Promise.all([sources.agents().then((value) => ({ value }), (error: unknown) => ({ error })), sources.fleet().then((value) => ({ value }), (error: unknown) => ({ error }))])
  const failure = "error" in fleet ? failureOf(fleet.error) : undefined
  const value = "value" in fleet ? fleet.value : null
  const unguarded = "error" in agents ? [] : [...unguardedAgents(agents.value, sources.rules)]
  const problems = sources.problems()
  const rulesProblem = problems.find((problem) => problem.startsWith(RULES_NOT_ADDED))
  const signedIn = value?.cli.signedIn ?? null
  const nextStep =
    failure !== undefined
      ? (failure.nextStep ?? "Restart OpenCode, then run /boxd again.")
      : signedIn === false
        ? SIGN_IN_NEXT_STEP
        : (rulesProblem?.split(" Next step: ")[1] ?? (unguarded.length ? AGENTS_NEXT_STEP : (value?.cleanup[0]?.call ? `${value.cleanup[0].call} saves money now.` : (problems[0]?.split(" Next step: ")[1] ?? NOTHING_TO_DO))))
  return {
    fleet: value,
    ...(failure === undefined ? {} : { error: failure }),
    report: reportText({ value, failure, signedIn, problems: problems.map(redactReason), unguarded, sources, nextStep: redactReason(nextStep) }),
  }
}

interface ReportInput {
  readonly value: StatusResult | null
  readonly failure?: { readonly reason: string; readonly nextStep?: string }
  readonly signedIn: boolean | null
  readonly problems: readonly string[]
  readonly unguarded: readonly string[]
  readonly sources: ReportSources
  readonly nextStep: string
}

const SYMBOLS: Readonly<Record<string, string>> = { EUR: "€", USD: "$", GBP: "£" }
const money = (amount: number, currency: string) => (SYMBOLS[currency] ? `${SYMBOLS[currency]}${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`)

const THOUSANDS = new Intl.NumberFormat("en-GB")
const thousands = (value: number) => THOUSANDS.format(value)
const MACHINE_STATES: readonly (keyof MachineCounts)[] = ["running", "starting", "standby", "hibernated", "stopped", "other"]

/** The organisation's machines against its limit, by state, and this ledger's share; a null limit keeps the counts. */
function machinesText(block: StatusResult["machines"]): string {
  const split = MACHINE_STATES.filter((state) => block.byState[state] > 0)
    .map((state) => `${thousands(block.byState[state])} ${state}`)
    .join(", ")
  const states = split === "" ? "" : ` (${split})`
  const limit =
    block.limit === null ? `${thousands(block.inUse)} in use${states}; the machine limit could not be read` : `${thousands(block.inUse)} of ${thousands(block.limit)} in use${states}`
  const works = block.works === 0 ? "none are this ledger's works" : block.works === 1 ? "1 is this ledger's work" : `${thousands(block.works)} are this ledger's works`
  return `${limit}; ${works}`
}

function costText(cost: CostBlock | undefined): string {
  if (cost === undefined) return "not read"
  const machines = `${cost.perHour.running} running, ${cost.perHour.asleep} asleep`
  const hour = `~${money(cost.perHour.estimate, cost.currency)}/h (an estimate)`
  const today = cost.today.machines === null ? "" : `; today ${money(cost.today.machines, cost.currency)} on machines`
  return `${machines}, ${hour}${today}${cost.today.unavailable ? ` (${cut(cost.today.unavailable, 120)})` : ""}`
}

const ORPHAN_WHY: Readonly<Record<string, string>> = { "no-ledger": "no ledger label", "no-record": "this ledger's label with no record", "legacy-labels": "legacy labels only" }

/** Every machine's class, counted, in a person's words. */
function machineClassesText(counts: StatusResult["machines"]["counts"]): string {
  const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`
  return [
    count(counts.work, "work", "works"),
    count(counts["other-ledger"], "work in another ledger", "works in another ledger"),
    count(counts.kept, "kept machine", "kept machines"),
    count(counts.golden, "golden builder", "golden builders"),
    count(counts.orphan, "orphan", "orphans"),
  ].join(", ")
}

/** The orphans, worst first (actionable first), each with its region, status, why and whether a rule may act on it. */
function orphansText(machines: StatusResult["machines"]): string {
  if (!machines.orphans.length) return machines.more ? `${machines.more} more` : "none"
  const items = machines.orphans.map((orphan) => {
    const action = orphan.actionable ? "actionable" : "not actionable: label it, or add a selector to keep"
    return `${orphan.machine} (${orphan.region}, ${orphan.status}, ${ORPHAN_WHY[orphan.why] ?? orphan.why}, ${action})`
  })
  return `${items.join("; ")}${machines.more ? `; and ${machines.more} more` : ""}`
}

function automationText(automation: AutomationState | undefined, notices: Options["notices"]): string {
  const what =
    automation === "on"
      ? "on: finished works are harvested, then hibernated, after autoSleepMinutes"
      : automation === "on (consent)"
        ? 'on by your automation: "on": finished works are harvested, then hibernated, after autoSleepMinutes'
        : automation === "off (access)"
          ? 'off at this access level; set automation: "on" to consent, or hibernate with boxd_sleep'
          : automation === "not-owner"
            ? "another OpenCode process on this machine runs it"
            : automation === "off"
              ? 'off (automation: "off")'
              : "unknown"
  return `${what}; notices: ${notices}`
}

function reportText(input: ReportInput): string {
  const { value, failure, signedIn, problems, unguarded, sources, nextStep } = input
  const access = sources.access
  const changing = sources.changes
  const posture =
    access === "all"
      ? `every method is allowed without asking, including the ${changing} changes; option access is "all"`
      : access === "ask-changes"
        ? `reads run without asking; the ${changing} changes ask first; option access is "ask-changes"`
        : `reads run without asking; the ${changing} changes are denied; option access is "read-only"`
  const agents = unguarded.length ? `${unguarded.join(", ")}\n${sources.rules.map((rule) => `  ${JSON.stringify(rule)}`).join(",\n")}` : "none"
  const host = `${sources.hostVersion ?? "unknown version"} (${isSupportedHost(sources.hostVersion ?? "") ? "tested" : "untested"}; supported range ${SUPPORTED_HOST})`
  const counts = value?.counts ?? {}
  const openWorks = Object.entries(counts).reduce((sum, [phase, count]) => (phase === "closed" ? sum : sum + (count ?? 0)), 0)
  const phases = Object.entries(counts)
    .filter(([phase, count]) => phase !== "closed" && count)
    .map(([phase, count]) => `${count} ${phase}`)
  const attention = value?.attention ?? []
  const groups = value?.groups ?? []
  const attentionText = attention.length || groups.length ? `${groups.map((group) => `${group.count} works ${group.why}`).concat(attention.map((item: AttentionItem) => `${item.workId} ${item.why}`)).join("; ")}; boxd_job has each detail` : "none"
  const machines = value ? (value.cli.signedIn ? machinesText(value.machines) : "not read: the machine listing failed") : "not read"
  const rows = [
    `${DISPLAY_NAME} status`,
    `- boxd CLI: ${signedIn === true ? "signed in (it answered the machine listing; the plugin never reads your account or credentials)" : signedIn === false ? "not signed in, or not reachable (the machine listing failed)" : "not checked"}`,
    `- Connection: ${failure ? `failed (${failure.reason})` : `connected (${openWorks} open ${openWorks === 1 ? "work" : "works"})`}`,
    `- Access: ${posture}; ${unguarded.length ? "the default rules are missing in the agents listed below" : "no agent runs a boxd tool unasked"}`,
    `- Image: ${sources.options.goldenPrefix}-${sources.hostVersion ?? "unknown"}-${sources.options.size}`,
    `- Guest: OpenCode ${sources.hostVersion ?? "unknown"}, the version here, to move a transcript`,
    `- Works: ${openWorks === 0 ? "no open work" : `${openWorks} open: ${phases.join(", ")}`}`,
    `- Attention: ${attentionText}`,
    `- Regions: default ${JSON.stringify(sources.options.region)}; allowed ${sources.options.regions.map((region) => `"${region}"`).join(", ") || "no region: nothing new is placed"}`,
    `- Machines: ${machines}`,
    `- Machine classes: ${value ? (value.cli.signedIn ? machineClassesText(value.machines.counts) : "not read: the machine listing failed") : "not read"}`,
    `- Orphans: ${value ? (value.cli.signedIn ? orphansText(value.machines) : "not read: the machine listing failed") : "not read"}`,
    `- Cost: ${costText(value?.cost)}`,
    `- Automation: ${automationText(value?.automation, sources.options.notices)}`,
    `- Health: event-loop delay at most ${value?.health.loopLagMaxMs ?? 0} ms; ${value?.health.children.now ?? 0} of ${value?.health.children.cap ?? CAPS.shared} boxd processes`,
    `- Agents without default rules: ${agents}`,
    `- OpenCode: ${host}`,
    `- Next step: ${nextStep}`,
  ]
  if (problems.length) rows.splice(rows.length - 2, 0, `- Problems: ${problems.map((problem) => cut(problem, 160)).join(" ")}`)
  return rows.join("\n")
}

/** `/boxd`: the report a person reads. */
export function registerStatusCommand(ctx: { readonly command: { transform: (editor: (editor: { add: (command: { name: string; description: string; execute: (input: { sessionID: string }) => Promise<void> }) => void }) => void) => Promise<{ dispose(): Promise<void> }> }; readonly session: { synthetic: (input: { sessionID: string; text: string; description: string; resume: boolean }) => Promise<unknown> } }, read: () => Promise<ReportModel>) {
  return ctx.command.transform((editor) =>
    editor.add({
      name: COMMAND_STEM,
      description: "Show boxd's works, machines, cost, permission posture and the next step",
      execute: async ({ sessionID }) => {
        const text = await read().then(
          (model) => model.report,
          (cause: unknown) => `STATUS_UNAVAILABLE: Could not read boxd's status (${redactReason(cause instanceof Error ? cause.message : String(cause))}). Next step: restart OpenCode, then run /boxd again.`,
        )
        await ctx.session.synthetic({ sessionID, text, description: "boxd status", resume: false })
      },
    }),
  )
}
