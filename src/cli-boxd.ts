import { readFile } from "node:fs/promises"
import { BoxdError } from "./errors.js"
import {
  allowSleepArgs,
  createArgs,
  getArgs,
  hibernateArgs,
  holdAwakeArgs,
  listSnapshotArgs,
  removeArgs,
  saveSnapshotArgs,
  wakeArgs,
} from "./argv.js"
import type { BoxdPort, MachineInfo, MachineStatus } from "./ports.js"
import { parseJson, run } from "./run.js"

export function cliBoxd(bin = "boxd"): BoxdPort {
  return {
    get: (name) => get(bin, name),
    create: async (input) => {
      const result = await run(bin, createArgs(input.workId, input.snapshot), { timeoutMs: 30_000 })
      if (result.code !== 0) fail("create", result.stderr)
      return parseMachine(parseJson(result.stdout), input.name)
    },
    hibernate: (name) => ok(bin, hibernateArgs(name)),
    wake: (name) => ok(bin, wakeArgs(name)),
    remove: (name) => ok(bin, removeArgs(name)),
    saveSnapshot: (machine, snapshot) => ok(bin, saveSnapshotArgs(machine, snapshot), 60_000),
    listSnapshots: async () => {
      const result = await run(bin, listSnapshotArgs())
      if (result.code !== 0) fail("snapshots", result.stderr)
      const parsed = parseJson(result.stdout)
      if (!Array.isArray(parsed)) return []
      return parsed.map((item) => {
        const record = asRecord(item)
        return { name: String(record.name ?? ""), storage: String(record.storage ?? ""), status: String(record.status ?? "") }
      })
    },
    holdAwake: (name) => ok(bin, holdAwakeArgs(name)),
    allowSleep: (name) => ok(bin, allowSleepArgs(name)),
  }
}

async function get(bin: string, name: string): Promise<MachineInfo> {
  const result = await run(bin, getArgs(name))
  if (result.code !== 0) {
    if (/not found|unknown|no such/i.test(result.stderr)) return missing(name)
    fail("get", result.stderr)
  }
  return parseMachine(parseJson(result.stdout), name)
}

async function ok(bin: string, args: string[], timeoutMs?: number): Promise<void> {
  const result = await run(bin, args, { timeoutMs })
  if (result.code !== 0) fail(args[0] ?? "boxd", result.stderr || result.stdout)
}

export function parseMachine(raw: unknown, fallbackName: string): MachineInfo {
  const record = asRecord(raw)
  const boot = String(record.boot ?? "")
  const status = normalize(String(record.status ?? (boot === "starting" ? "starting" : boot || "starting")))
  const sharing = record.sharing === "shared" ? "shared" : record.sharing === "private" ? "private" : "unknown"
  return {
    name: String(record.name ?? fallbackName),
    status,
    sharing,
    isolated: record.isolated === true,
    source: typeof record.source === "string" ? record.source : undefined,
  }
}

function missing(name: string): MachineInfo {
  return { name, status: "missing", sharing: "unknown", isolated: false }
}

function normalize(value: string): MachineStatus {
  if (value === "suspended") return "standby"
  if (value === "hibernating" || value === "rebooting") return "starting"
  if (value === "running" || value === "starting" || value === "standby" || value === "hibernated" || value === "stopped" || value === "destroyed" || value === "missing") {
    return value
  }
  return "other"
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function fail(action: string, detail: string): never {
  throw new BoxdError("BOXD_FAILED", `boxd ${action} failed.`, detail.trim().slice(0, 400) || "Read the boxd stderr.")
}

export async function readHelper(): Promise<string> {
  return readFile(new URL("../guest/guest.py", import.meta.url), "utf8")
}
