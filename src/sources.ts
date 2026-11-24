/**
 * boxd's side of the source contract (`@we-the-rebel-alliance/source-contract`, declared in `package.json`'s `sources`
 * as `boxd.works`): `events_list`, each phase change of each work as one normalised event, oldest first, and `probe`,
 * whose ledger it is. Both are tools RPC methods for a collector; `events_list` is also the `boxd_events_list` tool, and
 * `probe` is a method only.
 *
 * - **Local only.** `events_list` reads the laptop ledger's `events.jsonl` through `LedgerPort.eventsSince`, the log
 *   `boxd_status` reads its cursor from. It makes no boxd call and no network call, never wakes a machine, and never
 *   takes the ledger's write locks: the log is append-only, and reading it takes no lock. `probe` reads nothing at all:
 *   the account is this computer and the owner its OS user, as `os-user:<user>@<computer>`.
 * - **The plugin's own words.** An event's title is the plugin's sentence for the change (the work id, the phase, how
 *   a run ended and its code, who put a machine to sleep); its labels are the same facts as `phase:`, `outcome:`,
 *   `code:`, `asleep-by:` and `needs:`. Nothing a guest wrote, no prompt, no transcript and no work title reaches an
 *   event, and an event has no text, actors or link. A title that holds a secret (a work id shaped like a key) is
 *   refused for good, as `refused[]` with reason `secret`.
 * - **The cursor** is the log's own sequence number, bound to the plugin, the source and the account, with the time of
 *   the last event it covers. A sequence number the log no longer keeps (it rotates at 5 MiB) or never had (another
 *   ledger's) is the ledger's `cursorExpired`: the page starts again at the oldest kept event and carries
 *   `gap: { reason: "expired", since }`, `since` being the time of the last event the cursor covered. A first read whose
 *   window starts before the oldest kept event says so the same way.
 * - **While the v0 import runs** there is no published ledger to read: `events_list` answers `UNAVAILABLE` and the import
 *   progress, and never starts or retries the import itself (a retry lists machines with the boxd CLI). A failed import
 *   answers `UNAVAILABLE` too, until a boxd tool has run it again.
 */
import { hostname, userInfo } from "node:os"
import { decodeBoundCursor, encodeBoundCursor, type CursorBinding } from "@we-the-rebel-alliance/source-contract/cursor"
import {
  EVENT_LIMITS,
  EVENTS_LIST,
  PAGE,
  PROBE,
  SourceError,
  eventsListResult,
  makeEvent,
  oldestFirst,
  parseEventsListInput,
  parseProbeInput,
  probeResult,
  screenEvents,
  startTime,
  type EventsGap,
  type EventsListIdentity,
  type EventsListResult,
  type EventsOwner,
  type ProbeResult,
  type RefusedEvent,
  type SourceEvent,
} from "@we-the-rebel-alliance/source-contract/events"
import type { JsonSchema, PluginMethod, ToolCall } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import type { Plugin } from "@opencode/plugin"
import { BoxdError } from "./errors.js"
import type { ImportV0Port, LedgerPort, OpContext, WorkEvent } from "./ports.js"

/** The plugin's package name, which every page names. */
export const PACKAGE = "@we-the-rebel-alliance/boxd-plugin"
/** The cursor binding's plugin: the descriptor's source-id prefix. */
export const NAMESPACE = "boxd"
/** The source every event names, and the descriptor's `input.source`. */
export const SOURCE = "works"
/** The descriptor's id for it. */
export const SOURCE_ID = "boxd.works"
/** Every event's kind: boxd's own, one phase change of one work. */
export const KIND = "x-boxd/work"
/** The permission action of events_list: the descriptor's `permission.events`. */
export const EVENTS_ACTION = `${NAMESPACE}_${EVENTS_LIST}`
/** The permission action of probe: the descriptor's `sources.probe.action`. */
export const PROBE_ACTION = `${NAMESPACE}_${PROBE}`
/** The most bytes of JSON one page holds: the descriptor's `maxBytes`. */
export const MAX_BYTES = 65_536
/** What a page's envelope takes beside its events and refusals: the source, account, owner, cursor, gap and the rest. */
const PAGE_ENVELOPE_BYTES = 2_048

/** Whose ledger this is: the computer it is on, and the OS user who runs OpenCode there. */
export interface LocalIdentity {
  /** The computer's host name as a slug, such as `studio-mac`. */
  readonly account: string
  /** `os-user:<user>@<account>`, labelled `<user> on <account>`. */
  readonly owner: EventsOwner
}

const slug = (text: string, max: number) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, max)

/** The identity for an OS user and a host name, as given. */
export function identityOf(user: string, host: string): LocalIdentity {
  const account = slug(host.replace(/\.local\.?$/i, ""), 63) || "local"
  const name = slug(user, 64) || "user"
  return { account, owner: { id: `os-user:${name}@${account}`, label: `${name} on ${account}` } }
}

/** This process's OS user and host name. A user with no password entry, as in some containers, falls back to $USER. */
export function localIdentity(): LocalIdentity {
  let user: string
  try {
    user = userInfo().username
  } catch {
    user = process.env.USER ?? process.env.LOGNAME ?? ""
  }
  return identityOf(user, hostname())
}

/** What the source reads: the ledger's event log, the import's state, whose ledger it is, and the clock. */
export interface SourceDeps {
  readonly ledger: Pick<LedgerPort, "eventsSince">
  readonly importV0: Pick<ImportV0Port, "state">
  readonly identity: () => LocalIdentity
  readonly now: () => Date
}

/** The cursor's state: the last sequence number it covers (`q`), and that event's time or the window's start (`t`). */
export interface CursorState {
  readonly q: number
  readonly t: string
}

const binding = (account: string): CursorBinding => ({ plugin: NAMESPACE, source: SOURCE, account })

export const encodeWorksCursor = (account: string, state: CursorState): string => encodeBoundCursor(binding(account), { q: state.q, t: state.t })

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

function decodeWorksCursor(account: string, cursor: string): CursorState {
  const decoded = decodeBoundCursor(binding(account), cursor)
  const q = decoded.ok ? decoded.state["q"] : undefined
  const t = decoded.ok ? decoded.state["t"] : undefined
  if (!decoded.ok || typeof q !== "number" || !Number.isSafeInteger(q) || q < 0 || typeof t !== "string" || !ISO.test(t) || Number.isNaN(Date.parse(t))) {
    throw new SourceError({
      code: "CURSOR_INVALID",
      what: `The cursor is not one this source issued for the works of ${account}`,
      next: "Call events_list again without a cursor, with since, to start over.",
    })
  }
  return { q, t }
}

const opContext = (call: Pick<ToolCall, "signal"> | undefined, source: "boxd_events_list" | "boxd_probe"): OpContext => ({
  call: { callId: `${source}-${Date.now().toString(36)}`, source },
  pool: "foreground",
  ...(call?.signal ? { signal: call.signal } : {}),
})

/** The import's state as a refusal, or nothing when the published ledger may be read. */
function notReadable(state: ReturnType<ImportV0Port["state"]>): SourceError | undefined {
  if (state.state === "complete") return undefined
  if (state.state === "importing") {
    const progress = state.total > 0 ? ` (${state.done} of ${state.total} works)` : ""
    return new SourceError({
      code: "UNAVAILABLE",
      what: `boxd's ledger is still importing the works of opencode-boxd v0${progress}, so there is no event log to read yet`,
      next: "Call events_list again in a minute, with the same cursor.",
    })
  }
  return new SourceError({
    code: "UNAVAILABLE",
    what: "boxd's v0 import could not finish, so there is no event log to read yet",
    next: "Run /boxd-status and follow its next step, then call events_list again.",
  })
}

/**
 * A ledger failure as the contract's table names it: always `UNAVAILABLE`, with the ledger's code when it has one and
 * never a path. The cursor is not moved: the same call again reads on from it.
 */
function ledgerFailure(error: unknown): SourceError {
  if (error instanceof BoxdError && (error.code === "LEDGER_IMPORTING" || error.code === "IMPORT_V0_FAILED")) {
    return new SourceError({ code: "UNAVAILABLE", what: `boxd's ledger is not readable yet (${error.code})`, next: "Call events_list again in a minute, with the same cursor." })
  }
  if (error instanceof BoxdError && error.state === "busy") {
    return new SourceError({ code: "UNAVAILABLE", what: `boxd's event log was busy (${error.code})`, next: "Call events_list again in a few seconds, with the same cursor." })
  }
  const code = error instanceof BoxdError ? error.code : "the file system refused the read"
  return new SourceError({ code: "UNAVAILABLE", what: `boxd's event log could not be read (${code})`, next: "Run /boxd-status and follow its next step, then call events_list again." })
}

const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  completed: "its run completed",
  failed: "its run failed",
  aborted: "its run was stopped",
}

const ASLEEP_BY: Readonly<Record<string, string>> = {
  boxd_sleep: "put to sleep by boxd_sleep",
  automation: "put to sleep by the plugin's automation",
  "idle-or-cli": "asleep after its idle timeout, or by the boxd CLI",
}

const PHASE_WORDS: Readonly<Record<string, string>> = {
  creating: "its machine is being created",
  starting: "its machine is starting",
  ready: "it is ready",
  busy: "it is running a prompt",
  idle: "it is idle",
  asleep: "its machine is asleep",
  gone: "its machine is gone",
  unreachable: "its machine is unreachable",
  closed: "it is closed",
}

/** The plugin's own sentence for one change: the work id, then the phase, the outcome, the code and who slept it. */
export function titleOf(event: WorkEvent): string {
  const said =
    event.to === "idle" && event.outcome && OUTCOME_WORDS[event.outcome]
      ? OUTCOME_WORDS[event.outcome]!
      : event.to === "asleep" && event.asleepBy && ASLEEP_BY[event.asleepBy]
        ? `its machine is ${ASLEEP_BY[event.asleepBy]}`
        : (PHASE_WORDS[event.to] ?? `it is ${event.to}`)
  const needs = event.needsInput === "permission" ? ", waiting for a permission answer" : event.needsInput === "form" ? ", waiting for an answer to a question" : ""
  const code = event.code ? ` (${event.code})` : ""
  return `Work ${event.workId}: ${said}${code}${needs}`
}

/** One work event as a contract event. */
export function eventOf(event: WorkEvent, account: string): SourceEvent {
  return makeEvent({
    source: SOURCE,
    account,
    external_id: `${event.workId}:${event.seq}`,
    kind: KIND,
    occurred_at: event.at,
    thread: `boxd-work:${event.workId}`,
    title: titleOf(event),
    labels: [
      `phase:${event.to}`,
      ...(event.outcome ? [`outcome:${event.outcome}`] : []),
      ...(event.code ? [`code:${event.code}`] : []),
      ...(event.asleepBy ? [`asleep-by:${event.asleepBy}`] : []),
      ...(event.needsInput ? [`needs:${event.needsInput}`] : []),
    ],
  })
}

/** The account a read names, checked against this computer's; a read of another computer's ledger is refused. */
function checkAccount(account: string | undefined, identity: LocalIdentity): void {
  if (account === undefined || account === identity.account) return
  throw new SourceError({
    code: "ACCOUNT_MISMATCH",
    what: `This source reads the boxd works of ${identity.account} only, and the read named another account`,
    next: `Call it with account "${identity.account}", as probe names it, or without an account.`,
  })
}

function checkSource(source: string | undefined): void {
  if (source === undefined || source === SOURCE) return
  throw new SourceError({ code: "SOURCE_UNKNOWN", what: `boxd has no source named ${source}`, next: `Call it with source "${SOURCE}", or without a source.` })
}

/**
 * One page of `events_list`. The input is checked first; then, with the published ledger only, the log after the
 * cursor (or from the window's start) is read once, cut to the limit and to `MAX_BYTES`, screened for secrets, and
 * answered oldest first.
 */
export async function listWorks(deps: SourceDeps, input: unknown, call?: Pick<ToolCall, "signal">): Promise<EventsListResult> {
  const parsed = parseEventsListInput(input)
  if (!parsed.ok) {
    throw new SourceError({ code: "INPUT_INVALID", what: `events_list's input is invalid: ${parsed.problems.join("; ")}`, next: "Fix the input as the method's schema says, then call it again." })
  }
  const request = parsed.value
  checkSource(request.source)
  const identity = deps.identity()
  checkAccount(request.account, identity)
  const from = request.cursor === undefined ? undefined : decodeWorksCursor(identity.account, request.cursor)
  const refusal = notReadable(deps.importV0.state())
  if (refusal) throw refusal

  const now = deps.now()
  let page
  try {
    page = await deps.ledger.eventsSince(from?.q ?? 0, opContext(call, "boxd_events_list"))
  } catch (error) {
    throw ledgerFailure(error)
  }

  // Where this read starts in the log, and the history it says is lost.
  let lines: readonly WorkEvent[] = page.events
  let gap: EventsGap | undefined
  let start: string
  if (from) {
    start = from.t
    if (page.cursorExpired) gap = { reason: "expired", since: from.t }
  } else {
    const windowStart = startTime(request, now.getTime())
    start = new Date(windowStart).toISOString()
    const first = lines.findIndex((line) => Date.parse(line.at) >= windowStart)
    lines = first === -1 ? [] : lines.slice(first)
    // The log no longer starts at its first event, and its oldest kept event is later than the window's start.
    const oldest = page.events[0]
    if (page.cursorExpired && oldest !== undefined && Date.parse(oldest.at) > windowStart) gap = { reason: "expired", since: start }
  }

  // The page: at most `limit` lines in log order, each an event or a refusal, as many as fit in MAX_BYTES. Every page
  // that has a line covers at least one, so a burst larger than a page drains, page by page, and the cursor always moves.
  let bytes = PAGE_ENVELOPE_BYTES
  const kept: SourceEvent[] = []
  const refused: RefusedEvent[] = []
  let last: WorkEvent | undefined
  let covered = 0
  for (const line of lines.slice(0, request.limit)) {
    const screened = screenEvents([eventOf(line, identity.account)])
    const size = Buffer.byteLength(JSON.stringify(screened.events[0] ?? screened.refused[0])) + 1
    if (last !== undefined && bytes + size > MAX_BYTES) break
    bytes += size
    kept.push(...screened.events)
    refused.push(...screened.refused)
    last = line
    covered++
  }
  const events = oldestFirst(kept)
  // With nothing listed, the cursor is the log's newest sequence number: every line before the window is skipped.
  const state: CursorState = last ? { q: last.seq, t: last.at } : { q: page.cursor, t: start }
  const more = lines.length > covered
  const whose: EventsListIdentity = { source: SOURCE, account: identity.account, owner: identity.owner }
  return eventsListResult(whose, events, encodeWorksCursor(identity.account, state), more, {
    refused,
    ...(gap ? { gap } : {}),
    plugin: PACKAGE,
    asOf: now.toISOString(),
  })
}

/** `probe`: whose ledger this is. It reads nothing, not even the ledger. */
export function probeWorks(deps: Pick<SourceDeps, "identity">, input: unknown): ProbeResult {
  const parsed = parseProbeInput(input)
  if (!parsed.ok) throw new SourceError({ code: "INPUT_INVALID", what: `probe's input is invalid: ${parsed.problems.join("; ")}`, next: "Pass only source and account." })
  checkSource(parsed.value.source)
  const identity = deps.identity()
  checkAccount(parsed.value.account, identity)
  return probeResult({ source: SOURCE, account: identity.account, owner: identity.owner })
}

const STRING = { type: "string" } as const

export const EVENTS_INPUT: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: { type: "string", enum: [SOURCE], description: `The source: "${SOURCE}", the only one.` },
    account: { type: "string", maxLength: EVENT_LIMITS.account, description: "This computer, as probe names it. Another computer's account is refused." },
    since: { ...STRING, description: "Where a read without a cursor starts: an ISO date or date-time. Default: 24 hours ago." },
    cursor: { ...STRING, description: "The previous page's cursor, to list what came after it." },
    limit: { type: "integer", minimum: PAGE.min, maximum: PAGE.max, description: `At most this many events; ${PAGE.default} by default.` },
  },
}

const PROBE_INPUT: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: { type: "string", enum: [SOURCE] },
    account: { type: "string", maxLength: EVENT_LIMITS.account },
  },
}

const EVENTS_DESCRIPTION =
  "For a collector, not for answering questions: the phase changes of the boxd works here, oldest first, as normalised events, " +
  "read from the local ledger only (no boxd call, no machine woken). Each says, in the plugin's own words, which work changed and to what phase, how a run ended and its code. " +
  "Pass the previous page's cursor to list what came after it; without one it starts at since, or 24 hours ago."

const PROBE_DESCRIPTION = "For a consumer binding the boxd.works source: whose ledger this is (this computer, and its OS user). It reads nothing else."

type Assert = Plugin.Context["permission"]["assert"]

/** Each method asserts its own action with the call's source, as a tool does, then reads. */
const asserting = (assert: Assert, action: string, call: ToolCall) =>
  assert({ sessionID: call.sessionID, agent: call.agent, action, resources: ["*"], source: { type: "tool", messageID: call.messageID, id: call.id } })

/** The source's two tools RPC methods, both reads. */
export function sourceMethods(deps: SourceDeps, assert: Assert): readonly PluginMethod[] {
  return [
    {
      kind: "plugin",
      class: "read",
      name: EVENTS_LIST,
      action: EVENTS_ACTION,
      description: EVENTS_DESCRIPTION,
      input: EVENTS_INPUT,
      output: { type: "object" },
      run: async (input, call) => {
        await asserting(assert, EVENTS_ACTION, call)
        return listWorks(deps, input, call)
      },
    },
    {
      kind: "plugin",
      class: "read",
      name: PROBE,
      action: PROBE_ACTION,
      description: PROBE_DESCRIPTION,
      input: PROBE_INPUT,
      output: { type: "object" },
      run: async (input, call) => {
        await asserting(assert, PROBE_ACTION, call)
        return probeWorks(deps, input)
      },
    },
  ]
}
