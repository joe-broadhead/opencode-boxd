import { basename } from "node:path"
import { boxdError, BoxdError } from "./errors.js"
import { copyFromGuestArgs, copyToGuestArgs, execArgs, guestRequest } from "./argv.js"
import type { GuestActivity, GuestPort } from "./ports.js"
import { readGuestHelper } from "./cli-boxd.js"
import { duration, run, runBuffer } from "./run.js"
import { errorLine, mapOutcome } from "./outcome.js"
import { excerpt, shortReason } from "./redact.js"

const HELPER_DIRECTORY = "/tmp/opencode-boxd"
const HELPER = `${HELPER_DIRECTORY}/guest.py`
/** How long the probe after a timeout may take: it reads /proc, so a machine that answers at all answers this fast. */
const PROBE_MS = 10_000

/** The guest port over the boxd CLI. `timeoutMs` bounds one helper call on the machine. */
export function cliGuest(bin = "boxd", timeoutMs = 30_000): GuestPort {
  const uploaded = new Set<string>()

  async function call(machine: string, action: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await ensureHelper(bin, machine, uploaded)
    const request = guestRequest(action, fields)
    const exec = () =>
      run(bin, execArgs(machine), { stdin: request, timeoutMs }).catch(async (error: unknown) => {
        if (!(error instanceof BoxdError) || error.code !== "TIMEOUT") throw error
        // One cheap probe says whether waiting a turn can help: a guest out of memory never answers by itself.
        const health = await probe(bin, machine, Math.min(PROBE_MS, timeoutMs))
        // No answer to the probe either: name the step that timed out, the guest's own action on its machine.
        if (!health) throw boxdError("TIMEOUT", `The guest's ${action} on ${machine} did not answer within ${duration(timeoutMs)}.`)
        const facts = healthText(health)
        const late = `The guest's ${action} on ${machine} did not answer in time`
        if (strained(health)) throw boxdError("GUEST_UNRESPONSIVE", `${late}, but the machine did: ${facts}.`)
        if (health.server !== "listening") throw boxdError("GUEST_SERVER_DOWN", `${late}, and nothing listens on its OpenCode port: ${facts}.`)
        throw boxdError("TIMEOUT", `${late}. The machine answered a probe and looks well: ${facts}.`)
      })
    let result = await exec()
    // A reboot clears /tmp: a resize, a restart or a rebuild outside the plugin leaves a machine without the helper.
    // Python never started the action when its folder is gone, so copying the helper again and running once more cannot
    // run anything twice. Any other answer, such as a crash or a boxd CLI that failed, keeps this call's own error.
    if (!jsonLine(result.stdout) && (await helperFolderGone(bin, machine))) {
      uploaded.delete(machine)
      await ensureHelper(bin, machine, uploaded)
      result = await exec()
    }
    const parsed = parseLine(result.stdout, result.stderr)
    if (result.code !== 0 || parsed.ok === false) {
      // The helper's error word and its detail, such as the guest server's own answer, redacted and cut to one line.
      const reason = [parsed.error, parsed.detail].filter((part): part is string => typeof part === "string" && part !== "").join(": ") || result.stderr
      throw boxdError("GUEST_FAILED", `The guest ${action} failed (${shortReason(reason) ?? "no reason given"}).`)
    }
    return parsed
  }

  return {
    forget: (machine) => void uploaded.delete(machine),
    version: async (machine) => {
      const result = await run(bin, ["machine", "exec", machine, "--", "opencode", "--version"])
      if (result.code !== 0) throw boxdError("GUEST_VERSION", "The machine's OpenCode version could not be read.")
      return result.stdout.trim()
    },
    server: async (machine) => {
      const parsed = await call(machine, "serve")
      return parsed.server === "up" ? "up" : "starting"
    },
    prepare: async (machine, directory, repo) => {
      await call(machine, "prepare", { directory, repo })
    },
    listSessions: async (machine) => {
      const parsed = await call(machine, "list")
      const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : []
      return sessions.map((item) => {
        const record = item as { id?: string; parentID?: string }
        return { id: String(record.id), parentID: record.parentID ? String(record.parentID) : undefined }
      })
    },
    createSession: async (machine, directory, title) => {
      const parsed = await call(machine, "create", { directory, title })
      return { id: String(parsed.id) }
    },
    prompt: async (machine, sessionID, text) => {
      const parsed = await call(machine, "prompt", { sessionID, text })
      return { queued: parsed.queued === true }
    },
    phase: async (machine, sessionID) => {
      const parsed = await call(machine, "phase", { sessionID })
      const phase = parsed.phase === "busy" || parsed.phase === "idle" || parsed.phase === "missing" ? parsed.phase : "missing"
      const outcome = mapOutcome(parsed.outcome)
      const error = errorLine(parsed.error)
      return { phase, run: { outcome, ...(error ? { error } : {}) }, activity: activityOf(parsed) }
    },
    exportSession: async (machine, sessionID) => {
      const parsed = await call(machine, "export", { sessionID })
      return parsed.export
    },
    importSession: async (machine, transfer, directory) => {
      const parsed = await call(machine, "import", { transfer, directory })
      return { id: String(parsed.id) }
    },
    upload: async (machine, directory, path, body) => {
      await mkdirOnGuest(bin, machine, `${directory}/${path}`)
      const remote = `${directory}/${path}`
      const result = await runBuffer(bin, copyToGuestArgs(machine, remote), { stdin: body, timeoutMs: 60_000 })
      if (result.code !== 0) throw boxdError("GUEST_FAILED", `The guest refused the upload of ${path} (${result.stderr.trim().slice(0, 200)}).`)
    },
    download: async (machine, directory, path) => {
      const result = await runBuffer(bin, copyFromGuestArgs(machine, `${directory}/${path}`), { timeoutMs: 60_000 })
      if (result.code !== 0) throw boxdError("GUEST_FAILED", `The guest refused the download of ${path} (${result.stderr.trim().slice(0, 200)}).`)
      return result.stdout
    },
    digest: async (machine, directory, paths) => {
      const parsed = await call(machine, "digest", { directory, paths })
      const digests = parsed.digests && typeof parsed.digests === "object" ? (parsed.digests as Record<string, unknown>) : {}
      return Object.fromEntries(Object.entries(digests).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    },
    git: async (machine, directory) => {
      const parsed = await call(machine, "git", { directory })
      return {
        known: parsed.known === true,
        remote: stringOrNull(parsed.remote),
        branch: stringOrNull(parsed.branch),
        sha: stringOrNull(parsed.sha),
        dirty: parsed.dirty === true,
        ...(typeof parsed.patch === "string" ? { patch: parsed.patch } : {}),
        untracked: strings(parsed.untracked),
        ignored: strings(parsed.ignored),
        untrackedFiles: files(parsed.untrackedFiles),
      }
    },
  }
}

/**
 * What the machine says about itself when the helper's call hung: free memory, load, the three largest processes and
 * whether the server's port is open. Undefined when the probe does not answer either, so the caller keeps the plain
 * timeout: then nothing is known about the guest.
 */
async function probe(bin: string, machine: string, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
  const result = await run(bin, execArgs(machine), { stdin: guestRequest("health", {}), timeoutMs }).catch(() => undefined)
  if (!result || result.code !== 0) return undefined
  const line = jsonLine(result.stdout)
  // A line that is not JSON is no answer: the caller keeps its coded timeout.
  const parsed = line ? parseObject(line) : undefined
  return parsed?.ok === true ? parsed : undefined
}

function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

/**
 * A machine that cannot answer by itself: under a tenth of its memory available, or a load over four per CPU. It comes
 * before a closed server port, which a guest out of memory also shows.
 */
function strained(health: Record<string, unknown>): boolean {
  const total = number(health.memTotalMiB)
  const available = number(health.memAvailableMiB)
  const load = number(health.load1)
  const cpus = number(health.cpus) ?? 1
  return (total !== undefined && available !== undefined && available < total / 10) || (load !== undefined && load > 4 * cpus)
}

const mib = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)} MiB` : "unknown")
/** A process name from the guest, as plain characters: it is untrusted text. */
const processName = (value: unknown) => (typeof value === "string" ? value.replace(/[^\w.+:/-]/g, "").slice(0, 32) : "") || "?"

function healthText(health: Record<string, unknown>): string {
  const memory = `${mib(health.memAvailableMiB)} of ${mib(health.memTotalMiB)} memory available`
  const load = typeof health.load1 === "number" && Number.isFinite(health.load1) ? `load ${health.load1}` : "load unknown"
  const top = (Array.isArray(health.top) ? health.top : [])
    .slice(0, 3)
    .map((item) => {
      const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {}
      const pid = typeof record.pid === "number" && Number.isInteger(record.pid) ? ` (pid ${record.pid})` : ""
      return `${processName(record.name)}${pid} ${mib(record.rssMiB)}`
    })
  const largest = top.length ? `largest ${top.join(", ")}` : "no process list"
  const server = health.server === "listening" ? "the OpenCode port is open" : "nothing listens on the OpenCode port"
  return `${memory}, ${load}, ${largest}; ${server}`
}

/** The file's folders must exist before `machine cp` writes into them. */
async function mkdirOnGuest(bin: string, machine: string, remote: string): Promise<void> {
  const folder = remote.slice(0, remote.lastIndexOf("/")) || "/"
  const result = await run(bin, ["machine", "exec", machine, "--", "mkdir", "-p", folder])
  if (result.code !== 0) throw boxdError("GUEST_FAILED", `The guest could not create ${folder} (${result.stderr.trim().slice(0, 200)}).`)
}

async function ensureHelper(bin: string, machine: string, uploaded: Set<string>): Promise<void> {
  if (uploaded.has(machine)) return
  const helper = await readGuestHelper()
  const mkdir = await run(bin, ["machine", "exec", machine, "--", "mkdir", "-p", HELPER_DIRECTORY])
  if (mkdir.code !== 0) throw boxdError("GUEST_FAILED", "The guest work directory could not be created.")
  const copied = await run(bin, copyToGuestArgs(machine, HELPER), { stdin: helper, timeoutMs: 30_000 })
  if (copied.code !== 0) throw boxdError("GUEST_FAILED", "The guest helper could not be copied to the machine.")
  uploaded.add(machine)
}

/**
 * Whether the machine's /tmp clearly lost the helper's folder, as a reboot leaves it: `ls -1a /tmp` answered, listed
 * `.`, and did not list the folder. A command of plain words reads the same whether `machine exec` runs it directly or
 * through a shell. A CLI that failed (auth, network, a 503) is not an answer, and the caller keeps its own error.
 */
async function helperFolderGone(bin: string, machine: string): Promise<boolean> {
  const listing = await run(bin, ["machine", "exec", machine, "--", "ls", "-1a", "/tmp"]).catch(() => undefined)
  if (!listing || listing.code !== 0) return false
  const names = listing.stdout.split("\n").map((name) => name.trim())
  return names.includes(".") && !names.includes(basename(HELPER_DIRECTORY))
}

/** The helper's answer: its last JSON line. */
function jsonLine(stdout: string): string | undefined {
  return stdout
    .trim()
    .split("\n")
    .reverse()
    .find((item) => item.startsWith("{"))
}

function parseLine(stdout: string, stderr: string): Record<string, unknown> {
  const line = jsonLine(stdout)
  if (!line) {
    // The last line the machine wrote to stderr, such as a traceback's error, says why.
    const last = stderr.trim().split("\n").at(-1) ?? ""
    const reason = shortReason(last)
    throw boxdError("GUEST_FAILED", `The guest helper did not return JSON${reason ? ` (${reason})` : ""}.`)
  }
  return JSON.parse(line) as Record<string, unknown>
}

/** The last thing a session said it did, as much as the guest reported: its words are redacted and cut to 300. */
function activityOf(parsed: Record<string, unknown>): GuestActivity {
  const at = typeof parsed.activityAt === "number" && Number.isFinite(parsed.activityAt) && parsed.activityAt > 0 ? new Date(parsed.activityAt) : undefined
  const text = typeof parsed.lastText === "string" ? excerpt(parsed.lastText, LAST_TEXT_LIMIT) : undefined
  const pending = typeof parsed.pending === "number" && Number.isInteger(parsed.pending) && parsed.pending >= 0 ? parsed.pending : undefined
  return {
    ...(at && !Number.isNaN(at.getTime()) ? { lastActivityAt: at.toISOString() } : {}),
    ...(text ? { lastText: text } : {}),
    ...(pending !== undefined ? { pending } : {}),
  }
}

const LAST_TEXT_LIMIT = 300

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/** The untracked files' contents, path to base64: only plain paths leave the guest. */
function files(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const entries = Object.entries(value as Record<string, unknown>).filter(([path, body]) => path.startsWith("/") === false && typeof body === "string")
  return Object.fromEntries(entries) as Record<string, string>
}
