import { boxdError, BoxdError } from "./errors.js"
import { copyFromGuestArgs, copyToGuestArgs, execArgs, guestRequest } from "./argv.js"
import type { GuestPort } from "./ports.js"
import { readGuestHelper } from "./cli-boxd.js"
import { duration, run, runBuffer } from "./run.js"
import { errorLine, mapOutcome } from "./outcome.js"
import { shortReason } from "./redact.js"

const HELPER = "/tmp/opencode-boxd/guest.py"

/** The guest port over the boxd CLI. `timeoutMs` bounds one helper call on the machine. */
export function cliGuest(bin = "boxd", timeoutMs = 30_000): GuestPort {
  const uploaded = new Set<string>()

  async function call(machine: string, action: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await ensureHelper(bin, machine, uploaded)
    const result = await run(bin, execArgs(machine), { stdin: guestRequest(action, fields), timeoutMs }).catch((error: unknown) => {
      // Name the step that timed out: the guest's own action, on its machine.
      if (error instanceof BoxdError && error.code === "TIMEOUT") {
        throw boxdError("TIMEOUT", `The guest's ${action} on ${machine} did not answer within ${duration(timeoutMs)}.`)
      }
      throw error
    })
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
      await call(machine, "prompt", { sessionID, text })
    },
    phase: async (machine, sessionID) => {
      const parsed = await call(machine, "phase", { sessionID })
      const phase = parsed.phase === "busy" || parsed.phase === "idle" || parsed.phase === "missing" ? parsed.phase : "missing"
      const outcome = mapOutcome(parsed.outcome)
      const error = errorLine(parsed.error)
      return { phase, run: { outcome, ...(error ? { error } : {}) } }
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

/** The file's folders must exist before `machine cp` writes into them. */
async function mkdirOnGuest(bin: string, machine: string, remote: string): Promise<void> {
  const folder = remote.slice(0, remote.lastIndexOf("/")) || "/"
  const result = await run(bin, ["machine", "exec", machine, "--", "mkdir", "-p", folder])
  if (result.code !== 0) throw boxdError("GUEST_FAILED", `The guest could not create ${folder} (${result.stderr.trim().slice(0, 200)}).`)
}

async function ensureHelper(bin: string, machine: string, uploaded: Set<string>): Promise<void> {
  if (uploaded.has(machine)) return
  const helper = await readGuestHelper()
  const mkdir = await run(bin, ["machine", "exec", machine, "--", "mkdir", "-p", "/tmp/opencode-boxd"])
  if (mkdir.code !== 0) throw boxdError("GUEST_FAILED", "The guest work directory could not be created.")
  const copied = await run(bin, copyToGuestArgs(machine, HELPER), { stdin: helper, timeoutMs: 30_000 })
  if (copied.code !== 0) throw boxdError("GUEST_FAILED", "The guest helper could not be copied to the machine.")
  uploaded.add(machine)
}

function parseLine(stdout: string, stderr: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n")
  const line = [...lines].reverse().find((item) => item.startsWith("{"))
  if (!line) {
    // The last line the machine wrote to stderr, such as a traceback's error, says why.
    const last = stderr.trim().split("\n").at(-1) ?? ""
    const reason = shortReason(last)
    throw boxdError("GUEST_FAILED", `The guest helper did not return JSON${reason ? ` (${reason})` : ""}.`)
  }
  return JSON.parse(line) as Record<string, unknown>
}

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
