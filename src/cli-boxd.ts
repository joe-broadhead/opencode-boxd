import { readFile } from "node:fs/promises"
import { boxdError } from "./errors.js"
import {
  allowSleepArgs,
  createArgs,
  getArgs,
  hibernateArgs,
  holdAwakeArgs,
  listArgs,
  listSnapshotArgs,
  outboundArgs,
  removeArgs,
  saveSnapshotArgs,
  wakeArgs,
} from "./argv.js"
import type { BoxdPort, MachineInfo, MachineStatus } from "./ports.js"
import { assertLaptopCli } from "./cli-flavor.js"
import { parseJson, run } from "./run.js"

export function cliBoxd(bin = "boxd"): BoxdPort {
  return guarded(bin, {
    get: (name) => get(bin, name),
    list: async () => {
      const result = await run(bin, listArgs())
      if (result.code !== 0) fail("list", result.stderr)
      const parsed = parseJson(result.stdout)
      if (!Array.isArray(parsed)) return []
      return parsed.map((item) => parseMachine(item, String(asRecord(item).name ?? "")))
    },
    create: async (input) => {
      const result = await run(bin, createArgs(input.workId, input.snapshot), { timeoutMs: 30_000 })
      if (result.code !== 0) fail("create", result.stderr)
      // `machine new --json` answers with boot, id, name, source and url only: no status, sharing or isolation. Read the
      // machine back, so a create that landed shared or isolated is refused before anything runs on it.
      const created = asRecord(parseJson(result.stdout))
      const name = String(created.name ?? input.name)
      try {
        return await get(bin, name)
      } catch {
        // The machine exists even though the read failed. Report it as starting, so the ledger records it instead of
        // leaving a billing machine unowned; the next status or ensure reads it again.
        return { name, status: "starting", sharing: "unknown", isolated: false, ...(typeof created.source === "string" ? { source: created.source } : {}) }
      }
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
    holdAwake: async (name) => {
      await ok(bin, holdAwakeArgs(name))
      await ok(bin, outboundArgs(name, "off"))
    },
    allowSleep: async (name) => {
      await ok(bin, allowSleepArgs(name))
      await ok(bin, outboundArgs(name, "on"))
    },
  })
}

/** Every call first checks that the CLI is the laptop's: the in-VM CLI's commands differ, and would fail one by one. */
function guarded(bin: string, port: BoxdPort): BoxdPort {
  const entries = Object.entries(port).map(([name, method]) => [
    name,
    async (...args: unknown[]) => {
      await assertLaptopCli(bin)
      return (method as (...input: unknown[]) => unknown)(...args)
    },
  ])
  return Object.fromEntries(entries) as BoxdPort
}

async function get(bin: string, name: string): Promise<MachineInfo> {
  const result = await run(bin, getArgs(name))
  if (result.code !== 0) {
    if (isMissing(result.stderr)) return missing(name)
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
    // `machine get --json` prints isolation as the string "yes" or "no"; a fake may print a boolean.
    isolated: record.isolated === true || record.isolated === "yes" || record.isolated === "true",
    source: typeof record.source === "string" ? record.source : undefined,
  }
}

function missing(name: string): MachineInfo {
  return { name, status: "missing", sharing: "unknown", isolated: false }
}

/** The CLI's own words for a machine that is not there: 0.2 said `VM '<name>' not found`, 0.3 says `no machine "<name>" in <region>`. */
export function isMissing(stderr: string): boolean {
  return /not found|no such|no machine|unknown|does not exist/i.test(stderr)
}

function normalize(value: string): MachineStatus {
  if (value === "suspended") return "standby"
  if (value === "hibernating" || value === "rebooting") return "starting"
  if (
    value === "running" ||
    value === "starting" ||
    value === "standby" ||
    value === "hibernated" ||
    value === "stopped" ||
    value === "destroyed" ||
    value === "missing"
  ) {
    return value
  }
  return "other"
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function fail(action: string, detail: string): never {
  throw boxdError("BOXD_FAILED", `boxd ${action} failed (${detail.trim().slice(0, 300) || "no output"}).`)
}

export async function readGuestHelper(): Promise<string> {
  return readFile(new URL("../guest/guest.py", import.meta.url), "utf8")
}
