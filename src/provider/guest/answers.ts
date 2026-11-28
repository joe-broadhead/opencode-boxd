/**
 * The guest helper's answers, read on the laptop. The helper runs on a machine the guest session controls, so every
 * answer is untrusted: each reader keeps only the fields of the port's shape, checks their types, redacts the model's
 * words (`lastText`, `tail`) and a failed run's error, and refuses anything else with `GUEST_FAILED`.
 */
import { boxdError, type BoxdError, type Code } from "../../errors.js"
import { errorLine } from "../../outcome.js"
import {
  FULL_TEXT_LIMIT,
  GUEST_PROTOCOL,
  type DescribeAnswer,
  type DoneReport,
  type ExportAnswer,
  type GitAnswer,
  type HealthAnswer,
  type PhaseAnswer,
  type PromptAnswer,
  type ReadAnswer,
  type Reading,
  type LegacyAnswer,
  type ReleaseAnswer,
  type RunOutcome,
  type ScrubAnswer,
  type ServeAnswer,
  type SessionMarks,
  type SetupAnswer,
  type SlotAnswer,
  type WarmAnswer,
} from "../../ports.js"
import { excerpt, excerptBlock, shortReason } from "../../redact.js"

type Json = Record<string, unknown>

/** The model's words are cut to this in a job's `lastText` and `tail` (status cuts them again, to 200). */
export const TEXT_LIMIT = 300

/** The helper's error codes the laptop passes on as its own; anything else is `GUEST_FAILED`. */
const PASSED_ON: ReadonlySet<string> = new Set<Code>([
  "GUEST_SERVER_DOWN",
  "SESSION_MISSING",
  "SESSION_BUSY",
  "GUEST_WORKSPACE",
  "SECRET_FAILED",
  "GIT_UNKNOWN",
  "EXPORT_INVALID",
  "NAME_INVALID",
  "PATH_REFUSED",
  "ACTS_AS_OPERATOR",
  "GUEST_FAILED",
])

/** The one JSON line the helper prints, or undefined when it printed none (a helper that never ran). */
export function helperLine(stdout: string): Json | undefined {
  const line = stdout
    .split("\n")
    .map((text) => text.trim())
    .reverse()
    .find((text) => text.startsWith("{") && text.endsWith("}"))
  if (!line) return undefined
  try {
    const value = JSON.parse(line) as unknown
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined
  } catch {
    return undefined
  }
}

/** A helper refusal as the plugin's own error: its code when it is one the plugin knows, its words redacted. */
export function helperError(action: string, answer: Json): BoxdError {
  const code = typeof answer.error === "string" && PASSED_ON.has(answer.error) ? (answer.error as Code) : "GUEST_FAILED"
  const detail = shortReason(typeof answer.detail === "string" ? answer.detail : "")
  if (code === "ACTS_AS_OPERATOR") return boxdError(code, `The work would act as its operator${detail ? ` (${detail})` : ""}.`)
  const said = typeof answer.error === "string" && code === "GUEST_FAILED" && answer.error !== "GUEST_FAILED" ? shortReason(answer.error) : undefined
  const words = [said, detail].filter(Boolean).join(": ")
  return boxdError(code, `The guest helper's ${action} failed${words ? ` (${words})` : ""}.`)
}

/** Refuses an answer that is not protocol 1, so a reader never guesses at another helper's fields. */
export function checkProtocol(action: string, answer: Json): void {
  if (answer.protocol !== GUEST_PROTOCOL) {
    throw boxdError("GUEST_FAILED", `The guest helper answered ${action} in protocol ${String(answer.protocol ?? "none")}; this plugin speaks protocol ${GUEST_PROTOCOL}.`)
  }
}

const shape = (action: string) => boxdError("GUEST_FAILED", `The guest helper answered ${action} in a shape this plugin does not know.`)

const string = (value: unknown): value is string => typeof value === "string"
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const count = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0
const SHA = /^[0-9a-f]{64}$/
const SESSION = /^ses_[A-Za-z0-9_-]{1,80}$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
/** A guest path the helper names: absolute, no spaces, no `..`, so it can go straight into `machine cp`. */
const GUEST_FILE = /^\/home\/boxd\/[A-Za-z0-9_./-]+$/
const WORK_DIRECTORY = /^\/home\/boxd\/work\/[a-z][a-z0-9-]{0,24}$/
const ABSOLUTE_PATH = /^\/[A-Za-z0-9_./-]+$/
/** A pull request a done report may name: a GitHub URL, or the same as `owner/repo#n`. */
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/
const PR_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/

const version = (value: unknown): string | null => (string(value) && VERSION.test(value) ? value : null)
const pendingInput = (value: unknown): "form" | "permission" | null | undefined =>
  value === null ? null : value === "form" || value === "permission" ? value : undefined
const iso = (value: unknown): string | undefined => (string(value) && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined)
const guestFile = (action: string, value: unknown): string => {
  if (!string(value) || !GUEST_FILE.test(value) || value.split("/").includes("..")) throw shape(action)
  return value
}

function reading(value: unknown): Reading | undefined {
  const item = value as Json | undefined
  return item && finite(item.residentGiB) && finite(item.load1) ? { residentGiB: item.residentGiB, load1: item.load1 } : undefined
}

const OUTCOMES: ReadonlySet<string> = new Set<RunOutcome>(["completed", "failed", "aborted"])

/**
 * The guest's completion declaration. Its summary is the model's words, so it is cut and redacted like `lastText`; a
 * malformed report is no report, and `prs` keeps only well-formed references, without repeats, at most 20.
 */
function doneReport(value: unknown, full = false): DoneReport | undefined {
  const item = value as Json | undefined
  if (!item || !string(item.summary)) return undefined
  const at = iso(item.at)
  const summary = full ? excerptBlock(item.summary, FULL_TEXT_LIMIT) : excerpt(item.summary, TEXT_LIMIT)
  if (!at || !summary) return undefined
  const prs = Array.isArray(item.prs)
    ? [...new Set(item.prs.flatMap((pr) => (string(pr) && (PR_URL.test(pr) || PR_REF.test(pr)) ? [pr] : [])))].slice(0, 20)
    : []
  return { at, summary, prs }
}

export function readServe(answer: Json): ServeAnswer {
  if (answer.server !== "up" && answer.server !== "starting" && answer.server !== "down") throw shape("serve")
  const clone = answer.clone === "running" || answer.clone === "done" || answer.clone === "failed" ? answer.clone : undefined
  return { server: answer.server, opencode: version(answer.opencode), ...(clone ? { clone } : {}) }
}

/**
 * A `phase` answer. `full` says the read asked for the whole last message: it keeps its line breaks and runs to
 * `FULL_TEXT_LIMIT`, where the default is one line cut to `TEXT_LIMIT`.
 */
export function readPhase(answer: Json, full = false): PhaseAnswer {
  if (answer.phase !== "busy" && answer.phase !== "idle" && answer.phase !== "missing") throw shape("phase")
  const waiting = (answer.waiting ?? {}) as Json
  if (!count(waiting.steer) || !count(waiting.queue)) throw shape("phase")
  const outcome = string(answer.outcome) && OUTCOMES.has(answer.outcome) ? (answer.outcome as RunOutcome) : null
  const lastText = string(answer.lastText) ? (full ? excerptBlock(answer.lastText, FULL_TEXT_LIMIT) : excerpt(answer.lastText, TEXT_LIMIT)) : undefined
  const error = outcome === "failed" ? errorLine(answer.error) : undefined
  const tail = Array.isArray(answer.tail)
    ? answer.tail.flatMap((raw) => {
        const item = raw as Json
        const text = string(item?.text) ? excerpt(item.text, TEXT_LIMIT) : undefined
        if (!text) return []
        const at = iso(item.at)
        return [{ text, ...(at ? { at } : {}) }]
      })
    : undefined
  const read = reading(answer.reading)
  const at = iso(answer.lastActivityAt)
  const done = doneReport(answer.done, full)
  return {
    phase: answer.phase,
    outcome,
    waiting: { steer: waiting.steer, queue: waiting.queue },
    guestVersion: version(answer.guestVersion),
    ...(answer.needsInput === "form" || answer.needsInput === "permission" ? { needsInput: answer.needsInput } : {}),
    ...(read ? { reading: read } : {}),
    ...(error ? { error } : {}),
    ...(at ? { lastActivityAt: at } : {}),
    ...(lastText ? { lastText } : {}),
    ...(done ? { done } : {}),
    ...(tail ? { tail } : {}),
    ...(finite(answer.modelCost) && answer.modelCost >= 0 ? { modelCost: answer.modelCost } : {}),
  }
}

/**
 * A file read. The text is the guest's data and is passed on as it is, for `boxd_read` to redact before it reaches a
 * result; the path is the one asked for.
 */
export function readRead(answer: Json, path: string): ReadAnswer {
  if (!count(answer.bytes)) throw shape("read")
  if (answer.binary === true) {
    if (!string(answer.sha256) || !SHA.test(answer.sha256)) throw shape("read")
    return { binary: true, path, bytes: answer.bytes, sha256: answer.sha256 }
  }
  if (answer.binary !== false || !string(answer.text) || typeof answer.truncated !== "boolean") throw shape("read")
  return { binary: false, path, bytes: answer.bytes, truncated: answer.truncated, text: answer.text }
}

export function readSlots(answer: Json): ReadonlyArray<SlotAnswer> {
  if (!Array.isArray(answer.slots)) throw shape("slots")
  return answer.slots.map((raw) => {
    const item = raw as Json
    if (!string(item?.workId) || !/^[a-z][a-z0-9-]{0,24}$/.test(item.workId) || !count(item.port) || item.port < 1 || item.port > 65535) throw shape("slots")
    if (item.server !== "up" && item.server !== "starting" && item.server !== "down") throw shape("slots")
    if (typeof item.busy !== "boolean") throw shape("slots")
    return { workId: item.workId, port: item.port, server: item.server, busy: item.busy }
  })
}

export function readHealth(answer: Json): HealthAnswer {
  const read = reading(answer.reading)
  const memory = (answer.memory ?? {}) as Json
  if (!read || !count(memory.totalMb) || !count(memory.availableMb) || !finite(answer.load) || !Array.isArray(answer.top)) throw shape("health")
  const top = answer.top.flatMap((raw) => {
    const item = raw as Json
    // A process is named by its command name only, cut and cleaned: never its arguments, which can hold a secret.
    const name = string(item?.name) ? shortReason(item.name.slice(0, 32)) : undefined
    return name && count(item.rssMb) ? [{ name, rssMb: item.rssMb }] : []
  })
  return { reading: read, memory: { totalMb: memory.totalMb, availableMb: memory.availableMb }, load: answer.load, top: top.slice(0, 5) }
}

export function readSetup(answer: Json, helperUploaded: boolean): SetupAnswer {
  if ((answer.server !== "up" && answer.server !== "starting") || (answer.workspace !== "ready" && answer.workspace !== "cloning") || !string(answer.opencode)) throw shape("setup")
  return { server: answer.server, opencode: version(answer.opencode) ?? "", workspace: answer.workspace, helperUploaded }
}

export function readWarm(answer: Json): WarmAnswer {
  return { path: guestFile("warm", answer.path) }
}

export function readPrompt(answer: Json): PromptAnswer {
  const delivery = answer.delivery
  if (!string(answer.sessionId) || !SESSION.test(answer.sessionId) || (delivery !== "steer" && delivery !== "queue" && delivery !== "started") || typeof answer.interrupted !== "boolean" || !count(answer.waitingBefore)) {
    throw shape("prompt")
  }
  return {
    sessionId: answer.sessionId,
    delivery,
    interrupted: answer.interrupted,
    inboxId: string(answer.inboxId) && /^[A-Za-z0-9_-]{0,120}$/.test(answer.inboxId) ? answer.inboxId : "",
    waitingBefore: answer.waitingBefore,
    ...(string(answer.model) ? { model: answer.model } : {}),
  }
}

function marks(action: string, raw: unknown): SessionMarks {
  const item = raw as Json
  if (!string(item?.id) || !SESSION.test(item.id) || !count(item.messages) || !finite(item.updated)) throw shape(action)
  const parentId = item.parentId === null || item.parentId === undefined ? null : string(item.parentId) && SESSION.test(item.parentId) ? item.parentId : undefined
  if (parentId === undefined) throw shape(action)
  const lastMessageId = item.lastMessageId === null ? null : string(item.lastMessageId) && item.lastMessageId.length <= 120 ? item.lastMessageId : undefined
  if (lastMessageId === undefined) throw shape(action)
  return { id: item.id, parentId, lastMessageId, messages: item.messages, updated: item.updated }
}

export function readExport(answer: Json): ExportAnswer {
  if (!string(answer.guestVersion)) throw shape("export")
  if (answer.outcome === "busy") {
    if (!string(answer.reason)) throw shape("export")
    return { outcome: "busy", reason: excerpt(answer.reason, TEXT_LIMIT) ?? "The session is running.", guestVersion: answer.guestVersion }
  }
  if (answer.outcome !== "exported" || typeof answer.busy !== "boolean" || !Array.isArray(answer.sessions) || answer.sessions.length === 0) throw shape("export")
  const sessions = answer.sessions.map((raw) => {
    const item = raw as Json
    if (!count(item?.bytes) || !string(item.sha256) || !SHA.test(item.sha256)) throw shape("export")
    return { ...marks("export", item), file: guestFile("export", item.file), bytes: item.bytes, sha256: item.sha256 }
  })
  const run = (answer.run ?? {}) as Json
  const outcome = string(run.outcome) && OUTCOMES.has(run.outcome) ? (run.outcome as RunOutcome) : null
  const error = outcome === "failed" ? errorLine(run.error) : undefined
  const done = doneReport(run.done)
  return { outcome: "exported", busy: answer.busy, run: { outcome, ...(error ? { error } : {}), ...(done ? { done } : {}) }, sessions, guestVersion: answer.guestVersion }
}

const files = (action: string, value: unknown) => {
  if (!Array.isArray(value)) throw shape(action)
  return value.map((raw) => {
    const item = raw as Json
    if (!string(item?.path) || item.path === "" || item.path.startsWith("/") || item.path.split("/").includes("..") || !count(item.bytes) || !string(item.sha256) || (item.sha256 !== "" && !SHA.test(item.sha256))) {
      throw shape(action)
    }
    return { path: item.path, bytes: item.bytes, sha256: item.sha256 }
  })
}

/** A remote is stored and returned without its userinfo, so a token in it never reaches a result. */
export const withoutUserinfo = (url: string) => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1")

export function readGit(answer: Json): GitAnswer {
  if (typeof answer.known !== "boolean" || typeof answer.dirty !== "boolean") throw shape("git")
  const text = (value: unknown) => (string(value) && value !== "" ? value : null)
  const patch = answer.patch as Json | undefined
  if (patch !== undefined && (!count(patch.bytes) || !string(patch.sha256) || !SHA.test(patch.sha256))) throw shape("git")
  const remote = text(answer.remote)
  // Commit subjects are the guest's words: redacted and cut before they can reach a result or a refusal.
  const commit = (value: unknown): string | undefined => {
    if (!string(value) || !value.trim()) return undefined
    const line = shortReason(value.trim()) ?? value.trim()
    return line.slice(0, 160)
  }
  const named = Array.isArray(answer.unpushed) ? answer.unpushed.flatMap((value) => (commit(value) ? [commit(value)!] : [])) : []
  // A destructive guard: an answer that does not say the count is known is unknown, never 0.
  const known = answer.unpushedKnown === true && count(answer.unpushedCount)
  return {
    known: answer.known,
    remote: remote ? withoutUserinfo(remote) : null,
    branch: text(answer.branch),
    sha: string(answer.sha) && /^[0-9a-f]{40,64}$/.test(answer.sha) ? answer.sha : null,
    dirty: answer.dirty,
    ...(patch ? { patch: { file: guestFile("git", patch.file), bytes: patch.bytes as number, sha256: patch.sha256 as string } } : {}),
    untracked: files("git", answer.untracked),
    ignored: files("git", answer.ignored),
    unpushed: known ? named.slice(0, 20) : [],
    unpushedCount: known ? (answer.unpushedCount as number) : -1,
    unpushedKnown: known,
    ...(answer.sessions !== undefined ? { sessions: (Array.isArray(answer.sessions) ? answer.sessions : [null]).map((item) => marks("git", item)) } : {}),
  }
}

/** A machine with no record: every work checkout, every root session and the installed OpenCode. */
export function readDescribe(answer: Json): DescribeAnswer {
  if (!Array.isArray(answer.works) || !Array.isArray(answer.sessions)) throw shape("describe")
  const works = answer.works.map((raw) => {
    const item = raw as Json
    const directory = item?.directory
    const remote = item?.remote
    const branch = item?.branch
    const head = item?.head
    const dirty = item?.dirty
    const untracked = item?.untracked
    const unpushed = item?.unpushed
    const unpushedKnown = item?.unpushedKnown
    if (!string(directory) || !WORK_DIRECTORY.test(directory)) throw shape("describe")
    if (remote !== null && !string(remote)) throw shape("describe")
    if (branch !== null && !string(branch)) throw shape("describe")
    if (head !== null && (!string(head) || !/^[0-9a-f]{40,64}$/.test(head))) throw shape("describe")
    if (typeof dirty !== "boolean" || !count(untracked) || typeof unpushedKnown !== "boolean") throw shape("describe")
    if (unpushedKnown ? !count(unpushed) : unpushed !== -1) throw shape("describe")
    return {
      directory,
      remote: remote === null ? null : withoutUserinfo(remote),
      branch,
      head,
      dirty,
      untracked,
      unpushed: unpushedKnown ? (unpushed as number) : -1,
      unpushedKnown,
    }
  })
  const sessions = answer.sessions.map((raw) => {
    const item = raw as Json
    const id = item?.id
    const directory = item?.directory
    const busy = item?.busy
    const needsInput = pendingInput(item?.needsInput)
    if (!string(id) || !SESSION.test(id) || !string(directory) || !ABSOLUTE_PATH.test(directory) || directory.split("/").includes("..") || typeof busy !== "boolean") throw shape("describe")
    if (needsInput === undefined) throw shape("describe")
    return { id, directory, busy, needsInput }
  })
  return { opencode: version(answer.opencode), works, sessions }
}

export function readScrub(answer: Json): ScrubAnswer {
  if (!Array.isArray(answer.removed) || !answer.removed.every(string)) throw shape("scrub")
  const refused = answer.refused === "has-slot" || answer.refused === "has-session" || answer.refused === "has-credential" ? answer.refused : undefined
  if (answer.refused !== undefined && !refused) throw shape("scrub")
  return { removed: answer.removed, ...(refused ? { refused } : {}) }
}

export function readRelease(answer: Json): ReleaseAnswer {
  if (!string(answer.slot) || !/^[a-z][a-z0-9-]{0,24}$/.test(answer.slot) || !Array.isArray(answer.removed) || !answer.removed.every(string)) throw shape("release")
  return { slot: answer.slot, removed: answer.removed }
}

export function readLegacy(answer: Json): LegacyAnswer {
  const password = answer.password
  if (typeof answer.legacy !== "boolean" || typeof answer.fenced !== "boolean" || (password !== "adopted" && password !== "kept" && password !== "none")) throw shape("legacy")
  return { legacy: answer.legacy, password, fenced: answer.fenced }
}

export function readUpgrade(answer: Json): { readonly opencode: string } {
  const opencode = version(answer.opencode)
  if (!opencode) throw shape("upgrade")
  return { opencode }
}

export function readImport(answer: Json): { readonly rootId: string } {
  if (!string(answer.rootId) || !SESSION.test(answer.rootId)) throw shape("import")
  return { rootId: answer.rootId }
}
