import { spawn } from "node:child_process"
import { boxdError } from "./errors.js"

type RunResult = { code: number; stdout: string; stderr: string }

export function run(bin: string, args: string[], options?: { stdin?: string; timeoutMs?: number }): Promise<RunResult> {
  const timeoutMs = options?.timeoutMs ?? 20_000
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(boxdError("TIMEOUT", `${bin} ${args[0] ?? ""} did not answer within ${timeoutMs} ms.`))
    }, timeoutMs)
    child.stdout.on("data", (chunk) => stdout.push(chunk))
    child.stderr.on("data", (chunk) => stderr.push(chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(boxdError("BOXD_MISSING", `The boxd CLI could not be run (${error.message}).`))
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") })
    })
    if (options?.stdin !== undefined) child.stdin.end(options.stdin)
    else child.stdin.end()
  })
}

/** The same command, returning raw bytes: a guest file is copied back unchanged, never through a text decoder. */
export function runBuffer(bin: string, args: string[], options?: { stdin?: Buffer; timeoutMs?: number }): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(boxdError("TIMEOUT", `${bin} ${args[0] ?? ""} did not answer within ${options?.timeoutMs ?? 60_000} ms.`))
    }, options?.timeoutMs ?? 60_000)
    child.stdout.on("data", (chunk) => stdout.push(chunk))
    child.stderr.on("data", (chunk) => stderr.push(chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(boxdError("BOXD_MISSING", `The boxd CLI could not be run (${error.message}).`))
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") })
    })
    if (options?.stdin) child.stdin.end(options.stdin)
    else child.stdin.end()
  })
}

export function parseJson(text: string): unknown {
  const start = text.indexOf("{")
  const list = text.indexOf("[")
  const cut = start === -1 ? list : list === -1 ? start : Math.min(start, list)
  if (cut === -1) throw boxdError("BOXD_FAILED", "The boxd CLI did not return JSON.")
  return JSON.parse(text.slice(cut))
}
