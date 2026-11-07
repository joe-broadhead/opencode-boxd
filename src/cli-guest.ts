import { BoxdError } from "./errors.js"
import { copyToGuestArgs, execArgs, guestRequest } from "./argv.js"
import type { GitState, GuestPort } from "./ports.js"
import { readHelper } from "./cli-boxd.js"
import { run } from "./run.js"

const HELPER = "/tmp/opencode-boxd/guest.py"

export function cliGuest(bin = "boxd"): GuestPort {
  const uploaded = new Set<string>()

  async function call(machine: string, action: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await ensureHelper(bin, machine, uploaded)
    const result = await run(bin, execArgs(machine), { stdin: guestRequest(action, fields), timeoutMs: 30_000 })
    const parsed = parseLine(result.stdout)
    if (result.code !== 0 || parsed.ok === false) {
      throw new BoxdError("GUEST_FAILED", `Guest ${action} failed.`, String(parsed.error ?? result.stderr).slice(0, 400))
    }
    return parsed
  }

  return {
    version: async (machine) => {
      const result = await run(bin, ["machine", "exec", machine, "--", "opencode", "--version"])
      if (result.code !== 0) throw new BoxdError("GUEST_VERSION", "Could not read OpenCode's version on the machine.", result.stderr.slice(0, 200))
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
      if (parsed.phase === "busy" || parsed.phase === "idle" || parsed.phase === "missing") return parsed.phase
      return "missing"
    },
    exportSession: async (machine, sessionID) => {
      const parsed = await call(machine, "export", { sessionID })
      return parsed.export
    },
    importSession: async (machine, transfer, directory) => {
      const parsed = await call(machine, "import", { transfer, directory })
      return { id: String(parsed.id) }
    },
    git: async (machine, directory) => {
      const parsed = await call(machine, "git", { directory })
      return {
        remote: stringOrNull(parsed.remote),
        branch: stringOrNull(parsed.branch),
        sha: stringOrNull(parsed.sha),
        dirty: parsed.dirty === true,
        patch: typeof parsed.patch === "string" ? parsed.patch : undefined,
      } satisfies GitState
    },
  }
}

async function ensureHelper(bin: string, machine: string, uploaded: Set<string>): Promise<void> {
  if (uploaded.has(machine)) return
  const helper = await readHelper()
  const mkdir = await run(bin, ["machine", "exec", machine, "--", "mkdir", "-p", "/tmp/opencode-boxd"])
  if (mkdir.code !== 0) throw new BoxdError("GUEST_FAILED", "Could not prepare /tmp/opencode-boxd on the machine.", mkdir.stderr.slice(0, 200))
  const copied = await run(bin, copyToGuestArgs(machine, HELPER), { stdin: helper, timeoutMs: 30_000 })
  if (copied.code !== 0) throw new BoxdError("GUEST_FAILED", "Could not copy the guest helper.", copied.stderr.slice(0, 200))
  uploaded.add(machine)
}

function parseLine(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n")
  const line = [...lines].reverse().find((item) => item.startsWith("{"))
  if (!line) throw new BoxdError("GUEST_FAILED", "The guest helper did not return JSON.", stdout.slice(0, 200))
  return JSON.parse(line) as Record<string, unknown>
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}
