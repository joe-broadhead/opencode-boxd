import type { Plugin, Rpc } from "@opencode/plugin"
import { COMMAND_STEM, DISPLAY_NAME, PLUGIN_ID, TESTED_HOSTS } from "./constants.js"
import { isSupportedHost, type HostCheck } from "./host-version.js"
import { defaultRules, unguardedAgents, type Access, type Rule } from "./permissions.js"
import { cut, shortReason } from "./redact.js"
import { failureText, nextStepFor, type RunOutcome } from "./outcome.js"
import { TOOLS } from "./tools.js"
import type { FleetStatus, WorkSummary } from "./fleet.js"
import { VERSION } from "./version.js"

export { shortReason }

/** The status labels (S9) in machine form; the report shows `failed` and `connected` as written. */
type State = "connected" | "failed"
export type { WorkSummary }

/** What status is built from. The TUI fills what it can see; fields it cannot see stay undefined. */
export interface StatusFacts {
  /** What the plugin's own tools may do without asking, from the option. */
  readonly access: Access
  readonly host: HostCheck
  readonly snapshot: string
  /** This laptop's OpenCode version, which the guest must match. */
  readonly guestVersion: string | null
  readonly ledger?: FleetStatus
  /** The ledger could not be read: status is `failed`, with this reason. */
  readonly ledgerError?: string
  readonly tools?: readonly string[]
  readonly agents?: readonly { readonly id: string; readonly permissions: readonly Rule[] }[]
  readonly problems?: readonly string[]
}

/**
 * One status model for `/boxd-status`, the `/boxd` dialog and the status RPC. `version`, `host`, `state`,
 * `unguardedAgents` and `nextStep` are the fields every plugin of this family shares; the rest are boxd's own.
 */
export interface Status {
  readonly version: string
  readonly state: State
  /** For a failed ledger only: the reason, on one line of at most 160 characters. */
  readonly error?: string
  readonly host: HostCheck
  readonly snapshot: string
  /** Whether the golden snapshot exists in the account; null when the listing could not be read. */
  readonly snapshotPresent: boolean | null
  /** The OpenCode version the machine must run: this laptop's own. */
  readonly guestVersion: string | null
  /** Every open work, with its proof state and the machine's state when boxd answered. */
  readonly works: readonly WorkSummary[]
  readonly openWorks: number
  /** Open works whose laptop import is missing or older than the last prompt. */
  readonly unharvested: readonly string[]
  /** `oc-*` machines the account has that no open work records. */
  readonly orphans: readonly string[]
  /** Open works hibernated before their last prompt was harvested. */
  readonly warned: readonly string[]
  /** Open works whose guest session's last run failed, with the redacted error. */
  readonly failedRuns: readonly { readonly workId: string; readonly error?: string }[]
  /** How many boxd tools OpenCode lists. */
  readonly tools: number
  /** How many of the listed `boxd_*` tools this version does not know. */
  readonly unknownCount: number
  readonly unknownTools: readonly string[]
  /** Agents where a new boxd tool would run without asking; empty when there are none. */
  readonly unguardedAgents: readonly string[]
  /** What the plugin's own tools may do without asking, from the option. */
  readonly access: Access
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
const LISTED_UNKNOWN = 20
// A tool name comes from the host; list only plain names.
const SAFE_NAME = /^[a-z][a-z0-9_]{0,63}$/
const STATUS_LIMIT = 160
const CLASS_OF = new Map(TOOLS.map((tool) => [tool.id, tool.class]))
const RULES_NOT_ADDED = "RULES_NOT_ADDED:"

export function buildStatus(facts: StatusFacts): Status {
  const state: State = facts.ledgerError ? "failed" : "connected"
  const listed = facts.tools ?? []
  const unknown = listed.filter((name) => !CLASS_OF.has(name))
  const works = facts.ledger?.works ?? []
  const unharvested = works.filter((work) => work.proof !== "fresh").map((work) => work.workId)
  const warned = works.filter((work) => work.warnings.length > 0).map((work) => work.workId)
  const failedRuns = works.filter((work) => work.outcome === "failed").map((work) => ({ workId: work.workId, ...(work.error ? { error: work.error } : {}) }))
  const status = {
    version: VERSION,
    state,
    ...(facts.ledgerError ? { error: cut(shortReason(facts.ledgerError) ?? "no reason given", STATUS_LIMIT) } : {}),
    access: facts.access,
    host: facts.host,
    snapshot: facts.snapshot,
    snapshotPresent: facts.ledger?.snapshotPresent ?? null,
    guestVersion: facts.guestVersion,
    works,
    openWorks: works.length,
    unharvested,
    orphans: facts.ledger?.orphans ?? [],
    warned,
    failedRuns,
    tools: listed.length,
    unknownCount: unknown.length,
    unknownTools: unknown.filter((name) => SAFE_NAME.test(name)).slice(0, LISTED_UNKNOWN),
    unguardedAgents: unguardedAgents(facts.agents ?? [], facts.access),
    problems: facts.problems ?? [],
  }
  return { ...status, nextStep: nextStepOf(status) }
}

function nextStepOf(status: Omit<Status, "nextStep">): string {
  if (status.state === "failed") return "Restart OpenCode, then run /boxd-status again."
  // Without its golden image no machine can be created or rebuilt, so this comes before every other setup fix.
  if (status.snapshotPresent === false) {
    return `Create the golden image named "${status.snapshot}" as docs/golden-image.md describes, then set the snapshot option to it.`
  }
  const rules = status.problems.find((problem) => problem.startsWith(RULES_NOT_ADDED))
  if (rules) return rules.split(" Next step: ")[1] ?? AGENTS_NEXT_STEP
  if (status.unguardedAgents.length) return AGENTS_NEXT_STEP
  // A run that failed is the one thing an agent must not read as success: it outranks the housekeeping steps.
  if (status.failedRuns.length) {
    const first = status.failedRuns[0]!
    const run = { outcome: "failed" as const, ...(first.error ? { error: first.error } : {}) }
    const more = status.failedRuns.length > 1 ? ` ${status.failedRuns.length - 1} more ${status.failedRuns.length === 2 ? "work has" : "works have"} a failed run too.` : ""
    return `${failureText(run, first.workId)} ${nextStepFor(run)}${more}`
  }
  if (status.orphans.length) {
    return `Call boxd_ensure for the work id ${status.orphans.length === 1 ? "named" : "named"} by ${list(status.orphans.map((name) => name.replace(/^oc-/, "")))} to adopt ${status.orphans.length === 1 ? "a machine" : "machines"} no ledger records, or remove them with the boxd CLI.`
  }
  if (status.warned.length) {
    return `Call boxd_resume and then boxd_harvest for ${list(status.warned)}: it was hibernated before its last prompt was harvested.`
  }
  if (status.unharvested.length) {
    const names = list(status.unharvested)
    return `Call boxd_harvest for ${names}: sleep, image and drop refuse without a fresh import on this laptop.`
  }
  const problem = status.problems[0]?.split(" Next step: ")[1]
  return problem ?? NOTHING_TO_DO
}

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

function toolsText({ tools, unknownCount, unknownTools }: Status) {
  if (unknownCount === 0) return `${tools} available, 0 unknown`
  const more = unknownCount - unknownTools.length
  const names = unknownTools.length ? `: ${unknownTools.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : ""
  return `${tools} available, ${unknownCount} unknown${names} (unknown tools ask before running)`
}

/** The last run's outcome, beside the work it belongs to. */
function outcomeText(outcome: RunOutcome | null): string {
  if (outcome === null) return ""
  if (outcome === "failed") return ", last run failed"
  if (outcome === "aborted") return ", last run aborted"
  return ", last run completed"
}

/** The Snapshot row: the configured image, and whether this account actually has it. */
function snapshotText({ snapshot, snapshotPresent }: Status) {
  if (snapshotPresent === false) return `${snapshot} (not in this boxd account)`
  if (snapshotPresent === null) return `${snapshot} (not checked: the snapshot list could not be read)`
  return `${snapshot} (present)`
}

/** The Works row: what is open, and what is not yet safe to sleep, image or drop. */
function worksText({ openWorks, unharvested, warned, orphans, works }: Status) {
  const unowned = orphans.length ? `; machines no ledger records: ${list(orphans)}` : ""
  if (openWorks === 0) return `no open work${unowned}`
  const machines = works
    .map((work) => `${work.workId} (${work.machineStatus ?? "state unknown"}${outcomeText(work.outcome)}${work.outcome === "failed" && work.error ? `: ${work.error}` : ""})`)
    .join(", ")
  const stale = unharvested.length ? `; no fresh laptop import: ${list(unharvested)}` : "; every work has a fresh laptop import"
  const asleep = warned.length ? `; hibernated before a harvest: ${list(warned)}` : ""
  return `${openWorks} open: ${machines}${stale}${asleep}${unowned}`
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
    `- Connection: ${connection}`,
    `- Account: not read: the plugin never reads your boxd account or credentials, and boxd_status runs one read-only machine get per open work`,
    `- Access: ${accessText(status)}`,
    `- Snapshot: ${snapshotText(status)}`,
    `- Guest: must be OpenCode ${status.guestVersion ?? "unknown"}, this laptop's version; a job or a harvest checks it`,
    `- Works: ${worksText(status)}`,
    `- Tools: ${toolsText(status)}`,
    `- Agents without default rules: ${agents.length ? `${agents.join(", ")}\n${agentRules(status.access)}` : "none"}`,
    `- OpenCode: ${hostText(status)}`,
    `- Next step: ${status.nextStep}`,
  ].join("\n")
}

export interface StatusContext {
  readonly agent: Pick<Plugin.Context["agent"], "list">
  readonly tool: Pick<Plugin.Context["tool"], "list">
}

/** Reads the live facts through public host APIs; never calls boxd. A failed ledger read is the `failed` state. */
export async function readStatus(
  ctx: StatusContext,
  facts: Pick<StatusFacts, "host" | "snapshot" | "guestVersion" | "problems" | "access"> & { readonly ledger: () => Promise<FleetStatus> },
): Promise<Status> {
  const [agents, tools, ledger] = await Promise.all([
    ctx.agent.list(),
    ctx.tool.list(),
    facts.ledger().then(
      (value) => ({ value }),
      (error: unknown) => ({ error: shortReason(error instanceof Error ? error.message : String(error)) ?? "no reason given" }),
    ),
  ])
  return buildStatus({
    access: facts.access,
    host: facts.host,
    snapshot: facts.snapshot,
    guestVersion: facts.guestVersion,
    ...(facts.problems ? { problems: facts.problems } : {}),
    ...("value" in ledger ? { ledger: ledger.value } : { ledgerError: ledger.error }),
    tools: tools.filter((tool) => tool.options?.namespace === "boxd").map((tool) => tool.id),
    agents: agents.data,
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

/** One read-only method for the TUI view and scripts: the same model `/boxd-status` renders. */
export const StatusRpc = {
  id: PLUGIN_ID,
  methods: {
    status: {
      input: { type: "object" },
      output: {
        type: "object",
        required: ["version", "state", "access", "host", "snapshot", "snapshotPresent", "guestVersion", "works", "openWorks", "unharvested", "orphans", "warned", "failedRuns", "tools", "unknownCount", "unknownTools", "unguardedAgents", "problems", "nextStep"],
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
          snapshot: { type: "string" },
          snapshotPresent: { type: ["boolean", "null"] },
          guestVersion: nullableString,
          works: {
            type: "array",
            items: {
              type: "object",
              required: ["workId", "machine", "sessionId", "proof", "dirty", "machineStatus", "warnings"],
              properties: {
                workId: { type: "string" },
                machine: { type: "string" },
                sessionId: nullableString,
                proof: { enum: ["fresh", "stale", "missing"] },
                dirty: { type: "boolean" },
                machineStatus: { type: ["string", "null"] },
                warnings: strings,
                outcome: { type: ["string", "null"], enum: ["completed", "failed", "aborted", null] },
                error: { type: "string" },
              },
            },
          },
          openWorks: count,
          unharvested: strings,
          orphans: strings,
          warned: strings,
          failedRuns: {
            type: "array",
            items: { type: "object", required: ["workId"], properties: { workId: { type: "string" }, error: { type: "string" } } },
          },
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
      description: "Show boxd's ledger, machines, permission posture and the next step",
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

