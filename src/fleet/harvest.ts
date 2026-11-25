/**
 * `boxd_harvest` (design §3.6): bring a work's transcript and files to this laptop.
 *
 * 1. The session must be idle, or `partial: true` (a copy now, which leaves `saved` stale). The guest helper's `export`
 *    checks that in its own exec and answers `busy` having written nothing, so a harvest makes no read exec first.
 * 2. `export` writes each session of the tree to a file on the guest and reports its size, sha256 and marks (last
 *    message id, message count, `time.updated`) and the root's last run; the laptop never parses a transcript (F8).
 * 3. A file the call asks for lands only inside a root, through no symlink, checked before any copy (`PATH_REFUSED`).
 * 4. Each file is copied by `machine cp` into a staged temp file beside the stored one, and committed only when its
 *    size and streamed sha256 match the helper's report: the last good export is never overwritten before the new one
 *    is verified (round 2, M-a). The same for `patch.diff` and the `untracked/` set, which is swapped in whole.
 * 5. The laptop's copy is replaced through the laptop port (`src/prover.ts`): delete, then import, parents first (F1).
 * 6. `saved` is recorded last, under the work's lock, so `boxd_resume` always rebuilds from a complete, verified set.
 *
 * The whole call holds the work's ledger lock, and the guest steps hold the machine's lock inside it (design §2.2).
 * Package C2 owns this file.
 */
import { randomBytes } from "node:crypto"
import { mkdir, stat, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { BoxdError, boxdError, inField } from "../errors.js"
import type { GitState, MovedFile, SavedSession, WorkRecord } from "../ledger/types.js"
import { replaceOnLaptop } from "../prover.js"
import { assertInsideRoots, assertWorkPath, digestFile, FILE_LIMIT, placeFile, resolveLaptopPath, rootsOf, TOTAL_LIMIT } from "../paths.js"
import type { ChangeTarget, ExportAnswer, GitAnswer, OpContext, Owned, RunOutcome, StagedFile, StagedFolder } from "../ports.js"
import type { HarvestResult } from "../results.js"
import {
  asleep,
  assertWorkIdInput,
  checkStop,
  machineOf,
  nowIso,
  omit,
  openRecord,
  optionalBoolean,
  optionalString,
  untilRunning,
  withoutWarning,
  withTarget,
  type WorkContext,
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
      throw boxdError("PATH_REFUSED", `files[${index}] "${path}" is not a path inside the work tree: relative, with no "..".`, { field: `files[${index}]` })
    }
  })
  if (new Set(files).size !== files.length) throw boxdError("NAME_INVALID", "files names a path twice.", { field: "files" })
  const to = optionalString(input.to, "to")
  const localDirectory = optionalString(input.localDirectory, "localDirectory")
  return { workId, files, partial: optionalBoolean(input.partial, "partial") ?? false, ...(to ? { to } : {}), ...(localDirectory ? { localDirectory } : {}) }
}

type Exported = Extract<ExportAnswer, { readonly outcome: "exported" }>

/** What the guest steps leave for the laptop steps, all staged and nothing committed yet. */
interface Fetched {
  readonly outcome: RunOutcome | null
  readonly error?: string
  readonly exported?: Exported
  readonly exports: ReadonlyArray<{ readonly staged: StagedFile; readonly bytes: number; readonly sha256: string }>
  readonly git: GitAnswer
  readonly patch?: { readonly staged: StagedFile; readonly bytes: number; readonly sha256: string }
  readonly untracked?: { readonly staged: StagedFolder; readonly expected: Record<string, { readonly bytes: number; readonly sha256: string }> }
  readonly files: ReadonlyArray<{ readonly path: string; readonly temp: string; readonly laptopPath: string }>
}

export async function harvestWork(services: Services, item: HarvestItem, context: WorkContext): Promise<HarvestResult> {
  const { op } = context
  let fileError: BoxdError | undefined
  const result = await services.ledger.update(
    [item.workId],
    async (current) => {
      const record = openRecord(current.get(item.workId), item.workId)
      const roots = [...rootsOf(services.projectDirectory, services.options.allowedRoots), record.laptopDirectory]
      const localDirectory = await inField("localDirectory", () => folder(item.localDirectory ?? record.laptopDirectory, roots, false))
      const toDirectory = item.to ? await inField("to", () => folder(item.to!, roots, true)) : localDirectory
      // Every file's laptop destination is checked before anything is copied: inside a root, through no symlink.
      const destinations = await Promise.all(item.files.map((path, index) => inField(`files[${index}]`, () => destination(toDirectory, path, roots))))
      const machine = await machineOf(services, record, op)
      const startedAt = nowIso(services)
      const staged: Array<StagedFile | StagedFolder> = []
      const temps: string[] = []
      try {
        const fetched = await withTarget(services, record, machine, op, (owned) => fetch(services, record, item, owned, destinations, roots, staged, temps, op))
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
          await replaceOnLaptop(
            services.laptop,
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

/**
 * The guest steps, under the machine's lock: a wake when needed, the export (which checks the tree is idle in the same
 * exec), git, and every copy into staged files. Nothing here commits.
 */
async function fetch(
  services: Services,
  record: WorkRecord,
  item: HarvestItem,
  { target, status }: Owned,
  destinations: readonly string[],
  roots: readonly string[],
  staged: Array<StagedFile | StagedFolder>,
  temps: string[],
  op: OpContext,
): Promise<Fetched> {
  if (asleep(status)) {
    // A harvest is a change: it wakes the machine, and waits until boxd lists it running (L-5).
    await services.boxd.wake(target, op)
    await untilRunning(services, target, op)
  }
  const rootId = record.session?.rootId
  let outcome: RunOutcome | null = record.run?.outcome ?? null
  let error: string | undefined = record.run?.error
  let exported: Exported | undefined
  const exports: Array<{ staged: StagedFile; bytes: number; sha256: string }> = []
  if (rootId) {
    const answer = await services.guest.export(target, { rootId, ...(item.partial ? { partial: true } : {}) }, op)
    if (answer.outcome === "busy") throw boxdError("SESSION_BUSY", `The session on ${record.machine} is still running (${answer.reason}).`)
    exported = answer
    if (services.hostVersion !== null && exported.guestVersion !== services.hostVersion) {
      throw boxdError("GUEST_VERSION", `The guest runs OpenCode ${exported.guestVersion || "of an unknown version"} and this laptop runs ${services.hostVersion}, so the transcript was not moved.`)
    }
    // A partial export of a running tree reports the run before this one: the record keeps its own then.
    if (!exported.busy) {
      outcome = exported.run.outcome
      error = exported.run.error
    }
    for (const session of exported.sessions) {
      const file = await services.ledger.stageFile(record.workId, `exports/${session.id}.json`, op)
      staged.push(file)
      await copy(services, target, session.file, file.path, op)
      exports.push({ staged: file, bytes: session.bytes, sha256: session.sha256 })
    }
  }
  const git = await gitFacts(services, target, record, op)
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
  for (const [index, path] of item.files.entries()) {
    const laptopPath = destinations[index]!
    // The folder is made, then checked again: a symlink put in its way since the first check is refused here.
    await mkdir(dirname(laptopPath), { recursive: true, mode: 0o700 })
    await inField(`files[${index}]`, () => assertInsideRoots(dirname(laptopPath), roots))
    const temp = `${laptopPath}.${randomBytes(6).toString("hex")}.tmp`
    temps.push(temp)
    await copy(services, target, `${record.guestDirectory}/${path}`, temp, op)
    files.push({ path, temp, laptopPath })
  }
  return { outcome, ...(error ? { error } : {}), ...(exported ? { exported } : {}), exports, git, ...(patch ? { patch } : {}), ...(untracked ? { untracked } : {}), files }
}

/** No git facts: the guest folder is not the top of its own repository. A harvest records that and saves the rest. */
const NO_GIT: GitAnswer = { known: false, remote: null, branch: null, sha: null, dirty: false, untracked: [], ignored: [], unpushed: [], unpushedCount: 0, unpushedKnown: true }

/**
 * The tree's git facts. They are optional to a harvest, never a reason to skip the transcript: a folder that is not the
 * top of its own repository (`GIT_UNKNOWN`) is recorded as `known: false`, which drop then refuses.
 */
async function gitFacts(services: Services, target: ChangeTarget, record: WorkRecord, op: OpContext): Promise<GitAnswer> {
  try {
    return await services.guest.git(target, { directory: record.guestDirectory }, op)
  } catch (error) {
    if (error instanceof BoxdError && error.code === "GIT_UNKNOWN") return NO_GIT
    throw error
  }
}

/**
 * Where a requested file lands on the laptop: `<to>/<path>`, resolved against the roots as a path that may not exist
 * yet. A symlinked folder on the way that leads out of every root, or a symlink at the file itself, is `PATH_REFUSED`.
 */
async function destination(toDirectory: string, path: string, roots: readonly string[]): Promise<string> {
  if (!COPYABLE.test(path)) throw boxdError("PATH_REFUSED", `"${path}" has a character machine cp cannot carry.`)
  return resolveLaptopPath(join(toDirectory, path), roots, { create: true })
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
export function parentsFirst(exported: Exported): Exported["sessions"] {
  const ids = new Set(exported.sessions.map((session) => session.id))
  if (ids.size !== exported.sessions.length) throw boxdError("EXPORT_INVALID", "The export names a session twice.")
  const done = new Set<string>()
  const ordered: Array<Exported["sessions"][number]> = []
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
  // A partial harvest is a copy, never saved; and a tree that was running when it was exported is never complete.
  const complete = !item.partial && !fetched.exported?.busy
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
  // The laptop's copy is replaced and verified only when a transcript was exported.
  const base = omit(record, "warnings")
  const next: WorkRecord = {
    ...base,
    machineId,
    saved: { at: startedAt, complete, guestVersion: fetched.exported?.guestVersion ?? record.saved?.guestVersion ?? services.hostVersion ?? "", sessions },
    gitState,
    touchedAt: at,
    ...(fetched.outcome ? { run: { outcome: fetched.outcome, ...(fetched.error ? { error: fetched.error } : {}), at: record.run?.outcome === fetched.outcome && record.run.error === fetched.error ? record.run.at : at } } : {}),
    ...(warnings?.length ? { warnings } : {}),
    ...(moved.length ? { files: { in: record.files?.in ?? [], out } } : {}),
  }
  const storedFiles = new Map(out.map((file) => [file.path, file.sha256]))
  const value: HarvestResult = {
    state: complete ? "saved" : "partial",
    workId: record.workId,
    outcome: fetched.outcome,
    sessions: sessions.map((session) => ({ id: session.id, bytes: session.bytes })),
    git: { known: gitState.known, dirty: gitState.dirty, patchStored: gitState.patchStored, untracked: gitState.untracked.length, ignored: gitState.ignored.length, unpushed: fetched.git.unpushedKnown ? fetched.git.unpushedCount : null },
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
  if (!git.unpushedKnown) {
    return `The guest could not tell whether every commit is on a remote ref, so boxd_drop refuses: run the check with boxd_exec({ workId: "${workId}", command: ["git", "rev-list", "--count", "--all", "HEAD", "--not", "--remotes"] }) and push whatever it counts, then boxd_drop(${call}).`
  }
  if (git.unpushedCount > 0) {
    return `The guest has ${git.unpushedCount} commit${git.unpushedCount === 1 ? "" : "s"} on a local branch, tag, stash or detached HEAD that no remote ref contains, and a harvest stores no commits, so boxd_drop refuses: push them with boxd_exec({ workId: "${workId}", command: ["sh", "-c", "git push --all origin && git push --tags origin"] }), then boxd_drop(${call}).`
  }
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
