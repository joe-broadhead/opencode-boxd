/**
 * The status model (package D): one model for `/boxd-status`, the `/boxd` dialog and the status RPC. `version`, `host`,
 * `state`, `unguardedAgents` and `nextStep` are the fields every plugin of this family shares; the rest are boxd's own.
 *
 * It reads the ledger and the watcher's knowledge, and makes no boxd call beyond a machine read: the all-region listing
 * and the machine limit, both cached and shared with the tools. It never reads a guest, so opening the dialog never
 * wakes a machine or keeps an idle one awake. A failure's reason is cut to one line of 160 characters.
 */
import type { Plugin, Rpc } from "@opencode/plugin"
import { COMMAND_STEM, DISPLAY_NAME, PLUGIN_ID, TESTED_HOSTS } from "./constants.js"
import { isSupportedHost, type HostCheck } from "./host-version.js"
import { defaultRules, unguardedAgents, type Access, type Rule } from "./permissions.js"
import { cut, shortReason } from "./redact.js"
import { PHASES, type Phase } from "./ledger/types.js"
import type { Notices } from "./options.js"
import { CAPS } from "./ports.js"
import type { StatusResult } from "./results.js"
import { TOOLS } from "./tools.js"
import type { FleetServices } from "./services.js"
import { VERSION } from "./version.js"
import { BoxdError } from "./errors.js"
import { fleetStatus } from "./fleet/status.js"

export { shortReason }

/** The status labels (S9) in machine form; the report shows `failed` and `connected` as written. */
type State = "connected" | "failed"

/** One work that needs a decision, as the report names it: plugin words, never guest text. */
export interface StatusAttention {
  readonly workId: string
  readonly phase: Phase
  readonly why: string
  readonly error?: string
  readonly next: string
}

/** The Cost row (design §C.5): running and asleep counts, the estimate per hour, today's machine cost, the top action. */
export interface StatusCost {
  readonly currency: string
  readonly running: number
  readonly asleep: number
  readonly perHour: number | null
  readonly today: number | null
  /** Why a figure is missing, on one line. */
  readonly note?: string
  readonly cleanup?: { readonly call: string; readonly works: number; readonly savesPerHour?: number; readonly savesPerDay?: number }
}

/** What status is built from. The TUI fills what it can see; fields it cannot see stay undefined. */
export interface StatusFacts {
  /** What the plugin's own tools may do without asking, from the option. */
  readonly access: Access
  readonly host: HostCheck
  /** The image a new work in the default size boots from. */
  readonly image: string
  readonly buildGolden: "auto" | "never"
  /** This laptop's OpenCode version, which a guest must match to move a transcript. */
  readonly guestVersion: string | null
  readonly notices: Notices
  readonly fleet?: StatusResult
  /** The fleet could not be read: status is `failed`, with this reason and next step. */
  readonly fleetError?: { readonly reason: string; readonly nextStep?: string }
  readonly tools?: readonly string[]
  readonly agents?: readonly { readonly id: string; readonly permissions: readonly Rule[] }[]
  readonly problems?: readonly string[]
}

export interface Status {
  readonly version: string
  readonly state: State
  /** For a failed read only: the reason, on one line of at most 160 characters. */
  readonly error?: string
  readonly host: HostCheck
  readonly access: Access
  /** Whether the boxd CLI answered the machine listing; null when status could not ask it. */
  readonly signedIn: boolean | null
  readonly image: string
  readonly buildGolden: "auto" | "never"
  /** The OpenCode version a guest must run to move a transcript: this laptop's own. */
  readonly guestVersion: string | null
  readonly openWorks: number
  readonly counts: Readonly<Partial<Record<Phase, number>>>
  /** At most ten works that need a decision, worst first; `moreAttention` counts the rest. */
  readonly attention: readonly StatusAttention[]
  readonly moreAttention: number
  readonly groups: ReadonlyArray<{ readonly why: string; readonly error?: string; readonly count: number; readonly next: string }>
  /** `oc-*` machines with the plugin's labels that no open work records. */
  readonly orphans: readonly string[]
  readonly regions: ReadonlyArray<{ readonly region: string; readonly limit: number; readonly inUse: number; readonly free: number }>
  readonly cost: StatusCost | null
  readonly automation: string
  readonly notices: Notices
  readonly health: { readonly loopLagMaxMs: number; readonly children: number; readonly cap: number; readonly droppedNotices: number; readonly watcher?: string }
  readonly imported?: { readonly works: number; readonly errors: number }
  /** How many boxd tools OpenCode lists. */
  readonly tools: number
  /** How many of the listed `boxd_*` tools this version does not know. */
  readonly unknownCount: number
  readonly unknownTools: readonly string[]
  /** Agents where a new boxd tool would run without asking; empty when there are none. */
  readonly unguardedAgents: readonly string[]
  readonly problems: readonly string[]
  /** The one next step: the `Next step` row, "Nothing to do." when nothing is needed. */
  readonly nextStep: string
}

/** The default rules for one access value, to paste into an agent's own permissions, one rule a line. */
const agentRules = (access: Access) =>
  defaultRules(access)
    .map((rule, index, rules) => `  ${JSON.stringify(rule)}${index < rules.length - 1 ? "," : ""}`)
    .join("\n")

/** The next step while agents lack the rules: the family's one fixed sentence. */
const AGENTS_NEXT_STEP =
  "Put the default rules shown by /boxd-status first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for boxd tools."

const NOTHING_TO_DO = "Nothing to do."
const SIGN_IN_NEXT_STEP = "Run boxd auth login in a terminal, check that the laptop's boxd CLI is on OpenCode's PATH, then run /boxd-status again."
const LISTED_UNKNOWN = 20
const LISTED_ATTENTION = 10
// A tool name comes from the host; list only plain names.
const SAFE_NAME = /^[a-z][a-z0-9_]{0,63}$/
const STATUS_LIMIT = 160
const CLASS_OF = new Map<string, string>(TOOLS.map((tool) => [tool.id, tool.class]))
const RULES_NOT_ADDED = "RULES_NOT_ADDED:"

function costOf(fleet: StatusResult): StatusCost {
  const top = fleet.cleanup[0]
  const today = fleet.cost.today
  const note = today.unavailable ?? (today.machines === null ? "today's machine cost needs an owner's or admin's boxd sign-in" : undefined)
  return {
    currency: fleet.cost.currency,
    running: fleet.cost.perHour.running,
    asleep: fleet.cost.perHour.asleep,
    perHour: today.unavailable ? null : fleet.cost.perHour.estimate,
    today: today.machines,
    ...(note ? { note: cut(shortReason(note) ?? note, STATUS_LIMIT) } : {}),
    ...(top
      ? {
          cleanup: {
            call: top.call,
            works: top.works,
            ...(top.savesPerHour !== undefined ? { savesPerHour: top.savesPerHour } : {}),
            ...(top.savesPerDay !== undefined ? { savesPerDay: top.savesPerDay } : {}),
          },
        }
      : {}),
  }
}

export function buildStatus(facts: StatusFacts): Status {
  const fleet = facts.fleet
  const state: State = facts.fleetError || !fleet ? "failed" : "connected"
  const listed = facts.tools ?? []
  const unknown = listed.filter((name) => !CLASS_OF.has(name))
  const counts = fleet?.counts ?? {}
  const health = fleet?.health
  const status = {
    version: VERSION,
    state,
    ...(state === "failed" ? { error: cut(shortReason(facts.fleetError?.reason ?? "") ?? "no reason given", STATUS_LIMIT) } : {}),
    host: facts.host,
    access: facts.access,
    signedIn: fleet ? fleet.cli.signedIn : null,
    image: facts.image,
    buildGolden: facts.buildGolden,
    guestVersion: facts.guestVersion,
    openWorks: Object.entries(counts).reduce((sum, [phase, count]) => (phase === "closed" ? sum : sum + (count ?? 0)), 0),
    counts,
    attention: (fleet?.attention ?? []).slice(0, LISTED_ATTENTION).map((item) => ({ workId: item.workId, phase: item.phase, why: item.why, ...(item.error ? { error: item.error } : {}), next: item.next })),
    moreAttention: Math.max(0, (fleet?.attention?.length ?? 0) - LISTED_ATTENTION) + (fleet?.more ?? 0),
    groups: (fleet?.groups ?? []).map((group) => ({ why: group.why, ...(group.error ? { error: group.error } : {}), count: group.count, next: group.next })),
    orphans: (fleet?.orphans ?? []).map((orphan) => `${orphan.machine} (${orphan.region})`),
    regions: (fleet?.regions ?? []).map(({ region, limit, inUse, free }) => ({ region, limit, inUse, free })),
    cost: fleet ? costOf(fleet) : null,
    automation: fleet?.automation ?? "unknown",
    notices: facts.notices,
    health: {
      loopLagMaxMs: health?.loopLagMaxMs ?? 0,
      children: health?.children.now ?? 0,
      cap: health?.children.cap ?? CAPS.shared,
      droppedNotices: health?.notices?.length ?? 0,
      ...(health?.watcher ? { watcher: cut(shortReason(health.watcher) ?? health.watcher, STATUS_LIMIT) } : {}),
    },
    ...(fleet?.import ? { imported: fleet.import } : {}),
    tools: listed.length,
    unknownCount: unknown.length,
    unknownTools: unknown.filter((name) => SAFE_NAME.test(name)).slice(0, LISTED_UNKNOWN),
    unguardedAgents: unguardedAgents(facts.agents ?? [], facts.access),
    problems: facts.problems ?? [],
  }
  return { ...status, nextStep: nextStepOf(status, facts.fleetError?.nextStep) }
}

function nextStepOf(status: Omit<Status, "nextStep">, failedNext: string | undefined): string {
  if (status.state === "failed") return failedNext ?? "Restart OpenCode, then run /boxd-status again."
  // Every tool runs the boxd CLI, so a CLI that cannot answer comes before every other setup fix.
  if (status.signedIn === false) return SIGN_IN_NEXT_STEP
  const rules = status.problems.find((problem) => problem.startsWith(RULES_NOT_ADDED))
  if (rules) return rules.split(" Next step: ")[1] ?? AGENTS_NEXT_STEP
  if (status.unguardedAgents.length) return AGENTS_NEXT_STEP
  // A folded cause comes first when it is worse than the first single work: one fix reaches many works.
  const group = status.groups[0]
  const first = status.attention[0]
  if (group && (!first || order(group.why) <= order(first.why))) return `${group.count} works: ${group.next}.`
  if (first) return `${first.workId} (${first.why}${first.error ? `, ${first.error}` : ""}): ${first.next}.`
  if (status.orphans.length) return `Call boxd_ensure with the work id of ${list(status.orphans)} to adopt it, or remove it with the boxd CLI.`
  const problem = status.problems[0]?.split(" Next step: ")[1]
  return problem ?? NOTHING_TO_DO
}

const ORDER = ["failed", "unreachable", "gone-unsaved", "idle-unsaved", "asleep-unsaved", "stuck", "orphan", "version", "laptop-copy", "idle-running", "needs-input", "lease-expiring", "budget"]
const order = (why: string) => (ORDER.includes(why) ? ORDER.indexOf(why) : ORDER.length)

const list = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`)

/** The permission posture the default rules fix, derived from the tool classes so it cannot go stale. */
function accessText(status: Status) {
  const changing = TOOLS.filter((tool) => tool.class !== "read")
  const classes = [...new Set(changing.map((tool) => tool.class))].join(", ")
  const posture =
    status.access === "all"
      ? `every tool is allowed without asking, including the ${changing.length} machine changes (${classes}); option access is "all"`
      : status.access === "ask-changes"
        ? `reads run without asking; the ${changing.length} machine changes (${classes}) ask first; option access is "ask-changes"`
        : `reads run without asking; the ${changing.length} machine changes (${classes}) are denied; option access is "read-only"`
  const rules = status.problems.some((problem) => problem.startsWith(RULES_NOT_ADDED))
    ? "the default rules are missing (see the OpenCode row)"
    : status.unguardedAgents.length
      ? "the default rules are missing in the agents listed below"
      : "no agent runs a new boxd tool unasked"
  return `${posture}; ${rules}`
}

function toolsText({ tools, unknownCount, unknownTools, access }: Status) {
  if (unknownCount === 0) return `${tools} available, 0 unknown`
  const more = unknownCount - unknownTools.length
  const names = unknownTools.length ? `: ${unknownTools.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : ""
  const unknown = access === "read-only" ? "are denied" : access === "ask-changes" ? "ask before running" : "run without asking"
  return `${tools} available, ${unknownCount} unknown${names} (unknown tools ${unknown})`
}

/** The boxd CLI row: the sign-in is the CLI's own, so status reports whether the CLI answered its machine listing. */
function cliText({ signedIn }: Status) {
  const never = "the plugin never reads your boxd account or credentials"
  if (signedIn === true) return `signed in (it answered the machine listing; ${never})`
  if (signedIn === false) return `not signed in, or not reachable (the machine listing failed; ${never})`
  return `not checked (${never})`
}

function imageText({ image, buildGolden }: Status) {
  return buildGolden === "auto" ? `${image} for a new work in the default size; boxd_ensure builds it when it is missing` : `${image} for a new work in the default size; buildGolden is "never", so boxd_golden builds it`
}

/** The Works row: counts by phase, in the one phase order, and machines no ledger records. */
function worksText({ openWorks, counts, orphans, imported }: Status) {
  const unowned = orphans.length ? `; machines no ledger records: ${list(orphans)}` : ""
  const from = imported ? `; ${imported.works} imported from v0${imported.errors ? `, ${imported.errors} blocked` : ""}` : ""
  if (openWorks === 0) return `no open work${unowned}${from}`
  const phases = PHASES.filter((phase) => phase !== "closed" && counts[phase]).map((phase) => `${counts[phase]} ${phase}`)
  return `${openWorks} open: ${phases.join(", ")}${unowned}${from}`
}

function attentionText({ attention, groups, moreAttention }: Status) {
  if (!attention.length && !groups.length) return "none"
  const folded = groups.map((group) => `${group.count} works ${group.why}${group.error ? ` (${group.error})` : ""}`)
  const single = attention.map((item) => `${item.workId} ${item.why}${item.error ? ` (${item.error})` : ""}`)
  const more = moreAttention ? `; and ${moreAttention} more` : ""
  return `${[...folded, ...single].join("; ")}${more}; boxd_status has each next call`
}

function machinesText({ regions }: Status) {
  if (!regions.length) return "the machine limit could not be read"
  return regions.map((region) => `${region.region} ${region.inUse} of ${region.limit} in use, ${region.free} free`).join("; ")
}

const SYMBOLS: Readonly<Record<string, string>> = { EUR: "€", USD: "$", GBP: "£" }
const money = (amount: number, currency: string) => (SYMBOLS[currency] ? `${SYMBOLS[currency]}${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`)

function costText({ cost }: Status) {
  if (!cost) return "not read"
  const machines = `${cost.running} running, ${cost.asleep} asleep`
  const hour = cost.perHour === null ? "no estimate" : `~${money(cost.perHour, cost.currency)}/h (an estimate)`
  const today = cost.today === null ? "" : `; today ${money(cost.today, cost.currency)} on machines`
  const top = cost.cleanup
    ? `; cleanup: ${cost.cleanup.call}${cost.cleanup.savesPerHour !== undefined ? ` saves ~${money(cost.cleanup.savesPerHour, cost.currency)}/h` : cost.cleanup.savesPerDay !== undefined ? ` saves ~${money(cost.cleanup.savesPerDay, cost.currency)}/day` : ""}, or /boxd-cleanup`
    : ""
  return `${machines}, ${hour}${today}${top}${cost.note ? ` (${cost.note})` : ""}`
}

function automationText({ automation, notices }: Status) {
  const what =
    automation === "on"
      ? "on: finished works are harvested, then hibernated, after autoSleepMinutes"
      : automation === "on (consent)"
        ? 'on by your automation: "on": finished works are harvested, then hibernated, after autoSleepMinutes'
        : automation === "off (access)"
          ? 'off at this access level; set automation: "on" to consent, or clean up with boxd_sleep'
          : automation === "not-owner"
            ? "another OpenCode process on this laptop runs it"
            : automation === "off"
              ? "off (automation: \"off\")"
              : "unknown"
  return `${what}; notices: ${notices}`
}

function healthText({ health }: Status) {
  const watcher = health.watcher ? `; ${health.watcher}` : ""
  const dropped = health.droppedNotices ? `; ${health.droppedNotices} notices dropped` : ""
  return `event-loop delay at most ${health.loopLagMaxMs} ms; ${health.children} of ${health.cap} boxd processes${dropped}${watcher}`
}

/** The OpenCode row: the version, whether it is tested, the supported range, then any setup problems. */
function hostText({ host, problems }: Status) {
  const { version, range, tested } = host
  const outside = version === null || !isSupportedHost(version)
  const notes = [
    ...(outside ? [`It is outside the supported range; the plugin runs because allowUntestedHost is true. If it misbehaves, use OpenCode ${TESTED_TEXT}.`] : []),
    ...problems,
  ]
  return `${version ?? "unknown version"} (${tested ? "tested" : "untested"}; supported range ${range})${notes.length ? `. ${notes.join(" ")}` : ""}`
}

const TESTED_TEXT = `${TESTED_HOSTS.slice(0, -1).join(", ")} or ${TESTED_HOSTS.at(-1)}`

export function formatStatus(status: Status) {
  const agents = status.unguardedAgents
  const connection =
    status.state === "failed"
      ? `failed (${status.error ?? "no reason given"})`
      : `connected (the ledger is readable; ${status.openWorks} open ${status.openWorks === 1 ? "work" : "works"})`
  return [
    `${DISPLAY_NAME} status`,
    `- boxd CLI: ${cliText(status)}`,
    `- Connection: ${connection}`,
    `- Access: ${accessText(status)}`,
    `- Image: ${imageText(status)}`,
    `- Guest: OpenCode ${status.guestVersion ?? "unknown"}, this laptop's version, to move a transcript; reads work across versions`,
    `- Works: ${worksText(status)}`,
    `- Attention: ${attentionText(status)}`,
    `- Machines: ${machinesText(status)}`,
    `- Cost: ${costText(status)}`,
    `- Automation: ${automationText(status)}`,
    `- Health: ${healthText(status)}`,
    `- Tools: ${toolsText(status)}`,
    `- Agents without default rules: ${agents.length ? `${agents.join(", ")}\n${agentRules(status.access)}` : "none"}`,
    `- OpenCode: ${hostText(status)}`,
    `- Next step: ${status.nextStep}`,
  ].join("\n")
}

interface StatusContext {
  readonly agent: Pick<Plugin.Context["agent"], "list">
  readonly tool: Pick<Plugin.Context["tool"], "list">
}

/** A coded error's reason and its own next step; any other error's message. */
function failureOf(error: unknown): { reason: string; nextStep?: string } {
  if (error instanceof BoxdError) {
    const again = error.state === "busy" ? "Run /boxd-status again in a few seconds." : `${error.next.replace(/\.$/, "")}, then run /boxd-status again.`
    return { reason: `${error.code}: ${error.what}`, nextStep: again }
  }
  return { reason: shortReason(error instanceof Error ? error.message : String(error)) ?? "no reason given" }
}

/** Reads the live facts through public host APIs and the fleet view; never reads a guest. A failed read is `failed`. */
export async function readStatus(
  ctx: StatusContext,
  facts: Omit<StatusFacts, "fleet" | "fleetError" | "tools" | "agents"> & { readonly fleet: () => Promise<StatusResult> },
): Promise<Status> {
  const [agents, tools, fleet] = await Promise.all([
    ctx.agent.list(),
    ctx.tool.list(),
    facts.fleet().then(
      (value) => ({ value }),
      (error: unknown) => ({ error: failureOf(error) }),
    ),
  ])
  const { fleet: _read, ...rest } = facts
  return buildStatus({
    ...rest,
    ...("value" in fleet ? { fleet: fleet.value } : { fleetError: fleet.error }),
    tools: tools.filter((tool) => tool.options?.namespace === "boxd").map((tool) => tool.id),
    agents: agents.data,
  })
}

/** The status reader `src/plugin.ts` wires into `/boxd-status`, the dialog and the status RPC. */
export function statusReader(
  ctx: StatusContext,
  input: { readonly services: FleetServices; readonly host: HostCheck; readonly problems: () => readonly string[] },
): () => Promise<Status> {
  const { options, hostVersion } = input.services
  let reads = 0
  return () =>
    readStatus(ctx, {
      access: options.access,
      host: input.host,
      // The image a new work in the default size boots from: <prefix>-<this laptop's OpenCode>-<size>.
      image: `${options.goldenPrefix}-${hostVersion ?? "unknown"}-${options.size}`,
      buildGolden: options.buildGolden,
      guestVersion: hostVersion,
      notices: options.notices,
      problems: input.problems(),
      fleet: () =>
        fleetStatus(input.services, { view: "attention", limit: LISTED_ATTENTION, include: [] }, { tag: { callId: `status-${++reads}`, source: "status-command" }, guestReads: false }),
    })
}

/** Why status could not be read: a coded message and its next step. The reason is cut like a failure's. */
function unavailable(error: unknown) {
  const reason = shortReason(error instanceof Error ? error.message : String(error))
  return { message: `STATUS_UNAVAILABLE: Could not read boxd's status${reason ? ` (${reason})` : ""}.`, nextStep: "Restart OpenCode, then run /boxd-status again." }
}

const strings = { type: "array", items: { type: "string" } }
const count = { type: "integer", minimum: 0 }
const nullableString = { type: ["string", "null"] }
const nullableNumber = { type: ["number", "null"] }

/** One read-only method for the TUI view and scripts: the same model `/boxd-status` renders. */
export const StatusRpc = {
  id: PLUGIN_ID,
  methods: {
    status: {
      input: { type: "object" },
      output: {
        type: "object",
        required: [
          "version",
          "state",
          "access",
          "host",
          "signedIn",
          "image",
          "buildGolden",
          "guestVersion",
          "openWorks",
          "counts",
          "attention",
          "moreAttention",
          "groups",
          "orphans",
          "regions",
          "cost",
          "automation",
          "notices",
          "health",
          "tools",
          "unknownCount",
          "unknownTools",
          "unguardedAgents",
          "problems",
          "nextStep",
        ],
        properties: {
          version: { type: "string" },
          state: { enum: ["connected", "failed"] },
          access: { enum: ["all", "ask-changes", "read-only"] },
          error: { type: "string" },
          host: {
            type: "object",
            required: ["version", "range", "tested"],
            properties: { version: nullableString, range: { type: "string" }, tested: { type: "boolean" } },
          },
          signedIn: { type: ["boolean", "null"] },
          image: { type: "string" },
          buildGolden: { enum: ["auto", "never"] },
          guestVersion: nullableString,
          openWorks: count,
          counts: { type: "object", additionalProperties: count },
          attention: {
            type: "array",
            items: {
              type: "object",
              required: ["workId", "phase", "why", "next"],
              properties: { workId: { type: "string" }, phase: { enum: [...PHASES] }, why: { type: "string" }, error: { type: "string" }, next: { type: "string" } },
            },
          },
          moreAttention: count,
          groups: {
            type: "array",
            items: { type: "object", required: ["why", "count", "next"], properties: { why: { type: "string" }, error: { type: "string" }, count, next: { type: "string" } } },
          },
          orphans: strings,
          regions: {
            type: "array",
            items: { type: "object", required: ["region", "limit", "inUse", "free"], properties: { region: { type: "string" }, limit: count, inUse: count, free: { type: "integer" } } },
          },
          cost: {
            type: ["object", "null"],
            required: ["currency", "running", "asleep", "perHour", "today"],
            properties: {
              currency: { type: "string" },
              running: count,
              asleep: count,
              perHour: nullableNumber,
              today: nullableNumber,
              note: { type: "string" },
              cleanup: {
                type: "object",
                required: ["call", "works"],
                properties: { call: { type: "string" }, works: count, savesPerHour: { type: "number" }, savesPerDay: { type: "number" } },
              },
            },
          },
          automation: { type: "string" },
          notices: { enum: ["wake", "queue", "off"] },
          health: {
            type: "object",
            required: ["loopLagMaxMs", "children", "cap", "droppedNotices"],
            properties: { loopLagMaxMs: { type: "number" }, children: count, cap: count, droppedNotices: count, watcher: { type: "string" } },
          },
          imported: { type: "object", required: ["works", "errors"], properties: { works: count, errors: count } },
          tools: count,
          unknownCount: count,
          unknownTools: strings,
          unguardedAgents: strings,
          problems: strings,
          nextStep: { type: "string" },
        },
      },
      errors: { unavailable: { type: "object", required: ["nextStep"], properties: { nextStep: { type: "string" } } } },
    },
  },
  events: {},
} satisfies Rpc.PortableDefinition

export function registerStatusRpc(rpc: Pick<Plugin.Context["rpc"], "register">, read: () => Promise<Status>) {
  return rpc.register(StatusRpc, {
    status: (_input, { error }) =>
      read().catch((cause: unknown) => {
        const { message, nextStep } = unavailable(cause)
        return error("unavailable", message, { nextStep })
      }),
  })
}

export function registerStatusCommand(
  ctx: { readonly command: Pick<Plugin.Context["command"], "transform">; readonly session: Pick<Plugin.Context["session"], "synthetic"> },
  read: () => Promise<Status>,
) {
  return ctx.command.transform((editor) =>
    editor.add({
      name: `${COMMAND_STEM}-status`,
      description: "Show boxd's works, machines, cost, permission posture and the next step",
      execute: async ({ sessionID }) => {
        const text = await read().then(formatStatus, (cause: unknown) => {
          const { message, nextStep } = unavailable(cause)
          return `${message} Next step: ${nextStep}`
        })
        await ctx.session.synthetic({ sessionID, text, description: "boxd status", resume: false })
      },
    }),
  )
}
