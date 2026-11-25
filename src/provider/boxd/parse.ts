/**
 * The laptop CLI's `--json` answers, read into the port's shapes. Each reader keeps to the keys it needs and refuses
 * an answer it cannot trust with `BOXD_FAILED`, rather than guessing: a listing row without a region, a `get` or a
 * create without an id. `docs/architecture.md` records the shapes the live check measured.
 */
import { boxdError } from "../../errors.js"
import {
  REGIONS,
  SIZE_VCPU,
  SIZES,
  type MachineId,
  type MachineInfo,
  type MachineRow,
  type MachineStatus,
  type Rates,
  type Region,
  type RegionLimit,
  type SecretInfo,
  type Size,
  type SnapshotRow,
  type Usage,
} from "../../ports.js"

type Json = Record<string, unknown>

const record = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {})
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined)
const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : undefined)

/** The first JSON value in a CLI's stdout: the update banner and other chatter can come before it. */
export function parseJson(stdout: string, command: string): unknown {
  const starts = [stdout.indexOf("{"), stdout.indexOf("[")].filter((index) => index !== -1)
  if (starts.length === 0) throw boxdError("BOXD_FAILED", `${command} did not answer JSON.`)
  try {
    return JSON.parse(stdout.slice(Math.min(...starts)))
  } catch {
    throw boxdError("BOXD_FAILED", `${command} answered JSON that could not be read.`)
  }
}

/** A list answer: a bare array, or the array under one of these keys. */
function rows(value: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(value)) return value
  const object = record(value)
  for (const key of keys) if (Array.isArray(object[key])) return object[key] as unknown[]
  return []
}

export function regionOf(value: unknown): Region | undefined {
  return typeof value === "string" && (REGIONS as readonly string[]).includes(value) ? (value as Region) : undefined
}

/** boxd's lifecycle words; a transition in flight reads as where it is going, so a read never runs on it. */
export function statusOf(value: unknown): MachineStatus {
  switch (value) {
    case "running":
    case "starting":
    case "standby":
    case "hibernated":
    case "stopped":
    case "destroyed":
      return value
    case "suspended":
    case "paused":
      return "standby"
    case "hibernating":
      return "hibernated"
    case "waking":
    case "rebooting":
    case "resizing":
      return "starting"
    default:
      return "other"
  }
}

/** The size from `vcpu` (and `memory_bytes`), or from a size line such as `2 vCPU · 8 GiB`. */
export function sizeOf(item: Json): Size | null {
  const vcpu = number(item.vcpu) ?? (typeof item.size === "string" ? number(/^(\d{1,2}) vCPU\b/.exec(item.size)?.[1]) : undefined)
  return SIZES.find((size) => SIZE_VCPU[size] === vcpu) ?? null
}

/** Labels as an object (`{"role":"session"}`), a list of `key=value`, or one comma-separated string. */
export function labelsOf(value: unknown): Readonly<Record<string, string>> {
  const pairs = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined
  if (pairs) {
    const labels: Record<string, string> = {}
    for (const pair of pairs) {
      if (typeof pair !== "string") continue
      const at = pair.indexOf("=")
      if (at > 0) labels[pair.slice(0, at).trim()] = pair.slice(at + 1).trim()
    }
    return labels
  }
  return Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

const sharingOf = (value: unknown): MachineRow["sharing"] => (value === "private" || value === "shared" ? value : "unknown")
const isolatedOf = (value: unknown): boolean | null => (value === true || value === "yes" || value === "true" ? true : value === false || value === "no" || value === "false" ? false : null)
const idOf = (value: unknown): MachineId | null => (typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value) ? (value as MachineId) : null)

/** `machine list --region all --json`: every row must say its region, or nothing in the listing can be trusted (H2). */
export function parseListing(value: unknown): MachineRow[] {
  return rows(value, "machines", "items").map((raw) => {
    const item = record(raw)
    const name = text(item.name)
    const region = regionOf(item.region)
    if (!name || !region) throw boxdError("BOXD_FAILED", "machine list --region all answered a machine without a name or a known region.")
    return {
      name,
      region,
      id: idOf(item.id),
      status: statusOf(item.status),
      size: sizeOf(item),
      labels: labelsOf(item.labels),
      sharing: sharingOf(item.sharing),
      isolated: isolatedOf(item.isolated),
    }
  })
}

/** `machine get --json`, in the region that was asked: it always carries the machine's id. */
export function parseMachine(value: unknown, region: Region, command: string): MachineInfo {
  const item = record(value)
  const name = text(item.name)
  const id = idOf(item.id)
  if (!name || !id) throw boxdError("BOXD_FAILED", `${command} answered a machine without a name or an id.`)
  return {
    name,
    id,
    region: regionOf(item.region) ?? region,
    status: statusOf(item.status),
    size: sizeOf(item),
    labels: labelsOf(item.labels),
    sharing: sharingOf(item.sharing),
    isolated: isolatedOf(item.isolated) ?? false,
  }
}

/** `machine new --json`: the id and name only (`{boot, id, name, paused_automations, source, url}`). */
export function parseCreated(value: unknown, command: string): { readonly id: MachineId; readonly name: string } {
  const item = record(value)
  const id = idOf(item.id)
  const name = text(item.name)
  if (!id || !name) throw boxdError("BOXD_FAILED", `${command} answered no machine id, so the machine cannot be acted on by id.`)
  return { id, name }
}

/**
 * `manage machine-limit --json`. Per region when the answer has `regions`. Otherwise the org's limit, which the CLI
 * says each region applies to its own machines ("up to N in every region"): the caller counts each region's machines
 * from a listing (`regionLimits`), because an org-wide count would understate every region's room. Both shapes are
 * provisional until live check L3.
 */
export function parseMachineLimit(value: unknown): { readonly perRegion: RegionLimit[] } | { readonly limit: number } {
  const item = record(value)
  const limitOf = (entry: Json) => number(entry.limit ?? entry.max_vms ?? entry.maxVms ?? entry.machine_limit)
  const inUseOf = (entry: Json) => number(entry.in_use ?? entry.inUse ?? entry.machines ?? entry.count ?? entry.used)
  const perRegion = rows(item.regions)
    .map(record)
    .flatMap((entry) => {
      const region = regionOf(entry.region)
      const limit = limitOf(entry)
      const inUse = inUseOf(entry)
      return region && limit !== undefined && inUse !== undefined ? [{ region, limit, inUse, free: Math.max(0, limit - inUse) }] : []
    })
  if (perRegion.length > 0) return { perRegion }
  const limit = limitOf(item)
  if (limit === undefined) throw boxdError("BOXD_FAILED", "manage machine-limit answered no limit.")
  return { limit }
}

/** One limit applied in every region, with each region's own machines counted from a listing. */
export function regionLimits(limit: number, machines: readonly MachineRow[]): RegionLimit[] {
  return REGIONS.map((region) => {
    const inUse = machines.filter((machine) => machine.region === region && machine.status !== "destroyed").length
    return { region, limit, inUse, free: Math.max(0, limit - inUse) }
  })
}

const MICRO = 1_000_000

/**
 * `manage usage --json`: cost per machine and the org's rates, in micro-units of its billing currency. Owners and
 * admins only; the caller turns that refusal into `available: false`.
 */
export function parseUsage(value: unknown, asOf: string): Usage {
  const item = record(value)
  const currency = text(item.currency)?.toUpperCase() ?? "EUR"
  const rateCard = record(item.rates ?? item.rate_card)
  const rate = (...keys: string[]) => {
    for (const key of keys) {
      const micro = number(rateCard[`${key}_micro`])
      if (micro !== undefined) return micro / MICRO
      const plain = number(rateCard[key])
      if (plain !== undefined) return plain
    }
    return undefined
  }
  const vcpuHour = rate("vcpu_hour")
  const ramGiBHour = rate("ram_gib_hour")
  const diskGiBHour = rate("disk_gib_hour")
  if (vcpuHour === undefined || ramGiBHour === undefined || diskGiBHour === undefined) throw boxdError("BOXD_FAILED", "manage usage answered no rate card.")
  const rates: Rates = { currency, vcpuHour, ramGiBHour, diskGiBHour, source: "usage" }
  const machines = rows(item, "machines", "items").flatMap((raw) => {
    const entry = record(raw)
    const machineId = idOf(entry.id ?? entry.machine_id ?? entry.vm_id)
    const micro = number(entry.cost_micro)
    const cost = micro !== undefined ? micro / MICRO : number(entry.cost)
    return machineId && cost !== undefined ? [{ machineId, cost }] : []
  })
  const totalMicro = number(item.total_cost_micro ?? item.cost_micro)
  const total = totalMicro !== undefined ? totalMicro / MICRO : (number(item.total) ?? machines.reduce((sum, machine) => sum + machine.cost, 0))
  return {
    available: true,
    currency,
    total,
    estimated: item.estimated !== false,
    complete: item.complete === true,
    asOf,
    rates,
    machines,
  }
}

const STORAGE = new Set(["local", "archiving", "archived", "unarchiving"])

/** `snapshots list --region all --json`: a row without a known region is left out, never guessed. */
export function parseSnapshots(value: unknown): SnapshotRow[] {
  return rows(value, "snapshots", "items").flatMap((raw) => {
    const item = record(raw)
    const name = text(item.name)
    const region = regionOf(item.region)
    if (!name || !region) return []
    const storage = typeof item.storage === "string" && STORAGE.has(item.storage) ? (item.storage as SnapshotRow["storage"]) : "other"
    return [{ region, name, storage, status: text(item.status) ?? "unknown" }]
  })
}

/**
 * The sealed variables in `env list --json` (`{env: [...], secret: [{name, scope, domains}]}`). Plain variables carry
 * their values, so they are not read at all; a secret has no value in the answer.
 */
export function parseSecrets(value: unknown): SecretInfo[] {
  return rows(record(value).secret ?? record(value).secrets).flatMap((raw) => {
    const item = record(raw)
    const name = typeof item.name === "string" ? item.name : ""
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) return []
    const hosts = Array.isArray(item.domains) ? item.domains.filter((host): host is string => typeof host === "string" && /^[A-Za-z0-9.*-]{1,253}$/.test(host)) : []
    return [{ name, scope: typeof item.scope === "string" && /^[a-z0-9-]{1,32}$/.test(item.scope) ? item.scope : "unknown", hosts }]
  })
}
