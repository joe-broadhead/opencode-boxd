/**
 * `boxd_harvest` (design §3.6): bring a work's transcript and files to this laptop.
 *
 * 1. The session must be idle, or `partial: true` (a copy now, which leaves `saved` stale).
 * 2. The guest helper's `export` writes each session of the tree to a file on the guest and reports its size, sha256
 *    and marks (last message id, message count, `time.updated`); the laptop never parses a transcript (F8).
 * 3. Each file is copied by `machine cp` into a staged temp file beside the stored one, and committed only when its
 *    size and streamed sha256 match the helper's report: the last good export is never overwritten before the new one
 *    is verified (round 2, M-a). The same for `patch.diff` and the `untracked/` set, which is swapped in whole.
 * 4. The laptop's copy is replaced through the prover (`src/prover.ts`): delete, then import, parents first (F1).
 * 5. `saved` is recorded last, under the work's lock, so `boxd_resume` always rebuilds from a complete, verified set.
 *
 * The whole call holds the work's ledger lock, and the guest steps hold the machine's lock inside it (design §2.2).
 * Package C2 owns this file.
 */
import { randomBytes } from "node:crypto"
import { mkdir, stat, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { BoxdError, boxdError, inField } from "../errors.js"
import type { GitState, MovedFile, SavedSession, WorkRecord } from "../ledger/types.js"
import { laptopProver } from "../prover.js"
import { assertWorkPath, digestFile, FILE_LIMIT, placeFile, resolveLaptopPath, rootsOf, TOTAL_LIMIT } from "../paths.js"
import { type ChangeTarget, type ExportAnswer, type GitAnswer, type OpContext, type ReadTarget, type RunOutcome, type StagedFile, type StagedFolder } from "../ports.js"
import type { HarvestResult } from "../results.js"
import {
  adoptIfV0,
  assertWorkIdInput,
  checkStop,
  listed,
  machineOf,
  nowIso,
  omit,
  openRecord,
  optionalBoolean,
  optionalString,
  withoutWarning,
  withTarget,
  type ItemContext,
  type Services,
} from "./sessions-common.js"

/** The most untracked files one harvest stores: each is one `machine cp`. The rest keep drop refusing `UNTRACKED`. */
export const UNTRACKED_STORE_LIMIT = 100
/** A guest path `machine cp` takes: absolute, no spaces. */
const COPYABLE = /^[A-Za-z0-9_./-]+$/

export interface HarvestItem {
  readonly workId: string
  readonly files: readonly string[]
  readonly to?: string
  readonly localDirectory?: string
  readonly partial: boolean
}

export function checkHarvest(input: Record<string, unknown>): HarvestItem {
  const workId = assertWorkIdInput(input.workId)
  if (input.files !== undefined && (!Array.isArray(input.files) || !input.files.every((path) => typeof path === "string"))) {
    throw boxdError("NAME_INVALID", "files must be a list of paths inside the work tree.", { field: "files" })
  }
  const files = ((input.files as string[] | undefined) ?? []).map((path, index) => {
    try {
      return assertWorkPath(path)
    } catch {
      throw boxdError("NAME_INVALID", `files[${index}] "${path}" is not a path inside the work tree.`, { field: `files[${index}]` })
    }
  })
  if (new Set(files).size !== files.length) throw boxdError("NAME_INVALID", "files names a path twice.", { field: "files" })
  const to = optionalString(input.to, "to")
  const localDirectory = optionalString(input.localDirectory, "localDirectory")
  return { workId, files, partial: optionalBoolean(input.partial, "partial") ?? false, ...(to ? { to } : {}), ...(localDirectory ? { localDirectory } : {}) }
}

/** What the guest steps leave for the laptop steps, all staged and nothing committed yet. */
interface Fetched {
  readonly outcome: RunOutcome | null
  readonly error?: string
  readonly exported?: ExportAnswer
  readonly exports: ReadonlyArray<{ readonly staged: StagedFile; readonly bytes: number; readonly sha256: string }>
  readonly git: GitAnswer
  readonly patch?: { readonly staged: StagedFile; readonly bytes: number; readonly sha256: string }
  readonly untracked?: { readonly staged: StagedFolder; readonly expected: Record<string, { readonly bytes: number; readonly sha256: string }> }
  readonly files: ReadonlyArray<{ readonly path: string; readonly temp: string; readonly laptopPath: string }>
  readonly adopted: boolean
}

export async function harvestWork(services: Services, item: HarvestItem, context: ItemContext): Promise<HarvestResult> {
  const { op } = context
  const prover = laptopProver((request) => services.runner.spawn(request), services.opencodeBin)
  let fileError: BoxdError | undefined
  const result = await services.ledger.update(
    [item.workId],
    async (current) => {
      const record = openRecord(current.get(item.workId), item.workId)
      const roots = [...rootsOf(services.projectDirectory, services.options.allowedRoots), record.laptopDirectory]
      const localDirectory = await inField("localDirectory", () => folder(item.localDirectory ?? record.laptopDirectory, roots, false))
      const toDirectory = item.to ? await inField("to", () => folder(item.to!, roots, true)) : localDirectory
      const machine = await machineOf(services, record, op)
      const startedAt = nowIso(services)
      const staged: Array<StagedFile | StagedFolder> = []
      const temps: string[] = []
      try {
        const fetched = await withTarget(services, record, machine, op, (target) => fetch(services, record, item, target, toDirectory, staged, temps, op))
        checkStop(op.signal, true)
        // Every file of the tree is checked before the first one is swapped in, so a bad copy replaces nothing; each
        // commit checks again, and `saved` moves only after the last one.
        for (const file of [...fetched.exports, ...(fetched.patch ? [fetched.patch] : [])]) {
          const digest = await digestFile(file.staged.path)
          if (digest.bytes !== file.bytes || digest.sha256 !== file.sha256) {
            throw boxdError("EXPORT_INVALID", `${file.staged.final} came back as ${digest.bytes} bytes with another digest than the guest reported, so nothing stored was replaced.`)
          }
        }
        for (const file of fetched.exports) await services.ledger.commitFile(file.staged, file, op)
        if (fetched.patch) await services.ledger.commitFile(fetched.patch.staged, fetched.patch, op)
        if (fetched.untracked) await services.ledger.commitFolder(fetched.untracked.staged, fetched.untracked.expected, op)
        staged.length = 0
        // The laptop's own OpenCode: each session replaced, parents first (F1). A failure keeps the stored files.
        if (fetched.exported) {
          const folderOf = services.ledger.workFolder(record.workId)
          await prover.replace(
            parentsFirst(fetched.exported).map((session) => ({ id: session.id, file: join(folderOf, "exports", `${session.id}.json`) })),
            localDirectory,
            op,
          )
        }
        const at = nowIso(services)
        const moved: MovedFile[] = []
        for (const file of fetched.files) {
          const previous = record.files?.out.find((out) => out.path === file.path)?.sha256
          try {
            const digest = await placeFile(file.temp, file.laptopPath, previous)
            moved.push({ path: file.path, bytes: digest.bytes, sha256: digest.sha256, at, laptopPath: file.laptopPath })
          } catch (error) {
            // The transcript is saved whatever happens to a file; the first refused file is the call's answer.
            if (!(error instanceof BoxdError)) throw error
            fileError ??= new BoxdError(error.code, `The transcript and git state were saved, but ${error.what.charAt(0).toLowerCase()}${error.what.slice(1)}`, error.details)
          }
        }
        temps.length = 0
        return written(services, record, item, fetched, moved, machine.machineId, startedAt)
      } finally {
        for (const entry of staged) await services.ledger.discard(entry)
        for (const temp of temps) await removeQuietly(temp)
      }
    },
    op,
  )
  if (fileError) throw fileError
  return result
}

/** The guest steps, under the machine's lock: the idle check, the export, git, and every copy into staged files. */
async function fetch(
  services: Services,
  record: WorkRecord,
  item: HarvestItem,
  target: ChangeTarget,
  toDirectory: string,
  staged: Array<StagedFile | StagedFolder>,
  temps: string[],
  op: OpContext,
): Promise<Fetched> {
  const adopted = await adoptIfV0(services, record, target, op)
  const rootId = record.session?.rootId
  let outcome: RunOutcome | null = record.run?.outcome ?? null
  let error: string | undefined = record.run?.error
  if (rootId && !item.partial) {
    const phase = await services.guest.phase(await readable(services, target, op), { sessionId: rootId }, op)
    if (phase.phase === "busy") throw boxdError("SESSION_BUSY", `The session on ${record.machine} is still running.`)
    if (phase.phase === "missing") throw boxdError("SESSION_MISSING", `The guest has no session ${rootId}.`)
    outcome = phase.outcome
    error = phase.error
  }
  let exported: ExportAnswer | undefined
  const exports: Array<{ staged: StagedFile; bytes: number; sha256: string }> = []
  if (rootId) {
    exported = await services.guest.export(target, { rootId }, op)
    if (services.hostVersion !== null && exported.guestVersion !== services.hostVersion) {
      throw boxdError("GUEST_VERSION", `The guest runs OpenCode ${exported.guestVersion || "of an unknown version"} and this laptop runs ${services.hostVersion}, so the transcript was not moved.`)
    }
    for (const session of exported.sessions) {
      const file = await services.ledger.stageFile(record.workId, `exports/${session.id}.json`, op)
      staged.push(file)
      await copy(services, target, session.file, file.path, op)
      exports.push({ staged: file, bytes: session.bytes, sha256: session.sha256 })
    }
  }
  const git = await services.guest.git(target, { directory: record.guestDirectory }, op)
  let patch: Fetched["patch"]
  if (git.patch) {
    const file = await services.ledger.stageFile(record.workId, "patch.diff", op)
    staged.push(file)
    await copy(services, target, git.patch.file, file.path, op)
    patch = { staged: file, bytes: git.patch.bytes, sha256: git.patch.sha256 }
  }
  let untracked: Fetched["untracked"]
  const storable = storableUntracked(git)
  if (storable.length || record.gitState?.untrackedStored) {
    const set = await services.ledger.stageFolder(record.workId, "untracked", op)
    staged.push(set)
    const expected: Record<string, { bytes: number; sha256: string }> = {}
    for (const file of storable) {
      const local = join(set.path, file.path)
      await mkdir(dirname(local), { recursive: true, mode: 0o700 })
      await copy(services, target, `${record.guestDirectory}/${file.path}`, local, op)
      expected[file.path] = { bytes: file.bytes, sha256: file.sha256 }
    }
    untracked = { staged: set, expected }
  }
  const files: Array<{ path: string; temp: string; laptopPath: string }> = []
  for (const path of item.files) {
    if (!COPYABLE.test(path)) throw boxdError("NAME_INVALID", `files: "${path}" has a character machine cp cannot carry.`, { field: "files" })
    const laptopPath = join(toDirectory, path)
    await mkdir(dirname(laptopPath), { recursive: true, mode: 0o700 })
    const temp = `${laptopPath}.${randomBytes(6).toString("hex")}.tmp`
    temps.push(temp)
    await copy(services, target, `${record.guestDirectory}/${path}`, temp, op)
    files.push({ path, temp, laptopPath })
  }
  return { outcome, ...(error ? { error } : {}), ...(exported ? { exported } : {}), exports, git, ...(patch ? { patch } : {}), ...(untracked ? { untracked } : {}), files, adopted }
}

/**
 * The phase read's target: the machine as a listing at most 2 s old shows it (the read rule). A hibernated machine is
 * woken first, under the lock this call holds; a harvest is a change.
 */
async function readable(services: Services, target: ChangeTarget, op: OpContext): Promise<ReadTarget> {
  let { listing, row } = await listed(services, target.region, target.name, op)
  const status = row?.status
  if (status === "hibernated" || status === "standby" || status === "stopped") {
    await services.boxd.wake(target, op)
    listing = await services.boxd.list({ maxAgeMs: 0 }, op)
  }
  return { region: target.region, name: target.name, listing, machineId: target.machineId }
}

/** A `machine cp` from the guest into a staged laptop file; a cut-off or timed-out copy is the harvest's failure. */
async function copy(services: Services, target: ChangeTarget, guestPath: string, localPath: string, op: OpContext): Promise<void> {
  try {
    await services.boxd.copyFrom(target, guestPath, localPath, op)
  } catch (error) {
    if (error instanceof BoxdError && error.code === "BOXD_FAILED") throw boxdError("EXPORT_INVALID", `A copy from ${target.name} failed, so nothing stored was replaced (${error.what})`)
    throw error
  }
}

/** The untracked files a harvest stores: regular files with a digest, within the size limits and the count. */
export function storableUntracked(git: GitAnswer): ReadonlyArray<{ readonly path: string; readonly bytes: number; readonly sha256: string }> {
  const chosen: Array<{ path: string; bytes: number; sha256: string }> = []
  let total = 0
  for (const file of git.untracked) {
    if (chosen.length >= UNTRACKED_STORE_LIMIT) break
    if (file.sha256 === "" || file.bytes > FILE_LIMIT || total + file.bytes > TOTAL_LIMIT || !COPYABLE.test(file.path)) continue
    chosen.push(file)
    total += file.bytes
  }
  return chosen
}

/** The sessions of an export in an order where every parent comes before its children; a cycle is `EXPORT_INVALID`. */
export function parentsFirst(exported: ExportAnswer): ExportAnswer["sessions"] {
  const ids = new Set(exported.sessions.map((session) => session.id))
  if (ids.size !== exported.sessions.length) throw boxdError("EXPORT_INVALID", "The export names a session twice.")
  const done = new Set<string>()
  const ordered: Array<ExportAnswer["sessions"][number]> = []
  while (ordered.length < exported.sessions.length) {
    const ready = exported.sessions.filter((session) => !done.has(session.id) && (session.parentId === null || !ids.has(session.parentId) || done.has(session.parentId)))
    if (!ready.length) throw boxdError("EXPORT_INVALID", "The exported session tree has a cycle.")
    for (const session of ready) {
      done.add(session.id)
      ordered.push(session)
    }
  }
  return ordered
}

/** The record after a harvest, and the answer. */
function written(
  services: Services,
  record: WorkRecord,
  item: HarvestItem,
  fetched: Fetched,
  moved: readonly MovedFile[],
  machineId: NonNullable<WorkRecord["machineId"]>,
  startedAt: string,
): { write: WorkRecord[]; value: HarvestResult } {
  const at = nowIso(services)
  const complete = !item.partial
  const sessions: SavedSession[] = (fetched.exported?.sessions ?? []).map((session) => ({
    id: session.id,
    parentId: session.parentId,
    sha256: session.sha256,
    bytes: session.bytes,
    lastMessageId: session.lastMessageId,
    messages: session.messages,
    updated: session.updated,
  }))
  const gitState: GitState = {
    known: fetched.git.known,
    remote: fetched.git.remote,
    branch: fetched.git.branch,
    sha: fetched.git.sha,
    dirty: fetched.git.dirty,
    patchStored: Boolean(fetched.patch),
    untracked: fetched.git.untracked.map((file) => file.path),
    ignored: fetched.git.ignored.map((file) => file.path),
    untrackedStored: Boolean(fetched.untracked && Object.keys(fetched.untracked.expected).length),
  }
  const warnings = complete ? withoutWarning(record.warnings, "UNHARVESTED_SLEEP") : record.warnings
  const out = [...(record.files?.out ?? []).filter((file) => !moved.some((item) => item.path === file.path)), ...moved]
  const base = omit(record, "laptopCopy", "warnings")
  const next: WorkRecord = {
    ...base,
    machineId,
    saved: { at: startedAt, complete, guestVersion: fetched.exported?.guestVersion ?? record.saved?.guestVersion ?? services.hostVersion ?? "", sessions },
    gitState,
    touchedAt: at,
    ...(fetched.outcome ? { run: { outcome: fetched.outcome, ...(fetched.error ? { error: fetched.error } : {}), at: record.run?.outcome === fetched.outcome && record.run.error === fetched.error ? record.run.at : at } } : {}),
    ...(warnings?.length ? { warnings } : {}),
    ...(moved.length ? { files: { in: record.files?.in ?? [], out } } : {}),
    ...(fetched.adopted ? { guestHelper: "v1" as const } : {}),
  }
  const storedFiles = new Map(out.map((file) => [file.path, file.sha256]))
  const value: HarvestResult = {
    state: complete ? "saved" : "partial",
    workId: record.workId,
    outcome: fetched.outcome,
    sessions: sessions.map((session) => ({ id: session.id, bytes: session.bytes })),
    git: { known: gitState.known, dirty: gitState.dirty, patchStored: gitState.patchStored, untracked: gitState.untracked.length, ignored: gitState.ignored.length },
    ...(moved.length ? { files: moved.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256, laptopPath: file.laptopPath! })) } : {}),
    next: dropAdvice(record.workId, complete, fetched.git, fetched.untracked?.expected ?? {}, storedFiles, Boolean(fetched.patch)),
  }
  return { write: [next], value }
}

/** What drop will do with this work now: the guard drop itself applies, said ahead (design §3.6 result `next`). */
function dropAdvice(
  workId: string,
  complete: boolean,
  git: GitAnswer,
  stored: Readonly<Record<string, { readonly sha256: string }>>,
  files: ReadonlyMap<string, string>,
  patchStored: boolean,
): string {
  const call = `{ workId: "${workId}" }`
  if (!complete) return `This is a partial copy, so boxd_drop refuses. Once the session is idle: boxd_harvest(${call}).`
  if (!git.known) return `The guest folder is not a git repository, so boxd_drop refuses. boxd_sleep(${call}) keeps it at the cost of its disk.`
  const harvested = (file: { path: string; sha256: string }) => file.sha256 !== "" && (stored[file.path]?.sha256 === file.sha256 || files.get(file.path) === file.sha256)
  const lost = [...git.untracked, ...git.ignored].filter((file) => !harvested(file)).map((file) => file.path)
  if (lost.length) {
    const named = lost.slice(0, 10).join(", ") + (lost.length > 10 ? ` and ${lost.length - 10} more` : "")
    return `boxd_drop refuses while ${named} ${lost.length === 1 ? "is" : "are"} not harvested: pass them in files, or delete them on the machine, then boxd_harvest(${call}) again.`
  }
  if (git.dirty && !patchStored) return `The uncommitted work has no patch on this laptop, so boxd_drop refuses: boxd_harvest(${call}) again.`
  return `Saved. boxd_sleep(${call}) hibernates it; boxd_drop(${call}) destroys it, keeping everything on this laptop.`
}

/** A laptop folder inside a root: `create` makes it when it does not exist yet. */
async function folder(path: string, roots: readonly string[], create: boolean): Promise<string> {
  const real = await resolveLaptopPath(path, roots, { create })
  if (create) await mkdir(real, { recursive: true, mode: 0o700 })
  const info = await stat(real)
  if (!info.isDirectory()) throw boxdError("NAME_INVALID", `"${path}" is not a folder.`)
  return real
}

const removeQuietly = (path: string) => unlink(path).catch(() => undefined)
