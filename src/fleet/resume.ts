/**
 * `boxd_resume` (design §3.8), owned by package C1: wake a hibernated machine, or rebuild a destroyed one from its
 * image and import the saved transcript into it.
 *
 * - A reached `budget` with `action: "refuse"` answers `BUDGET_REACHED` before anything wakes or is created.
 * - **Wake:** the machine is in the work's region under its name: the name is resolved to the recorded id, and a
 *   sleeping machine is woken by id before `setup`, which would
 *   otherwise start a second server on the same port.
 * - **One machine per work:** a work whose create may have landed (no id yet) adopts the machine in its recorded region,
 *   and a rebuild claims its region in the record and creates there, adopting a machine that already holds the name.
 * - **Rebuild,** only when the machine is gone by the rule drop uses (H2): a fresh all-region listing with no
 *   `oc-<id>`, and a `get` of the recorded id that answers boxd's exact not-found words in every region. A failed read
 *   is never "gone". The new machine comes from the recorded image when it is this laptop's OpenCode's, otherwise from
 *   the current golden image for the work's size (built when it is missing), with the creation flags of §C.2. A work
 *   whose machine landed in a region is rebuilt there even when that region is outside the option `regions`, and its
 *   golden image is built there when it is missing: that is recovery, not new placement. A claim that never landed, and
 *   a work with no region, are new placement, and only allowed regions take them.
 * - **Import:** a work with saved sessions whose guest has no session (a rebuilt machine, or `SESSION_MISSING`) gets
 *   each stored export copied up with `machine cp` and imported by the helper, parents first, as one tree. The guest's
 *   OpenCode is upgraded to this laptop's first, because a transcript moves only between matching versions.
 */
import { join } from "node:path"
import { BoxdError, boxdError } from "../errors.js"
import { GUEST_HELPER_PATH, LIST_MAX_ITEMS, REGIONS, TIMEOUTS, type ChangeTarget, type Listing, type MachineInfo, type OpContext, type Owned, type Region } from "../ports.js"
import type { WorkRecord } from "../ledger/types.js"
import type { ListResult, ResumeResult } from "../results.js"
import type { CallContext } from "../call.js"
import {
  adoptAt,
  checkBudget,
  claimRegion,
  createAt,
  guestStep,
  leaseAt,
  listSettings,
  NotNow,
  opOf,
  patch,
  recordPhase,
  roomFor,
  runSetup,
  sessionState,
  waitReady,
  type Landed,
  type Machines,
} from "./ensure.js"
import { imageName, STILL_BUILDING } from "./golden.js"
import { listCall, runList, runOne, type ItemContext } from "./list.js"
import { inUseOf, pickRegion, regionsText } from "./regions.js"
import { isWarmImage } from "./warm.js"

const WORK_ID = /^[a-z][a-z0-9-]{0,24}$/
/** Where the helper's `import` reads exports from: beside the helper, under its own folder. */
const GUEST_IMPORTS = `${GUEST_HELPER_PATH.slice(0, GUEST_HELPER_PATH.lastIndexOf("/"))}/imports`

/**
 * Where the work's machine is: under its name in its recorded region (a listing up to 10 s old is enough to look), or
 * gone by the two-check rule, which only a listing taken now and a not-found `get` of the recorded id in every region
 * decide. Anything else refuses, and a failed read is never "gone". `listing` is the fresh one, for the region pick.
 */
async function locate(machines: Machines, record: WorkRecord, op: OpContext): Promise<{ readonly kind: "here"; readonly region: Region } | { readonly kind: "gone"; readonly listing: Listing; readonly asked: number }> {
  const { boxd } = machines.services
  const shown = (listing: Listing) => listing.machines.filter((row) => row.name === record.machine)
  if (record.region !== null && shown(await boxd.list({ maxAgeMs: TIMEOUTS.phaseListingMaxAgeMs }, op)).some((row) => row.region === record.region)) {
    return { kind: "here", region: record.region }
  }
  const asked = machines.now()
  const listing = await boxd.list({ maxAgeMs: 0 }, op)
  const named = shown(listing)
  if (record.region !== null && named.some((row) => row.region === record.region)) return { kind: "here", region: record.region }
  if (named.length > 0) {
    throw boxdError("NOT_OURS", `${record.machine} is in ${named.map((row) => row.region).join(" and ")}, not in ${record.region ?? "the recorded region"}; nothing was rebuilt.`)
  }
  if (record.machineId !== null) {
    for (const region of REGIONS) {
      let info: MachineInfo | undefined
      try {
        info = await boxd.get(region, record.machineId, op)
      } catch (error) {
        if (error instanceof BoxdError && error.details.kind === "missing") continue
        throw error
      }
      throw boxdError("NOT_OURS", `The recorded machine ${record.machineId} still exists in ${region}, named ${info.name}; rename it back to ${record.machine} or boxd_reassign. Nothing was rebuilt.`)
    }
  }
  return { kind: "gone", listing, asked }
}

/** Copies the saved exports up and imports them as one tree; answers the root session's id. */
async function importSaved(machines: Machines, record: WorkRecord, target: ChangeTarget, op: OpContext): Promise<string> {
  const { boxd, guest, ledger, runner } = machines.services
  const sessions = record.saved?.sessions ?? []
  const folder = ledger.workFolder(record.workId)
  return runner.withMachineLock({ id: target.machineId }, op, async () => {
    const files: string[] = []
    for (const session of sessions) {
      const guestPath = `${GUEST_IMPORTS}/${session.id}.json`
      await boxd.copyTo(target, join(folder, "exports", `${session.id}.json`), guestPath, op)
      files.push(guestPath)
    }
    return (await guest.import(target, { directory: record.guestDirectory, files }, op)).rootId
  })
}

/**
 * The machine is there: woken by its id when it sleeps, before anything
 * starts a v1 server beside it. Under the machine's lock; the ledger after it.
 */
async function wakeHere(machines: Machines, record: WorkRecord, owned: Owned, context: ItemContext, op: OpContext): Promise<{ readonly target: ChangeTarget; readonly record: WorkRecord; readonly woke: boolean }> {
  const { boxd, runner } = machines.services
  const target = owned.target
  const woke = await runner.withMachineLock({ id: target.machineId }, op, async () => {
    let woken = false
    if (sleeping(owned.status)) {
      roomFor(context, TIMEOUTS.helperChange, "starting", "there is not enough time left in this call to wake the machine")
      await boxd.wake(target, op)
      woken = true
    }
    return woken
  })
  const current =
    record.slept || record.machineId !== target.machineId
      ? await patch(machines, record.workId, op, (now) => {
          const { slept: _awake, pendingCreate: _landed, ...rest } = now ?? record
          return { ...rest, region: target.region, machineId: target.machineId } as WorkRecord
        })
      : record
  return { target, record: current, woke }
}

const sleeping = (status: string) => status === "hibernated" || status === "standby" || status === "stopped"

/** A record's claimed region never hosted a machine, and it is outside the option `regions`: placement is refused. */
function refuseClaim(region: Region, allowed: readonly Region[]): never {
  throw boxdError("REGION_NOT_ALLOWED", `This work's record claims region "${region}", where no machine landed, and the plugin option "regions" allows only ${regionsText(allowed)}; nothing was created. Add "${region}" to "regions" and call again.`, {
    region,
    allowed,
  })
}

/** Creates the work's machine again, in its region (or the picked one), from the right image. */
async function rebuild(
  machines: Machines,
  record: WorkRecord,
  gone: { readonly listing: Listing; readonly asked: number },
  context: ItemContext,
  op: OpContext,
): Promise<{ readonly target: ChangeTarget; readonly record: WorkRecord; readonly landed: Landed } | { readonly building: string }> {
  const { boxd, options, hostVersion } = machines.services
  const current = imageName(options.goldenPrefix, hostVersion, record.size)
  const snapshots = await machines.golden.images(op)
  const used = inUseOf(gone.listing.machines, gone.asked)
  const allowed = options.regions
  const claimed = record.region
  // A work whose machine landed somewhere is rebuilt in its own region, even outside the allowlist: the option pins new
  // placement, and a resume restores a work that already lives there. A claim that never landed is placement, refused
  // outside the allowlist; a work with no region at all picks among the allowed ones.
  const want =
    claimed !== null && (record.machineId !== null || allowed.includes(claimed))
      ? claimed
      : claimed !== null
        ? refuseClaim(claimed, allowed)
        : pickRegion({
            choice: options.region,
            limits: (await boxd.machineLimit(op)).regions,
            keepFree: options.keepFree,
            inFlight: machines.inFlight,
            used,
            withImage: new Set(REGIONS.filter((where) => allowed.includes(where) && snapshots.some((row) => row.region === where && row.name === current))),
            allowed,
          })
  // The recorded image only while it is this laptop's OpenCode's: the transcript must import into the same version.
  const recorded = record.image.opencode === hostVersion && snapshots.some((row) => row.region === want && row.name === record.image.name)
  let image = recorded ? record.image.name : current
  // A picked region is reserved at once, and claimed in the record before anything is built or created, so a second
  // call makes no second machine.
  let reserved: ((landed: boolean) => void) | undefined = record.region === null ? machines.inFlight.reserve(want) : undefined
  let landed: Landed
  let region: Region
  try {
    const claim = await claimRegion(machines, record.workId, want, (where) => ({ ...record, region: where }), image, op)
    region = claim.region
    if (region !== want) {
      reserved?.(false)
      reserved = undefined
    }
    // A warm image is never built here. A concurrent claim can land in another region than the one whose warm image was
    // recorded, and then the work falls back to the version's image, as ensure does.
    if (isWarmImage(options.goldenPrefix, image) && !snapshots.some((row) => row.region === region && row.name === image)) image = current
    if (!snapshots.some((row) => row.region === region && row.name === image)) {
      // A landed work is rebuilt in its own region even outside the allowlist: building the image there is part of that
      // recovery, not new placement. A claim that never landed was refused above, before anything was claimed here.
      if (options.buildGolden === "never") {
        throw boxdError("GOLDEN_MISSING", `No golden image ${image} in ${region}, where this work was recorded, and buildGolden is "never". Set it to "auto" so a resume builds the image there, or add "${region}" to "regions" and build it with boxd_golden({ region: "${region}", size: "${record.size}" }).`, {
          region,
          size: record.size,
        })
      }
      const built = await context.waiting(() => machines.golden.build({ region, size: record.size, base: options.goldenBase, name: image }, { signal: context.signal, until: context.deadline }))
      if (built === STILL_BUILDING) return { building: image }
    }
    landed = await createAt(machines, { workId: record.workId, region, image, adopt: false, used, recordedId: record.machineId, ...(reserved ? { reserved } : {}) }, context, op)
  } finally {
    reserved?.(false)
  }
  const lease = landed.created ? leaseAt(machines) : undefined
  // The new id at once; the session is imported next, so the old root is cleared until it is.
  const next = await patch(machines, record.workId, op, (now) => {
    const base = now ?? record
    const { pendingCreate: _created, slept: _slept, warm: wasWarm, ...rest } = base
    // A rebuild from the version's image is no longer a warm one; its record says so from now on.
    const warm = landed.created ? isWarmImage(options.goldenPrefix, image) : wasWarm === true
    return {
      ...rest,
      region,
      machineId: landed.info.id,
      ...(landed.created ? { image: { name: image, opencode: hostVersion }, session: base.session?.notify ? { notify: base.session.notify } : {} } : {}),
      ...(warm ? { warm: true } : {}),
      ...(lease ? { lease } : {}),
    } as WorkRecord
  })
  return { target: landed.owned.target, record: next, landed }
}

export async function resumeOne(machines: Machines, workId: string, context: ItemContext, call: CallContext): Promise<ResumeResult> {
  const { ledger, boxd, guest, hostVersion } = machines.services
  const op = opOf(call, "boxd_resume", context.signal)
  const record = await ledger.get(workId, op)
  if (record?.state !== "open") throw boxdError("NOT_OURS", `No open work has the id "${workId}".`)
  await checkBudget(machines, op)
  const pending = (why: string): ResumeResult => ({
    state: "starting",
    workId,
    machine: record.machine,
    region: record.region,
    rebuilt: false,
    next: `boxd_resume({ workId: "${workId}" }): ${why}; it repeats nothing that was done.`,
  })

  try {
    const located = await locate(machines, record, op)
    let target: ChangeTarget
    let current = record
    let rebuilt = false
    let woke = false
    if (located.kind === "here") {
      // By its recorded id; a work with no id yet (a create that may have landed) adopts the machine there, by its labels.
      const owned =
        record.machineId !== null
          ? await boxd.checkOwned(located.region, record.machine, record.machineId, op)
          : (await adoptAt(machines, { workId, region: located.region, adopt: false }, op))?.owned
      if (!owned) throw boxdError("BOXD_FAILED", `${record.machine} left ${located.region} while it was being resumed.`)
      const here = await wakeHere(machines, record, owned, context, op)
      target = here.target
      current = here.record
      woke = here.woke
    } else {
      const made = await rebuild(machines, record, located, context, op)
      if ("building" in made) return pending(`the golden image ${made.building} is still being built, and the next call joins that build`)
      if (made.landed.created) {
        target = made.target
        current = made.record
        rebuilt = true
      } else {
        // The create found the machine already there (it landed after the listing): it is woken and taken over as found.
        const here = await wakeHere(machines, made.record, made.landed.owned, context, op)
        target = here.target
        current = here.record
        woke = here.woke
      }
    }

    const input = { workId, repair: false }
    roomFor(context, TIMEOUTS.setup, "starting", `there is not enough time left in this call for setup (${TIMEOUTS.setup / 1000} s)`)
    const setup = await runSetup(machines, target, current, input, op)
    let ready = await waitReady(machines, context, target, current, setup.value, input, op)
    let state = ready.state
    let why = `it waits for the guest's OpenCode${(current.saved?.sessions.length ?? 0) > 0 ? ", then imports the saved transcript" : ""}`
    if (state === "ready" && (current.saved?.sessions.length ?? 0) > 0) {
      const session = await sessionState(machines, current, target, op)
      if (session === "unknown") {
        state = "starting"
        why = "the guest's session could not be read yet"
      } else if (session === "none" || session === "missing") {
        // A transcript moves only between matching versions: the guest is brought to this laptop's OpenCode first.
        if (hostVersion && ready.opencode && ready.opencode !== hostVersion) {
          roomFor(context, TIMEOUTS.upgrade, "starting", `there is not enough time left in this call to upgrade the guest's OpenCode (${TIMEOUTS.upgrade / 1000} s)`)
          await guestStep(machines, target, input, op, () => guest.upgrade(target, { version: hostVersion }, op))
          ready = await waitReady(machines, context, target, current, { server: "starting", opencode: hostVersion, workspace: "ready", helperUploaded: false }, input, op)
          state = ready.state
        }
        if (state === "ready") {
          roomFor(context, TIMEOUTS.cp + TIMEOUTS.helperChange, "starting", "there is not enough time left in this call to import the saved transcript")
          const rootId = await importSaved(machines, current, target, op)
          current = await patch(machines, workId, op, (now) => ({ ...(now ?? current), session: { ...(now ?? current).session, rootId } }))
        }
      }
    }
    const warm = current.warm === true
    const readySeconds =
      current.tracked === true && current.readyAt !== undefined ? Math.max(0, Math.round((Date.parse(current.readyAt) - Date.parse(current.createdAt)) / 1000)) : undefined
    const facts = { warm, ...(readySeconds !== undefined ? { readySeconds } : {}) }
    if (rebuilt) await recordPhase(machines, workId, "gone", current.session?.rootId ? "idle" : "ready", op, current.session?.rootId ? { warm } : facts)
    else if (woke) await recordPhase(machines, workId, "asleep", current.session?.rootId ? "idle" : "ready", op, current.session?.rootId ? { warm } : facts)
    await patch(machines, workId, op, (now) => ({ ...(now ?? current), touchedAt: new Date(machines.now()).toISOString() }))

    return {
      state,
      workId,
      machine: target.name,
      region: target.region,
      rebuilt,
      next:
        state === "ready"
          ? `boxd_submit({ workId: "${workId}", text: "<${current.session?.rootId ? "the next task" : "the task"}>" })`
          : `boxd_resume({ workId: "${workId}" }): ${why}; it repeats nothing that was done.`,
    }
  } catch (error) {
    if (error instanceof NotNow) return pending(error.why)
    throw error
  }
}

/** `boxd_resume`: one work, or many (a bare work id or `{ workId }` per item). */
export async function runResume(machines: Machines, input: Record<string, unknown>, call: CallContext): Promise<ResumeResult | ListResult<ResumeResult>> {
  const settings = listSettings(machines)
  const idOf = (value: unknown, field: string): string => {
    const id = typeof value === "string" ? value : value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => key === "workId") ? (value as { workId?: unknown }).workId : undefined
    if (typeof id !== "string" || !WORK_ID.test(id)) throw boxdError("NAME_INVALID", `${field} must be a work id, or { workId }.`, { field })
    return id
  }
  for (const key of Object.keys(input)) if (key !== "workId" && key !== "works") throw boxdError("NAME_INVALID", `${key} is not an input of boxd_resume.`, { field: key })
  if (input.works === undefined) {
    const workId = idOf(input.workId, "workId")
    return runOne({ signal: call.signal, ...settings }, (context) => resumeOne(machines, workId, context, call))
  }
  if (!Array.isArray(input.works) || input.works.length < 1 || input.works.length > LIST_MAX_ITEMS) throw boxdError("NAME_INVALID", `works must be a list of 1 to ${LIST_MAX_ITEMS} work ids.`, { field: "works" })
  const ids = input.works.map((value, index) => idOf(value, `works[${index}]`))
  const duplicate = ids.findIndex((id, index) => ids.indexOf(id) !== index)
  if (duplicate !== -1) throw boxdError("NAME_INVALID", `works[${duplicate}] "${ids[duplicate]}" appears twice; name each work once.`, { field: `works[${duplicate}]` })
  return runList(
    ids,
    { signal: call.signal, ...settings, workId: (id) => id, success: (result) => result.state === "ready", pendingStates: ["starting"], again: (pending) => listCall("boxd_resume", pending, "ids") },
    (id, context) => resumeOne(machines, id, context, call),
  )
}
