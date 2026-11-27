/**
 * `boxd_ensure` (design §3.4), owned by package C1: make a work exist, set up and ready, in one call, and converge an
 * existing work to the input. The machinery here (adopting or creating in one region, the VM agent rule, setup, the
 * session reads and the wait) is shared with `boxd_resume` and `boxd_reassign`.
 *
 * The state machine, per work:
 *
 * - **Known work:** its recorded region and machine id. The name is resolved to the id (`checkOwned`) under the
 *   machine lock before anything changes. Asleep: woken (after the budget check). Another size: resized only when the
 *   session is idle (`SESSION_BUSY`). Then `setup`, an upgrade in place when the
 *   guest's OpenCode differs and the session is idle, and the wait.
 * - **No machine id yet:** one all-region listing taken in this call. **A work's machine is only ever made in one
 *   region:** the region the listing shows `oc-<id>` in, else the region the record holds (a create that may have
 *   landed, `pendingCreate`), else a new pick that is claimed in the record under the work's lock before anything is
 *   built or created, so a second call, here or in another process, takes the same region. A new pick considers only
 *   the regions the option `regions` allows, and a create for a claim outside it is refused `REGION_NOT_ALLOWED`: the
 *   allowlist pins placement, while a machine that landed there is still adopted and a work that lives there still
 *   converges. In a known region, one `machine get oc-<id>` under the name's machine lock comes first, and a machine
 *   that landed there is adopted. A create boxd refuses because the name is taken is adopted the same way. Since boxd
 *   keeps names unique per region, no path makes a second `oc-<id>`. Adoption needs the plugin's labels
 *   (`owner=boxd` with `work=<id>`), or `adopt: true`; two regions holding the name are
 *   `NOT_OURS`.
 * - **The VM agent** (#14 §6): `cannot connect to VM agent` on a machine this plugin created, resized or renamed in the
 *   last 10 minutes and has not rebooted since is rebooted once, and the step retried. Otherwise `AGENT_UNREACHABLE`,
 *   unless the input says `repair: "reboot"`.
 * - **The bound:** before each active step (a create, a wake, a resize, `setup`, an upgrade) the item checks that the
 *   step's own bound ends before the call's bound `B`; otherwise it answers `creating` or `starting` with the call that
 *   carries on, and starts nothing.
 * - **The wait** (`wait: "ready"`): one `serve` read with the work folder (the server, and the detached clone's
 *   progress) every 3 s in the call's shared poll loop, holding no item slot, for at most 90 s and never past `B`. A
 *   read the read rule did not make (the machine not running yet, a listing that aged in the queue) is "not ready
 *   yet", never a failure; a work still coming up answers `starting`, which the next call probes fresh.
 */
import { BoxdError, boxdError, inField } from "../errors.js"
import type { RegionChoice } from "../options.js"
import { assertModel, assertRepo, workDirectory } from "../names.js"
import { resolveLaptopPath, rootsOf } from "../paths.js"
import {
  LIST_MAX_ITEMS,
  LIST_WAIT_CREATED_ABOVE,
  REGIONS,
  SIZES,
  TIMEOUTS,
  WORK_LABELS,
  type ChangeTarget,
  type FetchedMachine,
  type MachineId,
  type MachineInfo,
  type MachineName,
  type OpContext,
  type Owned,
  type ReadTarget,
  type Region,
  type SetupAnswer,
  type Size,
} from "../ports.js"
import type { Phase, WorkRecord } from "../ledger/types.js"
import { LEDGER_FORMAT } from "../ledger/types.js"
import type { EnsureResult, ListResult } from "../results.js"
import type { FleetServices } from "../services.js"
import type { CallContext } from "../call.js"
import { imageName, STILL_BUILDING, type Golden } from "./golden.js"
import { runList, runOne, type ItemContext } from "./list.js"
import { pause } from "./sessions-common.js"
import { inUseOf, limitAtCreate, pickRegion, regionsText, type InFlight, type InUse } from "./regions.js"

/** A machine the plugin created, resized or renamed this recently may be rebooted once on its own (#14 §6). */
export const AGENT_REBOOT_WINDOW_MS = 10 * 60_000
/** A lease is renewed at most this often per work (§C.2). */
export const LEASE_RENEW_MS = 6 * 60 * 60_000
/** The most steps the root-session walk takes (§3.5). */
const ROOT_WALK_STEPS = 16

const WORK_ID = /^[a-z][a-z0-9-]{0,24}$/
const REF = /^[A-Za-z0-9._/-]{1,120}$/
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/
const ENV_LIMIT = 64
const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/
const ITEM_KEYS = new Set(["workId", "region", "size", "model", "git", "repo", "ref", "directory", "title", "env", "wait", "repair", "adopt"])

/** What every C1 run shares: the services, this process's creates in flight, the golden builds, the recent changes. */
export interface Machines {
  readonly services: FleetServices
  readonly inFlight: InFlight
  readonly golden: Golden
  /** When this process last created, resized or renamed each machine: the VM agent rule's window. */
  readonly changed: Map<MachineId, number>
  readonly now: () => number
  /** The call bound `B` for a call starting now. */
  readonly bound: () => number
  /** How long ensure and resume wait for the guest's OpenCode: `TIMEOUTS.ensureReady`. */
  readonly readyMs: number
  readonly intervalMs?: number
}

/** The list runner's settings for one call: its bound, the poll interval, the clock. */
export const listSettings = (machines: Machines) => ({ boundMs: machines.bound(), ...(machines.intervalMs !== undefined ? { intervalMs: machines.intervalMs } : {}), now: machines.now })

export type Wait = "ready" | "created" | "none"

/** One `ensure` item, checked. */
export interface EnsureItem {
  readonly workId: string
  readonly region?: RegionChoice
  readonly size?: Size
  readonly model?: string
  readonly git?: { readonly name: string; readonly email: string }
  readonly repo?: { readonly url: string; readonly ref?: string }
  /** The laptop folder, resolved inside the project or an allowed root; undefined keeps the recorded one. */
  readonly directory?: string
  readonly title?: string
  /** The variable names the work declares; an empty list declares none. */
  readonly env?: readonly string[]
  readonly wait: Wait
  readonly repair: boolean
  readonly adopt: boolean
}

const invalid = (field: string, message: string) => boxdError("NAME_INVALID", message, { field })
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Checks one item, as the single form or a list's `works[index]`. Nothing runs before every item passes. */
export async function parseItem(raw: unknown, services: FleetServices, defaultWait: Wait, prefix = ""): Promise<EnsureItem> {
  if (!isObject(raw)) throw invalid(prefix || "workId", `${prefix || "The input"} must be an object with a workId.`)
  const field = (name: string) => `${prefix}${name}`
  for (const key of Object.keys(raw)) if (!ITEM_KEYS.has(key)) throw invalid(field(key), `${field(key)} is not an input of boxd_ensure.`)
  const { workId } = raw
  if (typeof workId !== "string" || !WORK_ID.test(workId)) throw invalid(field("workId"), `${field("workId")} must be a short lowercase work id: a letter, then up to 24 lowercase letters, digits or hyphens.`)
  const choice = (name: string, values: readonly string[]) => {
    const value = raw[name]
    if (value !== undefined && (typeof value !== "string" || !values.includes(value))) throw invalid(field(name), `${field(name)} must be one of ${values.map((entry) => `"${entry}"`).join(", ")}.`)
    return value as string | undefined
  }
  const region = choice("region", ["auto", ...REGIONS]) as RegionChoice | undefined
  if (region !== undefined && region !== "auto" && !services.options.regions.includes(region)) {
    throw boxdError("REGION_NOT_ALLOWED", `The input region "${region}" is outside the plugin option "regions", which allows only ${regionsText(services.options.regions)}; nothing was created.`, {
      field: field("region"),
      region,
      allowed: services.options.regions,
    })
  }
  const size = choice("size", SIZES) as Size | undefined
  const wait = (choice("wait", ["ready", "created", "none"]) as Wait | undefined) ?? defaultWait
  const repair = choice("repair", ["reboot"]) === "reboot"
  if (raw.adopt !== undefined && typeof raw.adopt !== "boolean") throw invalid(field("adopt"), `${field("adopt")} must be true or false.`)
  const model = raw.model === undefined ? undefined : await inField(field("model"), () => (typeof raw.model === "string" ? assertModel(raw.model) : assertModel(String(raw.model))))
  let git: EnsureItem["git"]
  if (raw.git !== undefined) {
    const value = raw.git
    if (!isObject(value) || typeof value.name !== "string" || !value.name.trim() || typeof value.email !== "string" || !EMAIL.test(value.email) || /[\n\r\0]/.test(value.name + value.email)) {
      throw invalid(field("git"), `${field("git")} must be { name, email } with a non-empty name and an email address.`)
    }
    git = { name: value.name, email: value.email }
  }
  if (raw.ref !== undefined && raw.repo === undefined) throw invalid(field("ref"), `${field("ref")} is taken only with repo.`)
  let repo: EnsureItem["repo"]
  if (raw.repo !== undefined) {
    const url = await inField(field("repo"), () => (typeof raw.repo === "string" ? assertRepo(raw.repo) : assertRepo("")))
    if (raw.ref !== undefined && (typeof raw.ref !== "string" || !REF.test(raw.ref) || raw.ref.split("/").includes(".."))) throw invalid(field("ref"), `${field("ref")} must be a branch or tag name.`)
    repo = { url, ...(raw.ref !== undefined ? { ref: raw.ref as string } : {}) }
  }
  let directory: string | undefined
  if (raw.directory !== undefined) {
    if (typeof raw.directory !== "string" || raw.directory === "") throw invalid(field("directory"), `${field("directory")} must be a laptop folder.`)
    directory = await inField(field("directory"), () => resolveLaptopPath(raw.directory as string, rootsOf(services.projectDirectory, services.options.allowedRoots)))
  }
  if (raw.title !== undefined && (typeof raw.title !== "string" || raw.title.length > 200 || /[\n\r\0]/.test(raw.title))) throw invalid(field("title"), `${field("title")} must be one line of at most 200 characters.`)
  let env: readonly string[] | undefined
  if (raw.env !== undefined) {
    if (!Array.isArray(raw.env) || raw.env.length > ENV_LIMIT || !raw.env.every((name) => typeof name === "string" && ENV_NAME.test(name))) {
      throw invalid(field("env"), `${field("env")} must be a list of at most ${ENV_LIMIT} variable names, each uppercase letters, digits and underscores, such as "GH_TOKEN".`)
    }
    if (raw.env.includes("OPENCODE_PASSWORD")) throw invalid(field("env"), `${field("env")} cannot declare OPENCODE_PASSWORD: the guest sets it.`)
    env = [...new Set(raw.env as string[])].sort()
  }
  return {
    workId,
    ...(region ? { region } : {}),
    ...(size ? { size } : {}),
    ...(model ? { model } : {}),
    ...(git ? { git } : {}),
    ...(repo ? { repo } : {}),
    ...(directory ? { directory } : {}),
    ...(raw.title !== undefined ? { title: raw.title as string } : {}),
    ...(env ? { env } : {}),
    wait,
    repair,
    adopt: raw.adopt === true,
  }
}

// ── Shared machinery ──────────────────────────────────────────────────────────────────────────────────────────────

export const opOf = (call: CallContext, source: `boxd_${string}`, signal: AbortSignal = call.signal): OpContext => ({ call: { callId: call.id, source }, signal })

/**
 * A step the call has no time for before its bound: the item answers `state` now, with the call that carries on, and
 * starts nothing. Thrown by `roomFor`, answered by the run that started the item.
 */
export class NotNow extends Error {
  readonly state: "creating" | "starting"
  readonly why: string

  constructor(state: "creating" | "starting", why: string) {
    super(why)
    this.state = state
    this.why = why
  }
}

/** Throws `NotNow` unless the step's own bound ends before the call's bound and the item holds its slot. */
export function roomFor(context: ItemContext, stepMs: number, state: "creating" | "starting", why: string): void {
  if (!context.room(stepMs)) throw new NotNow(state, why)
}

/**
 * A machine carries the plugin's labels for this work: the owner and `work=<id>` (L-b). The
 * same rule as the boxd port's `ownsLabels`, for the work being adopted.
 */
export function carriesLabels(labels: Readonly<Record<string, string>>, workId: string): boolean {
  return labels.work === workId && labels.owner === WORK_LABELS.owner
}

/** The labels a machine still needs to be this work's: owner, role and work. */
export function missingLabels(labels: Readonly<Record<string, string>>, workId: string): Record<string, string> {
  const wanted: Record<string, string> = { ...WORK_LABELS, work: workId }
  return Object.fromEntries(Object.entries(wanted).filter(([key, value]) => labels[key] !== value))
}

const sleeping = (status: string) => status === "hibernated" || status === "standby" || status === "stopped"

/**
 * True for a guest read the read rule did not make, rather than one that failed: the machine is not running in the
 * listing (`MACHINE_ASLEEP`, `kind: "not-readable"`), the read waited in the runner's queue past the listing's 2 s
 * (`kind: "listing-stale"`, `rule: "listing-age"`), or the fresh listing the read needed failed (`kind:
 * "listing-failed"`). It is "not read yet", never a guest failure.
 */
export function notReadYet(error: unknown): boolean {
  if (!(error instanceof BoxdError)) return false
  const kind = error.details.kind
  return error.code === "MACHINE_ASLEEP" || kind === "not-readable" || kind === "listing-stale" || kind === "listing-failed" || error.details.rule === "listing-age"
}

/** One read, made again once when the read rule did not make it; undefined when it still could not be made. */
export async function readOnce<T>(read: () => Promise<T>): Promise<T | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await read()
    } catch (error) {
      if (!notReadYet(error)) throw error
    }
  }
  return undefined
}

export type Reboot = false | "agent-silent" | "repair"

/**
 * Runs a step that talks to the guest, inside the machine's lock. When boxd's VM agent does not answer, the machine is
 * rebooted once and the step retried, if the input asked for a repair, or if this plugin created, resized or renamed
 * the machine in the last 10 minutes and has not rebooted it since (nothing can be running yet). Otherwise
 * `AGENT_UNREACHABLE`. The reboot is recorded by `guestStep`, after the lock is given back (work locks come first).
 */
export async function withAgent<T>(machines: Machines, target: ChangeTarget, input: { readonly workId: string; readonly repair: boolean }, op: OpContext, step: () => Promise<T>): Promise<{ readonly value: T; readonly rebooted: Reboot }> {
  try {
    return { value: await step(), rebooted: false }
  } catch (error) {
    if (!(error instanceof BoxdError) || error.code !== "AGENT_UNREACHABLE") throw error
    const changedAt = machines.changed.get(target.machineId)
    const record = await machines.services.ledger.get(input.workId, op)
    const lastReboot = Math.max(0, ...(record?.reboots ?? []).map((reboot) => Date.parse(reboot.at)))
    const ours = changedAt !== undefined && machines.now() - changedAt <= AGENT_REBOOT_WINDOW_MS && lastReboot < changedAt
    if (!input.repair && !ours) {
      throw boxdError("AGENT_UNREACHABLE", `boxd's VM agent on ${target.name} in ${target.region} does not answer, and the plugin has not changed this machine in the last 10 minutes, so it does not reboot it by itself.`)
    }
    await machines.services.boxd.reboot(target, op)
    // A reboot this rule made is the one it allows: the next silence answers AGENT_UNREACHABLE.
    machines.changed.delete(target.machineId)
    return { value: await step(), rebooted: input.repair ? "repair" : "agent-silent" }
  }
}

/** A guest step under the machine's lock with the VM agent rule, then the reboot it made recorded in `reboots`. */
export async function guestStep<T>(machines: Machines, target: ChangeTarget, input: { readonly workId: string; readonly repair: boolean }, op: OpContext, step: () => Promise<T>): Promise<{ readonly value: T; readonly rebooted: boolean }> {
  const result = await machines.services.runner.withMachineLock({ id: target.machineId }, op, () => withAgent(machines, target, input, op, step))
  if (result.rebooted) {
    const at = new Date(machines.now()).toISOString()
    const why = result.rebooted
    await machines.services.ledger.update(
      [input.workId],
      async (current) => {
        const now = current.get(input.workId)
        return { write: now ? [{ ...now, reboots: [...(now.reboots ?? []), { at, why }] }] : [], value: undefined }
      },
      op,
    )
  }
  return { value: result.value, rebooted: result.rebooted !== false }
}

/** A read target from a listing at most 2 s old: what the read rule needs. */
export async function readTarget(machines: Machines, region: Region, name: MachineName, machineId: MachineId | null, op: OpContext): Promise<ReadTarget> {
  try {
    return { region, name, listing: await machines.services.boxd.list({ maxAgeMs: TIMEOUTS.readListingMaxAgeMs }, op), machineId }
  } catch (error) {
    // The listing a read needs failed, not the guest: the read was not made (`kind: "listing-failed"`), as the CLI
    // port says when its own refresh fails, so a wait keeps waiting and a session read is tried once more.
    // A signed-out or missing CLI (`BOXD_MISSING`) is no reason to wait: only a transient failure is marked.
    if (!(error instanceof BoxdError) || (error.code !== "BOXD_FAILED" && error.code !== "TIMEOUT")) throw error
    throw boxdError(error.code, `${error.what.replace(/\.$/, "")}; nothing was read.`, { ...error.details, kind: "listing-failed", retryable: true })
  }
}

/**
 * The work's session now, from one phase read, made again once when the read rule did not make it: `none` without a
 * recorded session, `unknown` when it still could not be read. A read that was not made is never taken for busy,
 * missing or failed.
 */
export async function sessionState(machines: Machines, record: WorkRecord, target: ChangeTarget, op: OpContext): Promise<"none" | "busy" | "idle" | "missing" | "unknown"> {
  const sessionId = record.session?.rootId
  if (!sessionId) return "none"
  try {
    const answer = await readOnce(async () => {
      const read = await readTarget(machines, target.region, target.name, target.machineId, op)
      return machines.services.guest.phase(read, { sessionId }, op)
    })
    return answer === undefined ? "unknown" : answer.phase
  } catch (error) {
    if (error instanceof BoxdError && error.code === "SESSION_MISSING") return "missing"
    throw error
  }
}

/** One `setup` exec under the machine lock, behind the VM agent rule. */
export async function runSetup(machines: Machines, target: ChangeTarget, record: WorkRecord, input: { readonly workId: string; readonly repair: boolean }, op: OpContext) {
  const { guest, hostVersion } = machines.services
  return guestStep(machines, target, input, op, () =>
    guest.setup(target, { directory: record.guestDirectory, ...(record.repo ? { repo: record.repo } : {}), ...(record.git ? { git: record.git } : {}), env: record.env ?? [], opencode: hostVersion ?? "" }, op),
  )
}

/**
 * The wait for the guest's OpenCode and the clone, in the call's poll loop, holding no item slot: one `serve` read with
 * the work folder per tick, on a listing at most 2 s old. A read the read rule did not make is "not ready yet". A
 * clone that failed is reported by one more `setup`, which answers `GUEST_WORKSPACE` with its reason. Answers `ready`,
 * or `starting` once `readyMs` or the call's bound pass.
 */
export async function waitReady(machines: Machines, context: ItemContext, target: ChangeTarget, record: WorkRecord, first: SetupAnswer, input: { readonly workId: string; readonly repair: boolean }, op: OpContext) {
  let rebooted = false
  let opencode = first.opencode
  if (first.server === "up" && first.workspace === "ready") return { state: "ready" as const, opencode, rebooted }
  const until = Math.min(machines.now() + machines.readyMs, context.deadline)
  const serveOnce = async (): Promise<boolean> => {
    try {
      const served = await machines.services.guest.serve(await readTarget(machines, target.region, target.name, target.machineId, op), { directory: record.guestDirectory }, op)
      if (served.opencode) opencode = served.opencode
      if (served.clone === "failed") await runSetup(machines, target, record, input, op)
      return served.server === "up" && served.clone !== "running"
    } catch (error) {
      if (notReadYet(error)) return false
      throw error
    }
  }
  const ready = await context.poll(async () => {
    try {
      return (await serveOnce()) || undefined
    } catch (error) {
      if (!(error instanceof BoxdError) || error.code !== "AGENT_UNREACHABLE") throw error
      // The VM agent rule, under the machine's lock: a reboot once when the plugin just made or changed the machine.
      const retried = await guestStep(machines, target, input, op, serveOnce)
      rebooted ||= retried.rebooted
      return retried.value || undefined
    }
  }, until)
  return { state: ready ? ("ready" as const) : ("starting" as const), opencode, rebooted }
}

/** The root of a session's tree: the coordinator a work's notices go to (§3.5). Undefined when the walk fails. */
export async function rootSession(machines: Machines, sessionID: string): Promise<string | undefined> {
  let current = sessionID
  try {
    for (let step = 0; step < ROOT_WALK_STEPS; step++) {
      const info = (await machines.services.sessions.get({ sessionID: current as never })) as { readonly parentID?: string } | undefined
      if (!info) return undefined
      if (!info.parentID) return current
      current = info.parentID
    }
  } catch (error) {
    machines.services.report("notices", `The coordinator of session ${sessionID} could not be read (${error instanceof Error ? error.message : String(error)}); its works keep their earlier subscription.`)
  }
  return undefined
}

/** Appends a phase change; a failure is recorded for status and never fails the call. */
export async function recordPhase(machines: Machines, workId: string, from: Phase | null, to: Phase, op: OpContext): Promise<void> {
  try {
    await machines.services.ledger.appendEvent({ at: new Date(machines.now()).toISOString(), workId, from, to }, op)
  } catch (error) {
    machines.services.report("events", `The phase change of ${workId} to ${to} was not recorded (${error instanceof Error ? error.message : String(error)}).`)
  }
}

/** The budget check before a call makes a machine run (§C.5): only with the `budget` option. */
export async function checkBudget(machines: Machines, op: OpContext): Promise<void> {
  if (machines.services.options.budget) await machines.services.cost.assertBudget(op.call)
}

/** A new record for a work, before its create or its adoption. */
export function newRecord(machines: Machines, input: { readonly workId: string; readonly region: Region; readonly size: Size; readonly image: string; readonly laptopDirectory: string } & Partial<Pick<WorkRecord, "repo" | "git" | "env" | "model" | "title">>): WorkRecord {
  const at = new Date(machines.now()).toISOString()
  return {
    format: LEDGER_FORMAT,
    workId: input.workId,
    state: "open",
    region: input.region,
    machine: `oc-${input.workId}`,
    machineId: null,
    size: input.size,
    image: { name: input.image, opencode: machines.services.hostVersion },
    laptopDirectory: input.laptopDirectory,
    guestDirectory: workDirectory(input.workId),
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.git ? { git: input.git } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.title ? { title: input.title } : {}),
    createdAt: at,
    touchedAt: at,
  }
}

/** Writes one record from the current one under the work's lock. */
export async function patch(machines: Machines, workId: string, op: OpContext, change: (current: WorkRecord | undefined) => WorkRecord): Promise<WorkRecord> {
  return machines.services.ledger.update([workId], async (current) => {
    const next = change(current.get(workId))
    return { write: [next], value: next }
  }, op)
}

/** The lease of §C.2 at create, as the record keeps it. */
export function leaseAt(machines: Machines): WorkRecord["lease"] | undefined {
  const days = machines.services.options.leaseDays
  if (days <= 0) return undefined
  const now = machines.now()
  return { days, renewedAt: new Date(now).toISOString(), expiresAt: new Date(now + days * 86_400_000).toISOString() }
}

// ── One machine per work: adopt in a known region, or create there ────────────────────────────────────────────────

/** A work's machine, adopted or made: what boxd answered, and the target that answer proves. */
export interface Landed {
  readonly info: MachineInfo
  readonly owned: Owned
  readonly created: boolean
}

/** How long a create refused as taken waits before it reads the name again. */
const TAKEN_REREAD_MS = 1_000

/** boxd's refusal of a create whose name is taken in that region. */
const TAKEN = /\balready exists\b/i
const taken = (error: unknown) => error instanceof BoxdError && TAKEN.test(error.what)

/** `machine get oc-<id> --region R`: the machine, or undefined when boxd answers its exact not-found words there. */
async function fetchIfThere(machines: Machines, region: Region, name: MachineName, op: OpContext): Promise<FetchedMachine | undefined> {
  try {
    return await machines.services.boxd.get(region, name, op)
  } catch (error) {
    if (error instanceof BoxdError && error.details.kind === "missing") return undefined
    throw error
  }
}

/**
 * Takes a machine that is there as this work's: only with the plugin's labels or `adopt: true`, never shared or
 * isolated. Only for a work with **no recorded machine id**: a `get`'s `owned` rests on labels, which are not proof of
 * ownership, so a work with a recorded id is only ever resolved by `checkOwned` against that id.
 */
async function land(machines: Machines, found: FetchedMachine, input: { readonly workId: string; readonly adopt: boolean }, op: OpContext): Promise<Landed> {
  if (!carriesLabels(found.labels, input.workId) && !input.adopt) {
    throw boxdError("NOT_OURS", `${found.name} in ${found.region} does not carry this plugin's labels (owner=boxd and work=${input.workId}), so it is not adopted. Pass adopt: true to take it over.`, { region: found.region })
  }
  if (found.sharing === "shared") throw boxdError("MACHINE_SHARED", `${found.name} in ${found.region} is shared with the organisation.`)
  if (found.isolated) throw boxdError("MACHINE_ISOLATED", `${found.name} in ${found.region} is isolated.`)
  // A machine another open work records is that work's, whatever its name or labels say, even with adopt: true.
  const holder = (await machines.services.ledger.list({}, op)).find((other) => other.workId !== input.workId && other.machineId === found.id)
  if (holder) {
    throw boxdError("NOT_OURS", `${found.name} in ${found.region} is machine ${found.id}, which the open work ${holder.workId} records, so it is not adopted, even with adopt: true. Rename it back to ${holder.machine}, or boxd_reassign.`, { region: found.region })
  }
  // The port withholds `owned` for a machine without the labels; with adopt: true it is resolved to the id this get read.
  const owned = found.owned ?? (await machines.services.boxd.checkOwned(found.region, found.name as MachineName, found.id, op))
  return { info: found, owned, created: false }
}

/** Adopts `oc-<id>` in `region` if it is there: one `get` under the name's machine lock. */
export async function adoptAt(machines: Machines, input: { readonly workId: string; readonly region: Region; readonly adopt: boolean }, op: OpContext): Promise<Landed | undefined> {
  const name = `oc-${input.workId}` as MachineName
  return machines.services.runner.withMachineLock({ create: { region: input.region, name } }, op, async () => {
    const found = await fetchIfThere(machines, input.region, name, op)
    return found ? land(machines, found, input, op) : undefined
  })
}

/**
 * Creates `oc-<id>` in `region` from `image`, with the §C.2 bounds, under the name's machine lock. A create boxd refuses
 * because the name is taken there adopts the machine that holds it; a limit refusal answers every region's numbers.
 */
export async function createAt(
  machines: Machines,
  input: {
    readonly workId: string
    readonly region: Region
    readonly image: string
    readonly adopt: boolean
    readonly used: InUse
    readonly reserved?: (landed: boolean) => void
    /** The work has a recorded machine id (a rebuild): a machine that holds the name is not adopted, it is `NOT_OURS`. */
    readonly recordedId?: MachineId | null
  },
  context: ItemContext,
  op: OpContext,
): Promise<Landed> {
  const { boxd, runner, options } = machines.services
  const name = `oc-${input.workId}` as MachineName
  return runner.withMachineLock({ create: { region: input.region, name } }, op, async () => {
    roomFor(context, TIMEOUTS.create, "creating", `there is not enough time left in this call for a create (${TIMEOUTS.create / 1000} s)`)
    // The reservation the region pick made, so creates picked at once count each other; else one of its own.
    const end = input.reserved ?? machines.inFlight.reserve(input.region)
    let landed = false
    try {
      const lease = options.leaseDays > 0 ? options.leaseDays : undefined
      const made = await boxd.create(
        { kind: "work", region: input.region, name, workId: input.workId, image: input.image, autoSuspendSeconds: 0, autoHibernateSeconds: options.autoHibernateMinutes * 60, ...(lease ? { leaseDays: lease } : {}) },
        op,
      )
      landed = true
      machines.changed.set(made.id, machines.now())
      return { info: made, owned: made.owned, created: true }
    } catch (error) {
      // A create that timed out may have landed: it stays counted as one.
      if (error instanceof BoxdError && error.code === "CREATE_UNCERTAIN") landed = true
      if (taken(error)) {
        let found = await fetchIfThere(machines, input.region, name, op)
        // boxd's get can lag its own refusal: read once more after a pause, when the call has room for it.
        if (!found && context.room(TAKEN_REREAD_MS + TIMEOUTS.cliRead)) {
          await pause(TAKEN_REREAD_MS, op.signal)
          found = await fetchIfThere(machines, input.region, name, op)
        }
        if (found && input.recordedId) {
          throw boxdError("NOT_OURS", `${name} in ${input.region} is machine ${found.id}, not the recorded ${input.recordedId}, and it appeared while this work's machine was being rebuilt; nothing was created.`)
        }
        if (found) return land(machines, found, input, op)
        // Taken, but not shown yet: the same call again finds it (never BOXD_FAILED for a machine that is there).
        throw new NotNow("creating", `boxd refused ${name} in ${input.region} because the name is taken, but its machine get does not show that machine yet`)
      }
      if (error instanceof BoxdError && error.code === "MACHINE_LIMIT") throw limitAtCreate(error, input.region, await boxd.machineLimit(op).catch(() => []), input.used, machines.inFlight, options.regions)
      throw error
    } finally {
      end(landed)
    }
  })
}

/**
 * The region a work's machine is made in, claimed in its record under the work's lock with `pendingCreate`. A record
 * that already holds a region (a create that may have landed, here or in another process) keeps it, whatever `want`
 * says; `held` is then true and the caller looks there first.
 */
export async function claimRegion(machines: Machines, workId: string, want: Region, fresh: (region: Region) => WorkRecord, image: string, op: OpContext): Promise<{ readonly region: Region; readonly held: boolean; readonly record: WorkRecord }> {
  type Claim = { readonly region: Region; readonly held: boolean; readonly record: WorkRecord }
  return machines.services.ledger.update<Claim>(
    [workId],
    async (current) => {
      const now = current.get(workId)
      if (now?.state === "open" && now.region !== null) {
        const record: WorkRecord = { ...now, pendingCreate: now.pendingCreate ?? { at: new Date(machines.now()).toISOString(), image } }
        return { write: [record], value: { region: now.region, held: true, record } }
      }
      const record: WorkRecord = { ...fresh(want), pendingCreate: { at: new Date(machines.now()).toISOString(), image } }
      return { write: [record], value: { region: want, held: false, record } }
    },
    op,
  )
}

// ── boxd_ensure ───────────────────────────────────────────────────────────────────────────────────────────────────

interface Converged {
  readonly target: ChangeTarget
  readonly record: WorkRecord
  readonly created: boolean
  readonly adopted: boolean
  readonly woke: boolean
}

/** Resizes a machine to `size` when its session is idle; `SESSION_BUSY` when it runs (a resize reboots). */
async function resizeIfIdle(machines: Machines, record: WorkRecord, target: ChangeTarget, size: Size, context: ItemContext, op: OpContext): Promise<void> {
  const session = await sessionState(machines, record, target, op)
  if (session === "busy") throw boxdError("SESSION_BUSY", `${record.workId}'s session is running, and a resize to ${size} reboots the machine.`)
  if (session === "unknown") throw boxdError("MACHINE_STARTING", `${record.workId}'s session could not be read yet, so it is not resized to ${size} now.`)
  roomFor(context, TIMEOUTS.resize, "starting", `there is not enough time left in this call for a resize (${TIMEOUTS.resize / 1000} s)`)
  await machines.services.boxd.resize(target, size, op)
  machines.changed.set(target.machineId, machines.now())
}

/** After an adoption: the labels, a wake and the size asked for, under the machine's lock. */
async function settleAdopted(machines: Machines, landed: Landed, record: WorkRecord, item: EnsureItem, context: ItemContext, op: OpContext): Promise<Converged> {
  const { boxd, runner } = machines.services
  const target = landed.owned.target
  const asleep = sleeping(landed.owned.status)
  if (asleep) await checkBudget(machines, op)
  const resizeTo = item.size && landed.info.size && item.size !== landed.info.size ? item.size : undefined
  await runner.withMachineLock({ id: target.machineId }, op, async () => {
    const labels = missingLabels(landed.info.labels, item.workId)
    if (Object.keys(labels).length > 0) await boxd.setLabels(target, labels, op)
    if (asleep) {
      roomFor(context, TIMEOUTS.helperChange, "starting", "there is not enough time left in this call to wake the machine")
      await boxd.wake(target, op)
    }
    if (resizeTo) await resizeIfIdle(machines, record, target, resizeTo, context, op)
  })
  const settled = resizeTo ? await patch(machines, item.workId, op, (now) => ({ ...(now ?? record), size: resizeTo! })) : record
  return { target, record: settled, created: false, adopted: true, woke: asleep }
}

/** Records a landed machine's id at once, before any other step can fail. */
async function recordLanded(machines: Machines, item: EnsureItem, landed: Landed, base: WorkRecord, size: Size, op: OpContext): Promise<WorkRecord> {
  const lease = landed.created ? leaseAt(machines) : undefined
  return patch(machines, item.workId, op, (now) => {
    const { pendingCreate: _landed, ...rest } = now?.state === "open" ? now : base
    return { ...rest, state: "open", region: landed.info.region, machineId: landed.info.id, size: landed.info.size ?? size, ...(lease ? { lease } : {}) } as WorkRecord
  })
}

/** Creates or adopts the machine of a work that has no machine id yet; `building` while its image builds. */
async function createOrAdopt(machines: Machines, item: EnsureItem, context: ItemContext, op: OpContext, previous: WorkRecord | undefined): Promise<Converged | { readonly building: { readonly region: Region; readonly size: Size; readonly image: string } }> {
  const { boxd, options } = machines.services
  const name = `oc-${item.workId}` as MachineName
  const size = item.size ?? options.size
  const laptopDirectory = item.directory ?? previous?.laptopDirectory ?? machines.services.projectDirectory
  const image = imageName(options.goldenPrefix, machines.services.hostVersion, size)
  const fresh = (region: Region) =>
    newRecord(machines, { workId: item.workId, region, size, image, laptopDirectory, ...(item.repo ? { repo: item.repo } : {}), ...((item.git ?? options.git) ? { git: item.git ?? options.git } : {}), ...(item.env ? { env: item.env } : {}), ...(item.model ? { model: item.model } : {}), ...(item.title ? { title: item.title } : {}) })

  const asked = machines.now()
  const listing = await boxd.list({ maxAgeMs: 0 }, op)
  const found = listing.machines.filter((row) => row.name === name)
  if (found.length > 1) {
    throw boxdError("NOT_OURS", `${name} exists in ${found.map((row) => row.region).join(" and ")}; a work has one machine, so nothing was changed. Remove or rename one of them with boxd machine.`, { regions: found.map((row) => row.region) })
  }
  const shown = found[0]
  if (shown && !carriesLabels(shown.labels, item.workId) && !item.adopt) {
    throw boxdError("NOT_OURS", `${name} in ${shown.region} does not carry this plugin's labels (owner=boxd and work=${item.workId}), so it is not adopted. Pass adopt: true to take it over.`, { region: shown.region })
  }
  const adopted = async (landed: Landed) => {
    const record = await recordLanded(machines, item, landed, previous?.state === "open" ? previous : fresh(landed.info.region), size, op)
    return settleAdopted(machines, landed, record, item, context, op)
  }
  // Where the machine is, or was being made: there first, and adopted if it is there.
  const where = shown?.region ?? previous?.region ?? undefined
  if (where) {
    const there = await adoptAt(machines, { workId: item.workId, region: where, adopt: item.adopt }, op)
    if (there) return adopted(there)
  }

  // A new machine: the budget, the region (claimed in the record), the image, then the create there.
  await checkBudget(machines, op)
  const used = inUseOf(listing.machines, asked)
  const snapshots = await machines.golden.images(op)
  const allowed = options.regions
  const withImage = new Set(REGIONS.filter((region) => allowed.includes(region) && snapshots.some((row) => row.region === region && row.name === image)))
  const limits = where ? [] : await boxd.machineLimit(op)
  // The pick and its reservation in one step, with nothing awaited between: items picking at once count each other.
  const want = where ?? pickRegion({ choice: item.region ?? options.region, limits, keepFree: options.keepFree, inFlight: machines.inFlight, used, withImage, allowed })
  let reserved: ((landed: boolean) => void) | undefined = where ? undefined : machines.inFlight.reserve(want)
  try {
    const claim = await claimRegion(machines, item.workId, want, fresh, image, op)
    const region = claim.region
    if (region !== want) {
      reserved?.(false)
      reserved = undefined
    }
    if (claim.held && region !== where) {
      // Another call claimed a region first: its machine may have landed there.
      const there = await adoptAt(machines, { workId: item.workId, region, adopt: item.adopt }, op)
      if (there) return await adopted(there)
    }
    if (!allowed.includes(region)) {
      // The pick and the image set are both filtered to the allowlist, so this is a region an earlier call claimed in
      // the record while it was allowed: finishing that claim is new placement, and it stays refused.
      throw boxdError("REGION_NOT_ALLOWED", `This work's record claims region "${region}", where no machine landed, and the plugin option "regions" allows only ${regionsText(allowed)}; the create would be new placement outside it, so nothing was built or created. Add "${region}" to "regions" and call again.`, {
        region,
        allowed,
      })
    }
    if (!withImage.has(region)) {
      if (options.buildGolden === "never") throw boxdError("GOLDEN_MISSING", `No golden image ${image} in ${region}, and buildGolden is "never".`, { region, size })
      const built = await context.waiting(() => machines.golden.build({ region, size, base: options.goldenBase, name: image }, { signal: context.signal, until: context.deadline }))
      if (built === STILL_BUILDING) return { building: { region, size, image } }
    }
    const landed = await createAt(machines, { workId: item.workId, region, image, adopt: item.adopt, used, ...(reserved ? { reserved } : {}) }, context, op)
    if (!landed.created) return await adopted(landed)
    const record = await recordLanded(machines, item, landed, claim.record, size, op)
    await recordPhase(machines, item.workId, null, "creating", op)
    return { target: landed.owned.target, record, created: true, adopted: false, woke: false }
  } finally {
    // A pick that made no create (adopted, still building, refused) stops counting; a create already ended it.
    reserved?.(false)
  }
}

/** Resolves a known work's machine by its recorded id, and wakes it when it sleeps. */
async function known(machines: Machines, record: WorkRecord & { readonly region: Region; readonly machineId: MachineId }, item: EnsureItem, context: ItemContext, op: OpContext): Promise<Converged> {
  const { boxd, runner } = machines.services
  const region = record.region
  const id = record.machineId
  const checked = await runner.withMachineLock({ id }, op, async () => {
    let owned: Owned
    try {
      owned = await boxd.checkOwned(region, record.machine, id, op)
    } catch (error) {
      if (error instanceof BoxdError && error.details.kind === "missing") {
        // One region's answer is not "gone" (§3.9): resume checks every region, and rebuilds only a machine gone everywhere.
        throw boxdError("BOXD_FAILED", `${record.machine} was not found in ${region}. boxd_resume({ workId: "${record.workId}" }) checks every region, and rebuilds it only when it is gone everywhere.`, { kind: "missing" })
      }
      if (error instanceof BoxdError && error.details.kind === "elsewhere") {
        throw boxdError("NOT_OURS", `${record.machine} is not in ${region}, where this work's machine was recorded; boxd says a machine by that name is in ${String(error.details.region)}.`)
      }
      throw error
    }
    const target = owned.target
    let woke = false
    if (sleeping(owned.status)) {
      await checkBudget(machines, op)
      roomFor(context, TIMEOUTS.helperChange, "starting", "there is not enough time left in this call to wake the machine")
      await boxd.wake(target, op)
      woke = true
    }
    // Another size: only for an idle session, because a resize reboots.
    const resized = item.size !== undefined && item.size !== record.size
    if (resized) await resizeIfIdle(machines, record, target, item.size!, context, op)
    return { target, woke, resized }
  })
  // The ledger after the machine's lock is given back: work locks are always taken first (§4.1).
  const current: WorkRecord = checked.resized ? await patch(machines, record.workId, op, (now) => ({ ...(now ?? record), size: item.size! })) : record
  return { target: checked.target, record: current, created: false, adopted: false, woke: checked.woke }
}

/** The input's settings, recorded: the default model, the git identity, the declared variables, the repository, the folder and the title. */
function withInput(machines: Machines, record: WorkRecord, item: EnsureItem, notify: string | undefined): WorkRecord {
  return {
    ...record,
    ...(item.model ? { model: item.model } : {}),
    ...(item.git ? { git: item.git } : record.git === undefined && machines.services.options.git ? { git: machines.services.options.git } : {}),
    ...(item.env ? { env: item.env } : {}),
    ...(item.repo ? { repo: item.repo } : {}),
    ...(item.directory ? { laptopDirectory: item.directory } : {}),
    ...(item.title ? { title: item.title } : {}),
    ...(notify ? { session: { ...record.session, notify } } : {}),
    touchedAt: new Date(machines.now()).toISOString(),
  }
}

/** Renews the `leaseDays` timer when it is older than 6 hours (§C.2). */
async function renewLease(machines: Machines, record: WorkRecord, target: ChangeTarget, op: OpContext): Promise<WorkRecord> {
  const days = machines.services.options.leaseDays
  if (days <= 0) return record
  if (record.lease && machines.now() - Date.parse(record.lease.renewedAt) < LEASE_RENEW_MS) return record
  await machines.services.runner.withMachineLock({ id: target.machineId }, op, () => machines.services.boxd.renewLease(target, days, op))
  const lease = leaseAt(machines)!
  return patch(machines, record.workId, op, (now) => ({ ...(now ?? record), lease }))
}

/** The call that carries on for a work this call left `creating` or `starting`. */
const again = (workId: string, why: string) => `boxd_ensure({ workId: "${workId}" }): ${why}; it repeats nothing that was done.`

/** One work, start to finish: the result, or a coded refusal thrown. */
export async function ensureOne(machines: Machines, item: EnsureItem, context: ItemContext, call: CallContext, finishRename?: (record: WorkRecord, op: OpContext) => Promise<WorkRecord>): Promise<EnsureResult> {
  const op = opOf(call, "boxd_ensure", context.signal)
  const { ledger, hostVersion, guest } = machines.services
  let record = await ledger.get(item.workId, op)
  // A reassign that stopped half-way (this id is its `to`, or its `from`) is finished first (§3.10).
  if (record?.state === "open" && finishRename) record = await finishRename(record, op)
  const open = record?.state === "open" ? record : undefined
  const notify = call.via === "model" ? await rootSession(machines, call.sessionID) : undefined
  if (open && open.region === null) throw boxdError("MACHINE_GONE", `${open.machine} was found in no region.`)

  let converged: Converged | undefined
  try {
    if (open && open.region !== null && open.machineId !== null) converged = await known(machines, open as WorkRecord & { region: Region; machineId: MachineId }, item, context, op)
    else {
      // No machine id yet: a new work, a create that may have landed (pendingCreate), or an imported work whose get failed.
      const made = await createOrAdopt(machines, item, context, op, open)
      if ("building" in made) {
        return {
          state: "creating",
          workId: item.workId,
          machine: `oc-${item.workId}` as MachineName,
          region: made.building.region,
          machineId: null,
          size: made.building.size,
          image: made.building.image,
          guestVersion: null,
          created: false,
          next: again(item.workId, `the golden image ${made.building.image} is still being built in ${made.building.region}, and the next call joins that build`),
        }
      }
      converged = made
    }

    let current = await patch(machines, item.workId, op, (now) => withInput(machines, now ?? converged!.record, item, notify))
    if (!converged.created) current = await renewLease(machines, current, converged.target, op)
    const target = converged.target
    let rebooted = false
    let upgraded = false
    let guestVersion: string | null = null
    let state: EnsureResult["state"] = "starting"

    if (item.wait !== "none") {
      roomFor(context, TIMEOUTS.setup, "starting", `there is not enough time left in this call for setup (${TIMEOUTS.setup / 1000} s)`)
      const setup = await runSetup(machines, target, current, item, op)
      rebooted ||= setup.rebooted
      guestVersion = setup.value.opencode || null
      // A guest on another OpenCode is upgraded in place while its session is idle; the session database stays. An
      // upgrade this call has no time for is the next call's, so the work answers starting.
      const behind = Boolean(hostVersion && guestVersion && guestVersion !== hostVersion)
      const noTime = behind && !context.room(TIMEOUTS.upgrade)
      if (behind && !noTime) {
        const session = await sessionState(machines, current, target, op)
        if (session === "none" || session === "idle") {
          const answer = await guestStep(machines, target, item, op, () => guest.upgrade(target, { version: hostVersion! }, op))
          rebooted ||= answer.rebooted
          guestVersion = answer.value.opencode
          upgraded = true
        }
      }
      if (item.wait === "ready") {
        const waited = await waitReady(machines, context, target, current, upgraded ? { ...setup.value, server: "starting" } : setup.value, item, op)
        rebooted ||= waited.rebooted
        state = waited.state
        if (waited.opencode) guestVersion = waited.opencode
      } else {
        state = setup.value.server === "up" && setup.value.workspace === "ready" ? "ready" : "starting"
      }
      if (noTime) state = "starting"
    }

    if (converged.created) await recordPhase(machines, item.workId, "creating", state === "ready" ? "ready" : "starting", op)
    else if (converged.woke) await recordPhase(machines, item.workId, "asleep", current.session?.rootId ? "idle" : "ready", op)

    return {
      state,
      workId: item.workId,
      machine: target.name,
      region: target.region,
      machineId: target.machineId,
      size: current.size,
      image: current.image.name,
      guestVersion,
      ...(current.model ? { model: current.model } : {}),
      created: converged.created,
      ...(converged.adopted ? { adopted: true } : {}),
      ...(upgraded ? { upgraded: true } : {}),
      ...(rebooted ? { rebooted: true } : {}),
      next: state === "ready" ? `boxd_submit({ workId: "${item.workId}", text: "<the task>" })` : again(item.workId, `it waits for the guest's OpenCode${item.repo ? " and the clone" : ""}`),
    }
  } catch (error) {
    if (!(error instanceof NotNow)) throw error
    // The call's bound came before a step could start: what is known so far, and the call that carries on.
    const now = await ledger.get(item.workId, op)
    const target = converged?.target
    return {
      state: error.state,
      workId: item.workId,
      machine: `oc-${item.workId}` as MachineName,
      // A step is only ever stopped for time once the region is claimed in the record.
      region: target?.region ?? now?.region ?? REGIONS[0],
      machineId: target?.machineId ?? now?.machineId ?? null,
      size: now?.size ?? item.size ?? machines.services.options.size,
      image: now?.image.name ?? imageName(machines.services.options.goldenPrefix, hostVersion, item.size ?? machines.services.options.size),
      guestVersion: null,
      created: converged?.created ?? false,
      next: again(item.workId, error.why),
    }
  }
}

/** One list item as the `next` spells it: `{ workId: "a" }`, or its whole input when it has more than a work id. */
function itemText(raw: unknown): string {
  const value = raw as Record<string, unknown>
  return Object.keys(value).length === 1 ? `{ workId: "${String(value.workId)}" }` : JSON.stringify(value)
}

/** `boxd_ensure`: the single form or the list form. */
export async function runEnsure(machines: Machines, input: Record<string, unknown>, call: CallContext, finishRename: (record: WorkRecord, op: OpContext) => Promise<WorkRecord>): Promise<EnsureResult | ListResult<EnsureResult>> {
  const services = machines.services
  const settings = listSettings(machines)
  if (input.works === undefined) {
    const item = await parseItem(input, services, "ready")
    return runOne({ signal: call.signal, ...settings }, (context) => ensureOne(machines, item, context, call, finishRename))
  }
  const works = input.works
  if (!Array.isArray(works) || works.length < 1 || works.length > LIST_MAX_ITEMS) throw invalid("works", `works must be a list of 1 to ${LIST_MAX_ITEMS} objects with a workId.`)
  for (const key of Object.keys(input)) if (key !== "works") throw invalid(key, `Pass ${key} inside each item of works, not beside it.`)
  const defaultWait: Wait = works.length > LIST_WAIT_CREATED_ABOVE ? "created" : "ready"
  // Every item is checked before anything runs, so a bad field fails before anything bills.
  const items: EnsureItem[] = []
  for (const [index, raw] of works.entries()) items.push(await parseItem(raw, services, defaultWait, `works[${index}].`))
  const seen = new Set<string>()
  for (const [index, item] of items.entries()) {
    if (seen.has(item.workId)) throw invalid(`works[${index}].workId`, `works[${index}].workId "${item.workId}" appears twice; name each work once.`)
    seen.add(item.workId)
  }
  return runList(
    items,
    {
      signal: call.signal,
      ...settings,
      workId: (item) => item.workId,
      success: (result) => result.state === "ready" || (items.find((item) => item.workId === result.workId)?.wait !== "ready" && result.state === "starting"),
      pendingStates: ["creating", "starting"],
      // The same items again, each as it was given, so a retried item keeps its repo, model and size.
      again: (ids) => `boxd_ensure({ works: [${ids.map((id) => itemText(works[items.findIndex((item) => item.workId === id)])).join(", ")}] })`,
    },
    (item, context) => ensureOne(machines, item, context, call, finishRename),
  )
}
