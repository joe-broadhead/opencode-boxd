import { spawn } from "node:child_process"
import { BoxdError } from "./errors.js"

export type RunResult = { code: number; stdout: string; stderr: string }

export function run(bin: string, args: string[], options?: { stdin?: string; timeoutMs?: number }): Promise<RunResult> {
  const timeoutMs = options?.timeoutMs ?? 20_000
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new BoxdError("TIMEOUT", `${bin} ${args[0] ?? ""} timed out after ${timeoutMs}ms.`, "Call boxd_status. Do not retry inside this call."))
    }, timeoutMs)
    child.stdout.on("data", (chunk) => stdout.push(chunk))
    child.stderr.on("data", (chunk) => stderr.push(chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(new BoxdError("BOXD_MISSING", error.message, "Install the boxd CLI and sign in."))
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") })
    })
    if (options?.stdin !== undefined) child.stdin.end(options.stdin)
    else child.stdin.end()
  })
}

export function parseJson(text: string): unknown {
  const start = text.indexOf("{")
  const list = text.indexOf("[")
  const cut = start === -1 ? list : list === -1 ? start : Math.min(start, list)
  if (cut === -1) throw new BoxdError("BOXD_OUTPUT", "boxd did not return JSON.", "Run the same boxd command with --json and read stderr.")
  return JSON.parse(text.slice(cut))
}
