/**
 * `boxd_reassign` (design §3.10), owned by package C1: move an unstarted work's machine to another work id, so capacity
 * at the limit is reused without a destroy and a create.
 *
 * Refused (`NOT_REASSIGNABLE`) unless `from` has no session, no uploaded files and a clean or absent git tree, and `to`
 * is not an open work. Then, in this order, so a crash anywhere leaves a state the next call finishes:
 *
 * 1. `to` is written with `pendingRename: { from, machineId }` (under both work locks, in sorted id order);
 * 2. under the machine's lock, `oc-<from>` is checked to still have the recorded id, renamed to `oc-<to>` by id (a
 *    reboot), and labelled `work=<to>` by id;
 * 3. `from` is closed (`how: "reassigned"`, `to`) and `to`'s `pendingRename` cleared, under both work locks;
 * 4. `ensure`'s setup and wait run for `to`.
 *
 * Before step 1, a fresh all-region listing must not show `oc-<to>` anywhere (`NOT_REASSIGNABLE`). If boxd still refuses
 * the rename because the name was taken meanwhile, `to`'s pending record is closed again (rolled back, its machine
 * staying `from`'s) and the call answers `NOT_REASSIGNABLE`, so neither work is left waiting on a rename that cannot be
 * made.
 *
 * The next `ensure` or `reassign` of either id finishes a rename that stopped between 1 and 3 (`finishRename`): it reads
 * the machine by its id, renames it if it still has the old name, labels it, and closes `from`.
 */
import { BoxdError, boxdError } from "../errors.js"
import type { MachineId, MachineName, OpContext, Region } from "../ports.js"
import type { WorkRecord } from "../ledger/types.js"
import type { ReassignResult } from "../results.js"
import type { CallContext } from "../call.js"
import { carriesLabels, ensureOne, listSettings, missingLabels, newRecord, opOf, parseItem, recordPhase, type Machines } from "./ensure.js"
import { runOne } from "./list.js"

const WORK_ID = /^[a-z][a-z0-9-]{0,24}$/
const KEYS = new Set(["from", "to", "directory", "repo", "ref", "model", "git", "title"])

const notReassignable = (message: string) => boxdError("NOT_REASSIGNABLE", message)
/** boxd's refusal of a rename to a name that is taken in that region. */
const TAKEN = /\balready exists\b/i

/** Closes `to`'s record again when its rename cannot be made: its machine stays `from`'s, and nothing waits on it. */
async function rollBack(machines: Machines, from: string, to: string, machineId: MachineId, op: OpContext): Promise<void> {
  const at = new Date(machines.now()).toISOString()
  await machines.services.ledger.update(
    [from, to],
    async (current) => {
      const target = current.get(to)
      if (target?.state !== "open" || target.pendingRename?.machineId !== machineId) return { write: [], value: undefined }
      const { pendingRename: _undone, ...rest } = target
      return { write: [{ ...rest, state: "closed", closed: { at, how: "reassigned", to: from } } as WorkRecord], value: undefined }
    },
    op,
  )
}

/** Steps 2 and 3 for one rename: by the machine's id, from whatever name it has now. */
async function completeRename(machines: Machines, region: Region, from: string, to: string, machineId: MachineId, op: OpContext): Promise<void> {
  const { boxd, runner, ledger } = machines.services
  const fromName = `oc-${from}` as MachineName
  const toName = `oc-${to}` as MachineName
  const renamed = await runner.withMachineLock({ id: machineId }, op, async () => {
    const info = await boxd.get(region, machineId, op)
    if (info.name === fromName) {
      const { target } = await boxd.checkOwned(region, fromName, machineId, op)
      try {
        await boxd.rename(target, toName, op)
      } catch (error) {
        if (error instanceof BoxdError && TAKEN.test(error.what)) return false
        throw error
      }
      // A rename reboots: the VM agent rule may reboot it once more if the agent stays silent.
      machines.changed.set(machineId, machines.now())
    } else if (info.name !== toName) {
      throw boxdError("NOT_OURS", `Machine ${machineId} in ${region} is now named ${info.name}, neither ${fromName} nor ${toName}; nothing was renamed.`)
    }
    const labels = missingLabels(info.labels, to, await ledger.id(op))
    if (Object.keys(labels).length > 0) await boxd.setLabels((await boxd.checkOwned(region, toName, machineId, op)).target, labels, op)
    return true
  })
  if (!renamed) {
    await rollBack(machines, from, to, machineId, op)
    throw notReassignable(`${toName} is taken in ${region}, so ${fromName} could not be renamed; "${from}" keeps its machine, and nothing was changed.`)
  }
  const at = new Date(machines.now()).toISOString()
  await ledger.update(
    [from, to],
    async (current) => {
      const write: WorkRecord[] = []
      const source = current.get(from)
      if (source?.state === "open" && source.machineId === machineId) write.push({ ...source, state: "closed", closed: { at, how: "reassigned", to } })
      const target = current.get(to)
      if (target?.state === "open" && target.pendingRename?.machineId === machineId) {
        const { pendingRename: _done, ...rest } = target
        write.push(rest as WorkRecord)
      }
      return { write, value: undefined }
    },
    op,
  )
  await recordPhase(machines, from, "ready", "closed", op)
}

/**
 * Finishes a reassign that stopped half-way, when `record` is its `to` (it has `pendingRename`) or its `from` (another
 * open work names it). Answers the record as it is afterwards: `from` closed and `to` open on its machine, or, when the
 * rename was rolled back because the name is taken, `to` closed and `from` as it was before the reassign.
 */
export async function finishRename(machines: Machines, record: WorkRecord, op: OpContext): Promise<WorkRecord> {
  const { ledger } = machines.services
  const pending = record.pendingRename && record.region ? record : (await ledger.list({}, op)).find((other) => other.pendingRename?.from === record.workId && other.region)
  if (!pending?.pendingRename || !pending.region) return record
  try {
    await completeRename(machines, pending.region, pending.pendingRename.from, pending.workId, pending.pendingRename.machineId, op)
  } catch (error) {
    // A rename that cannot be made was rolled back: the records are as they were before the reassign.
    if (!(error instanceof BoxdError) || error.code !== "NOT_REASSIGNABLE") throw error
  }
  return (await ledger.get(record.workId, op)) ?? record
}

export async function runReassign(machines: Machines, input: Record<string, unknown>, call: CallContext): Promise<ReassignResult> {
  const { ledger, boxd, guest, runner } = machines.services
  for (const key of Object.keys(input)) if (!KEYS.has(key)) throw boxdError("NAME_INVALID", `${key} is not an input of boxd_reassign.`, { field: key })
  for (const key of ["from", "to"] as const) {
    if (typeof input[key] !== "string" || !WORK_ID.test(input[key] as string)) throw boxdError("NAME_INVALID", `${key} must be a short lowercase work id.`, { field: key })
  }
  const from = input.from as string
  const to = input.to as string
  if (from === to) throw boxdError("NAME_INVALID", "from and to must be two different work ids.", { field: "to" })
  const { from: _from, to: _to, ...rest } = input
  const item = await parseItem({ ...rest, workId: to }, machines.services, "ready")
  const op = opOf(call, "boxd_reassign")

  return runOne({ signal: call.signal, ...listSettings(machines) }, async (context) => {
    const itemOp: OpContext = { ...op, signal: context.signal }
    let source = await ledger.get(from, itemOp)
    if (source?.state === "open") source = await finishRename(machines, source, itemOp)
    if (source?.state !== "open") throw boxdError("NOT_OURS", `No open work has the id "${from}".`)
    const existing = await ledger.get(to, itemOp)
    if (existing?.state === "open") throw notReassignable(`"${to}" is an open work; reassign to a new id.`)
    if (source.region === null || source.machineId === null) throw notReassignable(`"${from}" has no recorded machine id to move.`)
    if (source.session?.rootId || source.lastSubmit) throw notReassignable(`"${from}" has a session: its machine holds work that a harvest and a drop must settle first.`)
    if (source.files?.in.length) throw notReassignable(`"${from}" has uploaded files on its machine.`)
    const region = source.region
    const machineId = source.machineId

    // The tree must be clean or absent: one git read, as a change under the machine's lock.
    // The new name must be free in every region, in a listing taken now.
    const listing = await boxd.list({ maxAgeMs: 0 }, itemOp)
    const holder = listing.machines.find((row) => row.name === `oc-${to}`)
    if (holder) throw notReassignable(`oc-${to} already exists in ${holder.region}; reassign to an id whose machine name is free.`)
    await runner.withMachineLock({ id: machineId }, itemOp, async () => {
      const { target } = await boxd.checkOwned(region, source!.machine, machineId, itemOp)
      const info = listing.machines.find((row) => row.region === region && row.name === source!.machine)
      if (info && !carriesLabels(info.labels, from)) throw boxdError("NOT_OURS", `${source!.machine} in ${region} no longer carries this plugin's labels for "${from}".`)
      const git = await guest.git(target, { directory: source!.guestDirectory }, itemOp)
      if (git.known && (git.dirty || git.untracked.length > 0)) throw notReassignable(`"${from}"'s tree has ${git.dirty ? "uncommitted changes" : `${git.untracked.length} untracked paths`}.`)
    })

    // Step 1: `to` first, with the rename it waits for, under both work locks.
    const at = new Date(machines.now()).toISOString()
    await ledger.update(
      [from, to],
      async (current) => {
        const now = current.get(from)
        if (now?.state !== "open" || now.machineId !== machineId || now.session?.rootId) throw notReassignable(`"${from}" changed while it was being reassigned.`)
        if (current.get(to)?.state === "open") throw notReassignable(`"${to}" became an open work meanwhile.`)
        const fresh = newRecord(machines, {
          workId: to,
          region,
          size: now.size,
          image: now.image.name,
          laptopDirectory: item.directory ?? now.laptopDirectory,
          ...(item.repo ? { repo: item.repo } : now.repo ? { repo: now.repo } : {}),
          ...(item.git ? { git: item.git } : now.git ? { git: now.git } : {}),
          ...(now.env ? { env: now.env } : {}),
          ...(item.model ? { model: item.model } : {}),
          ...(item.title ? { title: item.title } : {}),
        })
        const record: WorkRecord = {
          ...fresh,
          image: now.image,
          machineId,
          ...(now.lease ? { lease: now.lease } : {}),
          pendingRename: { from, machineId, at },
        }
        return { write: [record], value: undefined }
      },
      itemOp,
    )
    // Steps 2 and 3, then step 4: ensure's setup and wait for the new id.
    await completeRename(machines, region, from, to, machineId, itemOp)
    const result = await ensureOne(machines, { ...item, wait: "ready", repair: false, adopt: false }, context, call)
    return { ...result, from }
  })
}
