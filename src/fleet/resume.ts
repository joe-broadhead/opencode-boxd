/**
 * `boxd_resume` (design §3.8), owned by package C1: wake a hibernated machine, or rebuild a destroyed one from its
 * image and import the saved transcript into it.
 *
 * - A reached `budget` with `action: "refuse"` answers `BUDGET_REACHED` before anything wakes or is created.
 * - **Wake:** the machine is in the work's region under its name: the name is resolved to the recorded id, and a
 *   sleeping machine is woken by id.
 * - **Rebuild,** only when the machine is gone by the rule drop uses (H2): a fresh all-region listing with no
 *   `oc-<id>`, and a `get` of the recorded id that answers boxd's exact not-found words in every region. A failed read
 *   is never "gone". The new machine comes from the recorded image when it is this laptop's OpenCode's, otherwise from
 *   the current golden image for the work's size (built when it is missing), with the creation flags of §C.2.
 * - **Import:** a work with saved sessions whose guest has no session (a rebuilt machine, or `SESSION_MISSING`) gets
 *   each stored export copied up with `machine cp` and imported by the helper, parents first, as one tree. The guest's
 *   OpenCode is upgraded to this laptop's first, because a transcript moves only between matching versions.
 */
import { join } from "node:path"
import { BoxdError, boxdError } from "../errors.js"
import { GUEST_HELPER_PATH, LIST_MAX_ITEMS, REGIONS, TIMEOUTS, type ChangeTarget, type MachineInfo, type MachineName, type OpContext, type Region } from "../ports.js"
import type { WorkRecord } from "../ledger/types.js"
import type { ListResult, ResumeResult } from "../results.js"
import type { CallContext } from "../tools.js"
import {
  boxdNamed,
  checkBudget,
  guestStep,
  leaseAt,
  opOf,
  patch,
  readTarget,
  recordPhase,
  runSetup,
  waitReady,
  type Machines,
} from "./ensure.js"
import { imageName, STILL_BUILDING } from "./golden.js"
import { listCall, runList, runOne, type ItemContext } from "./list.js"
import { limitAtCreate, pickRegion } from "./regions.js"

const WORK_ID = /^[a-z][a-z0-9-]{0,24}$/
/** Where the helper's `import` reads exports from: beside the helper, under its own folder. */
const GUEST_IMPORTS = `${GUEST_HELPER_PATH.slice(0, GUEST_HELPER_PATH.lastIndexOf("/"))}/imports`

type Located = { readonly kind: "here"; readonly region: Region } | { readonly kind: "gone" }

/** Where the work's machine is: under its name in its region, or gone by the two-check rule. Anything else refuses. */
async function locate(machines: Machines, record: WorkRecord, op: OpContext): Promise<Located> {
  const { boxd } = machines.services
  const listing = await boxd.list({ maxAgeMs: 0 }, op)
  const named = listing.machines.filter((row) => row.name === record.machine)
  if (record.region !== null && named.some((row) => row.region === record.region)) return { kind: "here", region: record.region }
  if (named.length > 0) {
    throw boxdError("NOT_OURS", `${record.machine} is in ${named.map((row) => row.region).join(" and ")}, not in ${record.region ?? "the recorded region"}; nothing was rebuilt.`)
  }
  if (record.machineId !== null) {
    for (const region of REGIONS) {
      try {
        const info = await boxd.get(region, record.machineId, op)
        throw boxdError("NOT_OURS", `The recorded machine ${record.machineId} still exists in ${region}, named ${info.name}; rename it back to ${record.machine} or boxd_reassign. Nothing was rebuilt.`)
      } catch (error) {
        if (error instanceof BoxdError && error.details.kind === "missing") continue
        throw error
      }
    }
  }
  return { kind: "gone" }
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

/** Whether the guest lost the work's session: one phase read, on a listing at most 2 s old. */
async function sessionMissing(machines: Machines, record: WorkRecord, target: ChangeTarget, op: OpContext): Promise<boolean> {
  const sessionId = record.session?.rootId
  if (!sessionId) return true
  try {
    const answer = await machines.services.guest.phase(await readTarget(machines, target.region, target.name, target.machineId, op), { sessionId }, op)
    return answer.phase === "missing"
  } catch (error) {
    if (error instanceof BoxdError && error.code === "SESSION_MISSING") return true
    throw error
  }
}

/** Creates the work's machine again, in its region (or the picked one), from the right image. */
async function rebuild(machines: Machines, record: WorkRecord, context: ItemContext, op: OpContext): Promise<{ readonly target: ChangeTarget; readonly record: WorkRecord } | { readonly building: string }> {
  const { boxd, options, runner, hostVersion } = machines.services
  const name = record.machine as MachineName
  const current = imageName(options.goldenPrefix, hostVersion, record.size)
  const snapshots = await machines.golden.images(op)
  const region =
    record.region ??
    pickRegion({
      choice: options.region,
      limits: await boxd.machineLimit(op),
      keepFree: options.keepFree,
      inFlight: machines.inFlight,
      withImage: new Set(REGIONS.filter((where) => snapshots.some((row) => row.region === where && row.name === current))),
    })
  // The recorded image only while it is this laptop's OpenCode's: the transcript must import into the same version.
  const recorded = record.image.opencode === hostVersion && snapshots.some((row) => row.region === region && row.name === record.image.name)
  const image = recorded ? record.image.name : current
  if (!snapshots.some((row) => row.region === region && row.name === image)) {
    if (options.buildGolden === "never") throw boxdError("GOLDEN_MISSING", `No golden image ${image} in ${region}, and buildGolden is "never".`)
    const built = await context.waiting(() => machines.golden.build({ region, size: record.size, base: options.goldenBase, name: image }, { signal: context.signal, until: context.deadline }))
    if (built === STILL_BUILDING) return { building: image }
  }
  await patch(machines, record.workId, op, (now) => ({ ...(now ?? record), region, pendingCreate: { at: new Date(machines.now()).toISOString(), image } }))
  const release = machines.inFlight.reserve(region)
  let info: MachineInfo
  try {
    const lease = options.leaseDays > 0 ? options.leaseDays : undefined
    info = await runner.withMachineLock({ create: { region, name } }, op, () =>
      boxd.create({ kind: "work", region, name, workId: record.workId, image, autoSuspendSeconds: 0, autoHibernateSeconds: options.autoHibernateMinutes * 60, ...(lease ? { leaseDays: lease } : {}) }, op),
    )
  } catch (error) {
    if (error instanceof BoxdError && error.code === "MACHINE_LIMIT") throw limitAtCreate(error, region, await boxd.machineLimit(op).catch(() => []), machines.inFlight)
    throw error
  } finally {
    release()
  }
  machines.changed.set(info.id, machines.now())
  const lease = leaseAt(machines)
  // The new id at once; the session is imported next, so the old root is cleared until it is.
  const next = await patch(machines, record.workId, op, (now) => {
    const base = now ?? record
    const { pendingCreate: _created, slept: _slept, ...rest } = base
    return {
      ...rest,
      region,
      machineId: info.id,
      image: { name: image, opencode: hostVersion },
      guestHelper: "v1",
      session: base.session?.notify ? { notify: base.session.notify } : {},
      ...(lease ? { lease } : {}),
    } as WorkRecord
  })
  return { target: boxdNamed(info, machines.now()), record: next }
}

export async function resumeOne(machines: Machines, workId: string, context: ItemContext, call: CallContext): Promise<ResumeResult> {
  const { ledger, boxd, runner, guest, hostVersion } = machines.services
  const op = opOf(call, "boxd_resume", context.signal)
  const record = await ledger.get(workId, op)
  if (record?.state !== "open") throw boxdError("NOT_OURS", `No open work has the id "${workId}".`)
  await checkBudget(machines, op)

  const located = await locate(machines, record, op)
  let target: ChangeTarget
  let current = record
  let rebuilt = false
  let woke = false
  if (located.kind === "here" && record.machineId !== null) {
    const machineId = record.machineId
    target = await runner.withMachineLock({ id: machineId }, op, async () => {
      const checked = await boxd.checkOwned(located.region, record.machine, machineId, op)
      const row = (await boxd.list({ maxAgeMs: TIMEOUTS.readListingMaxAgeMs }, op)).machines.find((entry) => entry.region === located.region && entry.name === record.machine)
      if (row && (row.status === "hibernated" || row.status === "standby" || row.status === "stopped")) {
        await boxd.wake(checked, op)
        woke = true
      }
      return checked
    })
    if (current.slept) current = await patch(machines, workId, op, (now) => ({ ...(now ?? current), slept: undefined }) as WorkRecord)
  } else if (located.kind === "here") {
    throw boxdError("NOT_OURS", `${record.machine} exists in ${located.region}, but this work has no recorded machine id; boxd_ensure({ workId: "${workId}", adopt: true }) takes it over.`)
  } else {
    const made = await rebuild(machines, record, context, op)
    if ("building" in made) {
      return {
        state: "starting",
        workId,
        machine: record.machine,
        region: record.region,
        rebuilt: false,
        next: `boxd_resume({ workId: "${workId}" }): the golden image ${made.building} is still being built, and the next call joins that build.`,
      }
    }
    target = made.target
    current = made.record
    rebuilt = true
  }

  const input = { workId, repair: false }
  const setup = await runSetup(machines, target, current, input, op)
  let ready = await waitReady(machines, context, target, current, setup.value, input, op)
  let state = ready.state
  if (state === "ready" && (current.saved?.sessions.length ?? 0) > 0 && (await sessionMissing(machines, current, target, op))) {
    // A transcript moves only between matching versions: the guest is brought to this laptop's OpenCode first.
    if (hostVersion && ready.opencode && ready.opencode !== hostVersion) {
      await guestStep(machines, target, input, op, () => guest.upgrade(target, { version: hostVersion }, op))
      ready = await waitReady(machines, context, target, current, { server: "starting", opencode: hostVersion, workspace: "ready", helperUploaded: false }, input, op)
      state = ready.state
    }
    if (state === "ready") {
      const rootId = await importSaved(machines, current, target, op)
      current = await patch(machines, workId, op, (now) => ({ ...(now ?? current), session: { ...(now ?? current).session, rootId } }))
    }
  }
  if (rebuilt) await recordPhase(machines, workId, "gone", current.session?.rootId ? "idle" : "ready", op)
  else if (woke) await recordPhase(machines, workId, "asleep", current.session?.rootId ? "idle" : "ready", op)
  await patch(machines, workId, op, (now) => ({ ...(now ?? current), touchedAt: new Date(machines.now()).toISOString() }))

  return {
    state,
    workId,
    machine: target.name,
    region: target.region,
    rebuilt,
    next:
      state === "ready"
        ? current.session?.rootId
          ? `boxd_submit({ workId: "${workId}", text: "<the next task>" })`
          : `boxd_submit({ workId: "${workId}", text: "<the task>" })`
        : `boxd_resume({ workId: "${workId}" }): it waits for the guest's OpenCode${(current.saved?.sessions.length ?? 0) > 0 ? ", then imports the saved transcript" : ""}, and repeats nothing.`,
  }
}

/** `boxd_resume`: one work, or many (a bare work id or `{ workId }` per item). */
export async function runResume(machines: Machines, input: Record<string, unknown>, call: CallContext): Promise<ResumeResult | ListResult<ResumeResult>> {
  const settings = { ...(machines.boundMs !== undefined ? { boundMs: machines.boundMs } : {}), ...(machines.intervalMs !== undefined ? { intervalMs: machines.intervalMs } : {}), now: machines.now }
  const idOf = (value: unknown, field: string): string => {
    const id = typeof value === "string" ? value : value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => key === "workId") ? (value as { workId?: unknown }).workId : undefined
    if (typeof id !== "string" || !WORK_ID.test(id)) throw boxdError("NAME_INVALID", `${field} must be a work id, or { workId }.`, { field })
    return id
  }
  for (const key of Object.keys(input)) if (key !== "workId" && key !== "works") throw boxdError("NAME_INVALID", `${key} is not an input of boxd_resume.`, { field: key })
  if (input.works === undefined) {
    const workId = idOf(input.workId, "workId")
    await machines.services.ledger.ready(opOf(call, "boxd_resume"))
    return runOne({ signal: call.signal, ...settings }, (context) => resumeOne(machines, workId, context, call))
  }
  if (!Array.isArray(input.works) || input.works.length < 1 || input.works.length > LIST_MAX_ITEMS) throw boxdError("NAME_INVALID", `works must be a list of 1 to ${LIST_MAX_ITEMS} work ids.`, { field: "works" })
  const ids = input.works.map((value, index) => idOf(value, `works[${index}]`))
  const duplicate = ids.findIndex((id, index) => ids.indexOf(id) !== index)
  if (duplicate !== -1) throw boxdError("NAME_INVALID", `works[${duplicate}] "${ids[duplicate]}" appears twice; name each work once.`, { field: `works[${duplicate}]` })
  await machines.services.ledger.ready(opOf(call, "boxd_resume"))
  return runList(
    ids,
    { signal: call.signal, ...settings, workId: (id) => id, success: (result) => result.state === "ready", pendingStates: ["starting"], again: (pending) => listCall("boxd_resume", pending, "ids") },
    (id, context) => resumeOne(machines, id, context, call),
  )
}
