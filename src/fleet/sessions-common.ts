/**
 * What package C2's runs share (design §3.5–§3.9, §3.12, §4.2): opening a work's record, resolving its machine to the
 * recorded id, checking a `works` input before anything runs (package C1's `src/fleet/list.ts` runs it), and how a
 * stopped call answers. Package C2 owns this
 * file, with `src/fleet/sessions.ts` and `src/fleet/{submit,harvest,sleep,drop,exec,read}.ts`.
 *
 * Lock order, for every change here: the work's ledger lock first (`ledger.update`, which re-enters for the staged
 * commits), then the machine's lock (`runner.withMachineLock({ id })`), then a slot per child. `boxd_exec` is the one
 * change that holds neither across its command (M4).
 */
import { BoxdError, boxdError } from "../errors.js"
import type { WorkRecord, WorkWarning } from "../ledger/types.js"
import {
  LIST_MAX_ITEMS,
  TIMEOUTS,
  type CallTag,
  type ChangeTarget,
  type Listing,
  type MachineId,
  type MachineName,
  type MachineRow,
  type MachineStatus,
  type OpContext,
  type Owned,
  type Region,
} from "../ports.js"
import type { FleetServices } from "../services.js"
import type { CallContext } from "../call.js"
import type { WarningCode } from "../errors.js"

export type Services = FleetServices

const WORK_ID = /^[a-z][a-z0-9-]{0,24}$/

/** Who acts: a tool call, or the automation loop in-process. */
export type Actor = "tool" | "automation"

/** One work's context in a C2 run: the port context, who acts, and the tool call when there is one. */
export interface WorkContext {
  readonly op: OpContext
  readonly by: Actor
  readonly call?: CallContext
}

/** A tool call's port context: its id as the call tag, and its signal. */
export function opOf(tool: `boxd_${string}`, call: CallContext): OpContext {
  const tag: CallTag = { callId: call.id, source: tool }
  return { call: tag, signal: call.signal }
}

export const nowIso = (services: Services) => services.clock.now().toISOString()

export function assertWorkIdInput(value: unknown, field = "workId"): string {
  if (typeof value !== "string" || !WORK_ID.test(value)) {
    throw boxdError("NAME_INVALID", `${field} must be a short lowercase work id: a letter, then up to 24 lowercase letters, digits or hyphens.`, { field })
  }
  return value
}

/** The open record for a work id, or `NOT_OURS`: the ledger has no open work by that id. */
export function openRecord(record: WorkRecord | undefined, workId: string): WorkRecord {
  if (!record || record.state !== "open") {
    throw boxdError("NOT_OURS", `No open work has the id "${workId}"${record ? "; it was closed" : ""}. Nothing was changed.`)
  }
  return record
}

export async function loadOpen(services: Services, workId: string, context: OpContext): Promise<WorkRecord> {
  return openRecord(await services.ledger.get(workId, context), workId)
}

/**
 * The region and id a change acts on. An imported work whose `get` failed at import has no id yet: the first change
 * fills it in from `machine get` (design §6.1 step 4), and the caller writes it. A work found in no region at import
 * acts only through `boxd_resume` or `boxd_drop`.
 */
export async function machineOf(services: Services, record: WorkRecord, context: OpContext): Promise<{ readonly region: Region; readonly machineId: MachineId; readonly filled: boolean }> {
  if (record.region === null) {
    throw boxdError("MACHINE_GONE", `${record.machine} was found in no region when this work was imported, so nothing can act on it.`)
  }
  if (record.machineId !== null) return { region: record.region, machineId: record.machineId, filled: false }
  const info = await services.boxd.get(record.region, record.machine, context)
  return { region: record.region, machineId: info.id, filled: true }
}

/**
 * Runs `fn` under the machine's lock with a target the name was resolved to in this call (H2), and the status that same
 * `machine get` showed: `NOT_OURS` when `oc-<id>` now has another id, and a classified failure when the name is not
 * found.
 */
export function withTarget<T>(services: Services, record: WorkRecord, machine: { readonly region: Region; readonly machineId: MachineId }, context: OpContext, fn: (owned: Owned) => Promise<T>): Promise<T> {
  return services.runner.withMachineLock({ id: machine.machineId }, context, async () => fn(await services.boxd.checkOwned(machine.region, record.machine as MachineName, machine.machineId, context)))
}

/** boxd's states that keep a machine from running a command until it is woken. */
export const asleep = (status: MachineStatus | undefined) => status === "hibernated" || status === "standby" || status === "stopped"

/**
 * After a wake: the shared listing, polled every second for at most `TIMEOUTS.submitStarting`, until it shows the machine
 * running (L-5). A machine still not running then answers `MACHINE_STARTING`, and nothing else was done.
 */
export async function untilRunning(services: Services, target: ChangeTarget, op: OpContext): Promise<void> {
  const deadline = Date.now() + TIMEOUTS.submitStarting
  for (let fresh = true; ; fresh = false) {
    const listing = await services.boxd.list({ maxAgeMs: fresh ? 0 : 1_000 }, op)
    const status = listing.machines.find((row) => row.name === target.name && row.region === target.region)?.status
    if (status === "running") return
    checkStop(op.signal, true)
    if (Date.now() >= deadline) throw boxdError("MACHINE_STARTING", `${target.name} was woken, and is still ${status ?? "not listed"} after ${TIMEOUTS.submitStarting / 1000} s.`)
    await pause(1_000, op.signal)
  }
}

/**
 * The read rule's refusals, as the runner and the CLI port mark them: no listing young enough could be had
 * (`kind: "listing-stale"`, or `rule: "listing-age"` before that marker), or the listing does not show the machine
 * running (`kind: "not-readable"`). Neither is a guest's answer: nothing was read.
 */
export const listingStale = (error: unknown) => error instanceof BoxdError && (error.details.kind === "listing-stale" || error.details.rule === "listing-age")
export const notReadable = (error: unknown) => error instanceof BoxdError && (error.details.kind === "not-readable" || error.code === "MACHINE_ASLEEP")

/**
 * The machine as a listing at most 2 s old shows it (shared with every caller that accepts that age), taken fresh once
 * when the shared one does not hold it: a machine made a moment ago is never mistaken for an absent one.
 */
export async function listed(services: Services, region: Region, name: string, op: OpContext): Promise<{ readonly listing: Listing; readonly row: MachineRow | undefined }> {
  let listing = await services.boxd.list({ maxAgeMs: TIMEOUTS.readListingMaxAgeMs }, op)
  let row = listing.machines.find((machine) => machine.name === name && machine.region === region)
  if (!row && !listing.fresh) {
    listing = await services.boxd.list({ maxAgeMs: 0 }, op)
    row = listing.machines.find((machine) => machine.name === name && machine.region === region)
  }
  return { listing, row }
}

/** A warning added once, by code. */
export function withWarning(warnings: readonly WorkWarning[] | undefined, code: WarningCode, at: string): readonly WorkWarning[] {
  return [...(warnings ?? []).filter((warning) => warning.code !== code), { code, at }]
}

export const withoutWarning = (warnings: readonly WorkWarning[] | undefined, code: WarningCode): readonly WorkWarning[] | undefined => {
  const kept = (warnings ?? []).filter((warning) => warning.code !== code)
  return kept.length ? kept : undefined
}

/** A record without one key: the ledger stores no `undefined`. */
export function omit<K extends keyof WorkRecord>(record: WorkRecord, ...keys: K[]): WorkRecord {
  const copy: Record<string, unknown> = { ...record }
  for (const key of keys) delete copy[key as string]
  return copy as unknown as WorkRecord
}

/**
 * A stopped call: what the runner raised, or `CANCELLED` with `uncertain` when a change may have started. An error that
 * is not the stop itself passes through.
 */
export function stopped(error: unknown, signal: AbortSignal | undefined, changing: boolean): unknown {
  if (!signal?.aborted) return error
  // The runner knows whether a child was in flight: its own answer stands.
  if (error instanceof BoxdError && error.code === "CANCELLED") return error
  return boxdError("CANCELLED", "The call was stopped.", { uncertain: changing })
}

/** Throws `CANCELLED` when the call was stopped: checked between steps that start nothing. */
export function checkStop(signal: AbortSignal | undefined, changing: boolean): void {
  if (signal?.aborted) throw boxdError("CANCELLED", "The call was stopped.", { uncertain: changing })
}

/** Waits `ms`, or less when the call is stopped. */
export function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    signal?.addEventListener("abort", done, { once: true })
  })
}

// ── The list form (design §4.2) ───────────────────────────────────────────────────────────────────────────────────

/**
 * The items of a `works` input: each is checked first, so one bad item refuses the whole call before anything runs.
 * A bare string is a work id where the tool's schema allows it.
 */
export function listItems<I>(works: unknown, shorthand: boolean, check: (item: Record<string, unknown>, index: number) => I): I[] {
  if (!Array.isArray(works) || works.length === 0 || works.length > LIST_MAX_ITEMS) {
    throw boxdError("NAME_INVALID", `works must list 1 to ${LIST_MAX_ITEMS} items.`, { field: "works" })
  }
  const seen = new Set<string>()
  return works.map((raw, index) => {
    const item = shorthand && typeof raw === "string" ? { workId: raw } : raw
    if (!item || typeof item !== "object" || Array.isArray(item)) throw boxdError("NAME_INVALID", `works[${index}] must be an object${shorthand ? " or a work id" : ""}.`, { field: `works[${index}]` })
    const record = item as Record<string, unknown>
    try {
      const checked = check(record, index)
      const workId = record.workId as string
      if (seen.has(workId)) throw boxdError("NAME_INVALID", `works names "${workId}" twice.`, { field: `works[${index}].workId` })
      seen.add(workId)
      return checked
    } catch (error) {
      if (error instanceof BoxdError && error.code === "NAME_INVALID" && !String(error.details.field ?? "").startsWith("works[")) {
        throw boxdError("NAME_INVALID", `works[${index}]: ${error.what}`, { ...error.details, field: `works[${index}].${String(error.details.field ?? "workId")}` })
      }
      throw error
    }
  })
}

/** Exactly one of `path` and `log`, and the like: a field that must be one of a fixed set. */
export function oneOf<T extends string>(value: unknown, values: readonly T[], field: string): T | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw boxdError("NAME_INVALID", `${field} must be one of ${values.map((item) => `"${item}"`).join(", ")}.`, { field })
  }
  return value as T
}

export function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw boxdError("NAME_INVALID", `${field} must be true or false.`, { field })
  return value
}

export function optionalInteger(value: unknown, field: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw boxdError("NAME_INVALID", `${field} must be a whole number from ${minimum} to ${maximum}.`, { field })
  }
  return value
}

export function optionalString(value: unknown, field: string, maxLength = 4096): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value === "" || value.length > maxLength) throw boxdError("NAME_INVALID", `${field} must be a non-empty string.`, { field })
  return value
}
