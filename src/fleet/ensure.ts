/**
 * `boxd_ensure` (design §3.4), owned by package C1: make a work exist, set up and ready, in one call, and converge an
 * existing work to the input. The machinery here (the target after a create, the VM agent rule, setup and the wait) is
 * shared with `boxd_resume` and `boxd_reassign`.
 *
 * The state machine, per work:
 *
 * - **Known work:** its recorded region and machine id. The name is resolved to the id (`checkOwned`) under the
 *   machine lock before anything changes. Asleep: woken (after the budget check). Another size: resized only when the
 *   session is not busy (`SESSION_BUSY`). An imported v0 guest: adopted once. Then `setup`, an upgrade in place when
 *   the guest's OpenCode differs and the session is idle, and the wait.
 * - **New work:** one all-region listing taken in this call. One `oc-<id>` carrying the plugin's labels is adopted (its
 *   id read with one `get` and recorded first); one without them only with `adopt: true`; two are `NOT_OURS`. Otherwise
 *   the region is picked (`./regions.ts`), the golden image found or built (`./golden.ts`), the intent recorded
 *   (`pendingCreate`), the machine created with the cost bounds of §C.2, and its id recorded at once.
 * - **The VM agent** (#14 §6): `cannot connect to VM agent` on a machine this plugin created, resized or renamed in the
 *   last 10 minutes and has not rebooted since is rebooted once, and the step retried. Otherwise `AGENT_UNREACHABLE`,
 *   unless the input says `repair: "reboot"`.
 * - **The wait** (`wait: "ready"`): the guest's OpenCode is polled every 3 s in the call's shared poll loop, holding no
 *   item slot, for at most 90 s and never past the call's bound; a work still coming up answers `starting`, which is
 *   probed fresh by the next call (no stale `MACHINE_STARTING`).
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
  type Listing,
  type MachineId,
  type MachineInfo,
  type MachineName,
  type MachineRow,
  type OpContext,
  type ReadTarget,
  type Region,
  type SetupAnswer,
  type Size,
} from "../ports.js"
import type { Phase, WorkRecord } from "../ledger/types.js"
import { LEDGER_FORMAT } from "../ledger/types.js"
import type { EnsureResult, ListResult } from "../results.js"
import type { FleetServices } from "../services.js"
import type { CallContext } from "../tools.js"
import { imageName, STILL_BUILDING, type Golden } from "./golden.js"
import { runList, runOne, type ItemContext } from "./list.js"
import { InFlight, limitAtCreate, pickRegion } from "./regions.js"

/** A machine the plugin created, resized or renamed this recently may be rebooted once on its own (#14 §6). */
export const AGENT_REBOOT_WINDOW_MS = 10 * 60_000
/** A lease is renewed at most this often per work (§C.2). */
export const LEASE_RENEW_MS = 6 * 60 * 60_000
/** The most steps the root-session walk takes (§3.5). */
const ROOT_WALK_STEPS = 16

const WORK_ID = /^[a-z][a-z0-9-]{0,24}$/
const REF = /^[A-Za-z0-9._/-]{1,120}$/
const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/
const ITEM_KEYS = new Set(["workId", "region", "size", "model", "git", "repo", "ref", "directory", "title", "wait", "repair", "adopt"])

/** What every C1 run shares: the services, this process's creates in flight, the golden builds, the recent changes. */
export interface Machines {
  readonly services: FleetServices
  readonly inFlight: InFlight
  readonly golden: Golden
  /** When this process last created, resized or renamed each machine: the VM agent rule's window. */
  readonly changed: Map<MachineId, number>
  readonly now: () => number
  readonly boundMs?: number
  readonly intervalMs?: number
}

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
  return {
    workId,
    ...(region ? { region } : {}),
    ...(size ? { size } : {}),
    ...(model ? { model } : {}),
    ...(git ? { git } : {}),
    ...(repo ? { repo } : {}),
    ...(directory ? { directory } : {}),
    ...(raw.title !== undefined ? { title: raw.title as string } : {}),
    wait,
    repair,
    adopt: raw.adopt === true,
  }
}

// ── Shared machinery ──────────────────────────────────────────────────────────────────────────────────────────────

export const opOf = (call: CallContext, source: `boxd_${string}`, signal: AbortSignal = call.signal): OpContext => ({ call: { callId: call.id, source }, signal })

/**
 * The target of a machine boxd named in this call: the id `machine new --json` answered, or a `get` that this call made
 * just before taking the machine's lock. That answer is the same proof `checkOwned` makes (the name resolved to this id
 * now), so the by-id check is not repeated: §4.4 counts one create and no `get` for a new work, and one `get` for an
 * adopted one. Every later call checks again.
 */
export function boxdNamed(info: Pick<MachineInfo, "id" | "name" | "region">, at: number): ChangeTarget {
  return { region: info.region, name: info.name as MachineName, machineId: info.id, checkedAt: at } as ChangeTarget
}

/** A machine carries the plugin's labels: v1's owner, or v0's `role=session` with `work=<id>` (L-b). */
export function carriesLabels(labels: Readonly<Record<string, string>>, workId: string): boolean {
  if (labels.work !== undefined && labels.work !== workId) return false
  return labels.owner === WORK_LABELS.owner || (labels.role === WORK_LABELS.role && labels.work === workId)
}

/** The labels a machine still needs to be this work's: owner, role and work. */
export function missingLabels(labels: Readonly<Record<string, string>>, workId: string): Record<string, string> {
  const wanted: Record<string, string> = { ...WORK_LABELS, work: workId }
  return Object.fromEntries(Object.entries(wanted).filter(([key, value]) => labels[key] !== value))
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
  const listing: Listing = await machines.services.boxd.list({ maxAgeMs: TIMEOUTS.readListingMaxAgeMs }, op)
  return { region, name, listing, machineId }
}

/** Whether the work's session is running now: one phase read, through v0's own helper for an unadopted v0 guest. */
export async function sessionBusy(machines: Machines, record: WorkRecord, target: ChangeTarget, op: OpContext): Promise<boolean> {
  const sessionId = record.session?.rootId
  if (!sessionId) return false
  const read = await readTarget(machines, target.region, target.name, target.machineId, op)
  const answer = record.guestHelper === "v0" ? await machines.services.importV0.readPhase(read, { sessionId }, op) : await machines.services.guest.phase(read, { sessionId }, op)
  return answer.phase === "busy"
}

/** One `setup` exec under the machine lock, behind the VM agent rule. */
export async function runSetup(machines: Machines, target: ChangeTarget, record: WorkRecord, input: { readonly workId: string; readonly repair: boolean }, op: OpContext) {
  const { guest, hostVersion } = machines.services
  return guestStep(machines, target, input, op, () =>
    guest.setup(target, { directory: record.guestDirectory, ...(record.repo ? { repo: record.repo } : {}), ...(record.git ? { git: record.git } : {}), opencode: hostVersion ?? "" }, op),
  )
}

/**
 * The wait for the guest's OpenCode and the clone, in the call's poll loop, holding no item slot: a `serve` read on a
 * listing at most 2 s old while only the server is coming up, and `setup` again (idempotent; it reports the detached
 * clone) while a clone runs. Answers `ready`, or `starting` once 90 s or the call's bound pass.
 */
export async function waitReady(machines: Machines, context: ItemContext, target: ChangeTarget, record: WorkRecord, first: SetupAnswer, input: { readonly workId: string; readonly repair: boolean }, op: OpContext) {
  let cloning = first.workspace === "cloning"
  let rebooted = false
  let opencode = first.opencode
  if (first.server === "up" && !cloning) return { state: "ready" as const, opencode, rebooted }
  const until = Math.min(machines.now() + TIMEOUTS.ensureReady, context.deadline)
  /** One `serve` read; a machine boxd still shows starting is not ready yet (the read rule refuses it, waking nothing). */
  const serveOnce = async (): Promise<boolean> => {
    try {
      const served = await machines.services.guest.serve(await readTarget(machines, target.region, target.name, target.machineId, op), op)
      if (served.opencode) opencode = served.opencode
      return served.server === "up"
    } catch (error) {
      if (error instanceof BoxdError && error.code === "MACHINE_ASLEEP") return false
      throw error
    }
  }
  const ready = await context.poll(async () => {
    if (cloning) {
      const again = await runSetup(machines, target, record, input, op)
      rebooted ||= again.rebooted
      opencode = again.value.opencode
      cloning = again.value.workspace === "cloning"
      return again.value.server === "up" && !cloning ? true : undefined
    }
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
export function newRecord(machines: Machines, input: { readonly workId: string; readonly region: Region; readonly size: Size; readonly image: string; readonly laptopDirectory: string } & Partial<Pick<WorkRecord, "repo" | "git" | "model" | "title">>): WorkRecord {
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
    ...(input.model ? { model: input.model } : {}),
    ...(input.title ? { title: input.title } : {}),
    createdAt: at,
    touchedAt: at,
    guestHelper: "v1",
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

// ── boxd_ensure ───────────────────────────────────────────────────────────────────────────────────────────────────

interface Converged {
  readonly target: ChangeTarget
  readonly record: WorkRecord
  readonly created: boolean
  readonly adopted: boolean
  readonly woke: boolean
}

/** Creates or adopts the machine of a work the ledger has no open machine for; `building` while its image builds. */
async function createOrAdopt(machines: Machines, item: EnsureItem, context: ItemContext, op: OpContext, previous: WorkRecord | undefined): Promise<Converged | { readonly building: { readonly region: Region; readonly size: Size; readonly image: string } }> {
  const { boxd, options, runner } = machines.services
  const name = `oc-${item.workId}` as MachineName
  const size = item.size ?? options.size
  const laptopDirectory = item.directory ?? previous?.laptopDirectory ?? machines.services.projectDirectory
  const listing = await boxd.list({ maxAgeMs: 0 }, op)
  const found = listing.machines.filter((row) => row.name === name)
  if (found.length > 1) {
    throw boxdError("NOT_OURS", `${name} exists in ${found.map((row) => row.region).join(" and ")}; a work has one machine, so nothing was changed. Remove or rename one of them with boxd machine.`, { regions: found.map((row) => row.region) })
  }
  const existing: MachineRow | undefined = found[0]
  if (existing) {
    if (!carriesLabels(existing.labels, item.workId) && !item.adopt) {
      throw boxdError("NOT_OURS", `${name} in ${existing.region} does not carry this plugin's labels (owner=opencode-boxd, or role=session with work=${item.workId}), so it is not adopted. Pass adopt: true to take it over.`, { region: existing.region })
    }
    if (existing.sharing === "shared") throw boxdError("MACHINE_SHARED", `${name} in ${existing.region} is shared with the organisation.`)
    const info = await boxd.get(existing.region, name, op)
    if (info.isolated) throw boxdError("MACHINE_ISOLATED", `${name} in ${existing.region} is isolated.`)
    const target = boxdNamed(info, machines.now())
    const record = await patch(machines, item.workId, op, (current) => ({
      ...(current && current.state === "open" ? current : newRecord(machines, { workId: item.workId, region: info.region, size: info.size ?? size, image: imageName(options.goldenPrefix, machines.services.hostVersion, info.size ?? size), laptopDirectory })),
      region: info.region,
      machineId: info.id,
      size: info.size ?? size,
      pendingCreate: undefined,
    } as WorkRecord))
    const asleep = info.status === "hibernated" || info.status === "standby" || info.status === "stopped"
    if (asleep) await checkBudget(machines, op)
    await runner.withMachineLock({ id: info.id }, op, async () => {
      const labels = missingLabels(info.labels, item.workId)
      if (Object.keys(labels).length > 0) await boxd.setLabels(target, labels, op)
      if (asleep) await boxd.wake(target, op)
      // An imported work whose v0 guest still runs: its password is taken over once (§6.3).
      if (record.guestHelper === "v0") await machines.services.importV0.adopt(target, op)
    })
    const adopted = record.guestHelper === "v0" ? await patch(machines, item.workId, op, (now) => ({ ...(now ?? record), guestHelper: "v1" })) : record
    return { target, record: adopted, created: false, adopted: true, woke: asleep }
  }

  // A new machine: the budget, the region, the image, the intent, then the create.
  await checkBudget(machines, op)
  const image = imageName(options.goldenPrefix, machines.services.hostVersion, size)
  const snapshots = await machines.golden.images(op)
  const withImage = new Set(REGIONS.filter((region) => snapshots.some((row) => row.region === region && row.name === image)))
  const region = pickRegion({ choice: item.region ?? options.region, limits: await boxd.machineLimit(op), keepFree: options.keepFree, inFlight: machines.inFlight, withImage })
  if (!withImage.has(region)) {
    if (options.buildGolden === "never") throw boxdError("GOLDEN_MISSING", `No golden image ${image} in ${region}, and buildGolden is "never".`, { region, size })
    const built = await context.waiting(() => machines.golden.build({ region, size, base: options.goldenBase, name: image }, { signal: context.signal, until: context.deadline }))
    if (built === STILL_BUILDING) return { building: { region, size, image } }
  }
  await patch(machines, item.workId, op, () => ({
    ...newRecord(machines, { workId: item.workId, region, size, image, laptopDirectory, ...(item.repo ? { repo: item.repo } : {}), ...(item.git ?? options.git ? { git: item.git ?? options.git } : {}), ...(item.model ? { model: item.model } : {}), ...(item.title ? { title: item.title } : {}) }),
    pendingCreate: { at: new Date(machines.now()).toISOString(), image },
  }))
  const release = machines.inFlight.reserve(region)
  let info: MachineInfo
  try {
    const lease = options.leaseDays > 0 ? options.leaseDays : undefined
    info = await runner.withMachineLock({ create: { region, name } }, op, () =>
      boxd.create({ kind: "work", region, name, workId: item.workId, image, autoSuspendSeconds: 0, autoHibernateSeconds: options.autoHibernateMinutes * 60, ...(lease ? { leaseDays: lease } : {}) }, op),
    )
  } catch (error) {
    if (error instanceof BoxdError && error.code === "MACHINE_LIMIT") throw limitAtCreate(error, region, await boxd.machineLimit(op).catch(() => []), machines.inFlight)
    throw error
  } finally {
    release()
  }
  machines.changed.set(info.id, machines.now())
  // The id first, before any other step can fail.
  const lease = leaseAt(machines)
  const record = await patch(machines, item.workId, op, (current) => ({ ...current!, machineId: info.id, pendingCreate: undefined, ...(lease ? { lease } : {}) }) as WorkRecord)
  await recordPhase(machines, item.workId, null, "creating", op)
  return { target: boxdNamed(info, machines.now()), record, created: true, adopted: false, woke: false }
}

/** Resolves a known work's machine by its recorded id, and wakes it when it sleeps. */
async function known(machines: Machines, record: WorkRecord & { readonly region: Region; readonly machineId: MachineId }, item: EnsureItem, op: OpContext): Promise<Converged> {
  const { boxd, runner } = machines.services
  const region = record.region
  const id = record.machineId
  const checked = await runner.withMachineLock({ id }, op, async () => {
    let target: ChangeTarget
    try {
      target = await boxd.checkOwned(region, record.machine, id, op)
    } catch (error) {
      if (error instanceof BoxdError && error.details.kind === "missing") {
        throw boxdError("MACHINE_GONE", `${record.machine} was not found in ${region}. boxd_resume rebuilds it from its image and the saved transcript.`)
      }
      if (error instanceof BoxdError && error.details.kind === "elsewhere") {
        throw boxdError("NOT_OURS", `${record.machine} is not in ${region}, where this work's machine was recorded; boxd says a machine by that name is in ${String(error.details.region)}.`)
      }
      throw error
    }
    const row = (await boxd.list({ maxAgeMs: TIMEOUTS.readListingMaxAgeMs }, op)).machines.find((entry) => entry.region === region && entry.name === record.machine)
    if (row?.sharing === "shared") throw boxdError("MACHINE_SHARED", `${record.machine} in ${region} is shared with the organisation.`)
    let woke = false
    if (row && (row.status === "hibernated" || row.status === "standby" || row.status === "stopped")) {
      await checkBudget(machines, op)
      await boxd.wake(target, op)
      woke = true
    }
    // An imported work whose v0 guest still runs: its password is taken over once (§6.3).
    if (record.guestHelper === "v0") await machines.services.importV0.adopt(target, op)
    // Another size: only for an idle session, because a resize reboots.
    let resized = false
    if (item.size && item.size !== (row?.size ?? record.size)) {
      if (await sessionBusy(machines, record, target, op)) throw boxdError("SESSION_BUSY", `${record.workId}'s session is running, and a resize to ${item.size} reboots the machine.`)
      await boxd.resize(target, item.size, op)
      machines.changed.set(id, machines.now())
      resized = true
    }
    return { target, woke, resized }
  })
  // The ledger after the machine's lock is given back: work locks are always taken first (§4.1).
  let current: WorkRecord = record
  if (record.guestHelper === "v0" || checked.resized) {
    current = await patch(machines, record.workId, op, (now) => ({ ...(now ?? record), guestHelper: "v1", ...(checked.resized ? { size: item.size! } : {}) }))
  }
  return { target: checked.target, record: current, created: false, adopted: false, woke: checked.woke }
}

/** The input's settings, recorded: the default model, the git identity, the repository, the folder and the title. */
function withInput(machines: Machines, record: WorkRecord, item: EnsureItem, notify: string | undefined): WorkRecord {
  return {
    ...record,
    ...(item.model ? { model: item.model } : {}),
    ...(item.git ? { git: item.git } : record.git === undefined && machines.services.options.git ? { git: machines.services.options.git } : {}),
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

/** One work, start to finish: the result, or a coded refusal thrown. */
export async function ensureOne(machines: Machines, item: EnsureItem, context: ItemContext, call: CallContext, finishRename?: (record: WorkRecord, op: OpContext) => Promise<WorkRecord>): Promise<EnsureResult> {
  const op = opOf(call, "boxd_ensure", context.signal)
  const { ledger, hostVersion, guest } = machines.services
  let record = await ledger.get(item.workId, op)
  // A reassign that stopped half-way (this id is its `to`, or its `from`) is finished first (§3.10).
  if (record?.state === "open" && finishRename) record = await finishRename(record, op)
  const open = record?.state === "open" ? record : undefined
  const notify = call.via === "model" ? await rootSession(machines, call.sessionID) : undefined

  if (open && open.region === null) throw boxdError("MACHINE_GONE", `${open.machine} was found in no region when the v0 ledger was imported.`)
  let converged: Converged
  if (open && open.region !== null && open.machineId !== null) converged = await known(machines, open as WorkRecord & { region: Region; machineId: MachineId }, item, op)
  else {
    // No machine id yet: a new work, a create that may have landed (pendingCreate), or an imported work whose get failed.
    const made = await createOrAdopt(machines, item, context, op, open ?? undefined)
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
        next: `boxd_ensure({ workId: "${item.workId}" }): the golden image ${made.building.image} is still being built in ${made.building.region}, and the next call joins that build.`,
      }
    }
    converged = made
  }

  let record2 = await patch(machines, item.workId, op, (now) => withInput(machines, now ?? converged.record, item, notify))
  if (!converged.created) record2 = await renewLease(machines, record2, converged.target, op)
  const target = converged.target
  let rebooted = false
  let upgraded = false
  let guestVersion: string | null = null
  let state: EnsureResult["state"] = "starting"

  if (item.wait !== "none") {
    const setup = await runSetup(machines, target, record2, item, op)
    rebooted ||= setup.rebooted
    guestVersion = setup.value.opencode || null
    // A guest on another OpenCode is upgraded in place while its session is idle; the session database stays.
    if (hostVersion && guestVersion && guestVersion !== hostVersion) {
      if (!(await sessionBusy(machines, record2, target, op))) {
        const answer = await guestStep(machines, target, item, op, () => guest.upgrade(target, { version: hostVersion }, op))
        rebooted ||= answer.rebooted
        guestVersion = answer.value.opencode
        upgraded = true
      }
    }
    if (item.wait === "ready") {
      const waited = await waitReady(machines, context, target, record2, upgraded ? { ...setup.value, server: "starting" } : setup.value, item, op)
      rebooted ||= waited.rebooted
      state = waited.state
      if (waited.opencode) guestVersion = waited.opencode
    } else {
      state = setup.value.server === "up" && setup.value.workspace === "ready" ? "ready" : "starting"
    }
  }

  if (converged.created) await recordPhase(machines, item.workId, "creating", state === "ready" ? "ready" : "starting", op)
  else if (converged.woke) await recordPhase(machines, item.workId, "asleep", record2.session?.rootId ? "idle" : "ready", op)

  return {
    state,
    workId: item.workId,
    machine: target.name,
    region: target.region,
    machineId: target.machineId,
    size: record2.size,
    image: record2.image.name,
    guestVersion,
    ...(record2.model ? { model: record2.model } : {}),
    created: converged.created,
    ...(converged.adopted ? { adopted: true } : {}),
    ...(upgraded ? { upgraded: true } : {}),
    ...(rebooted ? { rebooted: true } : {}),
    next:
      state === "ready"
        ? `boxd_submit({ workId: "${item.workId}", text: "<the task>" })`
        : `boxd_ensure({ workId: "${item.workId}" }): it waits for the guest's OpenCode${item.repo ? " and the clone" : ""}, and repeats nothing.`,
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
  const settings = { ...(machines.boundMs !== undefined ? { boundMs: machines.boundMs } : {}), ...(machines.intervalMs !== undefined ? { intervalMs: machines.intervalMs } : {}), now: machines.now }
  if (input.works === undefined) {
    const item = await parseItem(input, services, "ready")
    await services.ledger.ready(opOf(call, "boxd_ensure"))
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
  await services.ledger.ready(opOf(call, "boxd_ensure"))
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
