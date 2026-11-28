/**
 * The ledger's durable copy on a registry machine (boxd-plugin#129): `oc-reg-<ledgerId>`, labelled `owner=boxd`,
 * `role=registry` and `ledger=<id>`, made on first need in the region of the ledger's first work, with scheduled disk
 * backups every 24 hours and boxd's own auto-hibernate left on.
 *
 * The watcher's sweep calls `sync`: it copies the `ledger-id` file, every work record, every stored export, the patch
 * and each `untracked/` set whose digest changed, and never a lock, a temp file, `index.json` or `events.jsonl`. A file
 * is copied whole over its old copy, and an `untracked/` set moves only after all of its files arrived, so a failed
 * copy leaves the last good copy as it was. No tool call waits for the copy.
 */
import { createHash, randomBytes } from "node:crypto"
import { lstat, readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { digestFile, errnoOf, exists, remove, writeJsonAtomic, type Digest } from "../ledger/fsx.js"
import { LEDGER_PATHS, WORK_FILES } from "../ledger/types.js"
import type { WorkRecord } from "../ledger/types.js"
import { REGISTRY_LABELS, REGISTRY_PREFIX, TIMEOUTS, type ChangeTarget, type MachineId, type MachineName, type MachineRow, type OpContext, type Region } from "../ports.js"
import type { RegistryStatus } from "../results.js"
import type { CoreServices } from "../services.js"

/** The registry's folder on its machine: one folder per ledger id, mirroring the laptop's ledger root below it. */
export const REGISTRY_HOME = "/home/boxd/.boxd-plugin/registry"
/** The registry machine's scheduled disk backups. */
export const REGISTRY_BACKUPS = "24h"
/** A complete copy older than one sweep says so in status; the watcher sweeps every minute. */
export const REGISTRY_LAG_MS = 60_000
/** The local cache of what the registry holds; not part of the ledger itself. */
const STATE_FILE = "registry.json"
const STATE_FORMAT = 1
const WORK_ID = /^[a-z][a-z0-9-]{0,24}$/
const EXPORT = /^ses_[A-Za-z0-9_-]{1,80}\.json$/

interface FileStamp extends Digest {
  /** A folder is moved only after every file in it arrived. */
  readonly folder?: true
}

interface CopyState {
  readonly format: typeof STATE_FORMAT
  readonly ledgerId: string
  readonly machine: { readonly name: MachineName; readonly region: Region; readonly id: MachineId }
  /** Whether `backups.period` was already set on this machine. */
  readonly configured: boolean
  lastCopyAt?: string
  works: readonly string[]
  files: Readonly<Record<string, FileStamp>>
  failure?: { readonly at: string; readonly reason: string }
}

/** One local file or folder the registry holds, and where it is on this laptop. */
interface Entry {
  readonly key: string
  readonly source: string
  readonly stamp: FileStamp
}

export interface Registry {
  /** One copy attempt: ensure the machine, then copy whatever changed. Never throws. */
  sync(context: OpContext): Promise<void>
  /** What status shows, or undefined until the first attempt. */
  status(): RegistryStatus | undefined
}

type RegistryCore = Pick<CoreServices, "ledger" | "boxd" | "runner" | "clock" | "ledgerRoot" | "report">

const reasonOf = (error: unknown) => (error instanceof Error ? (error.message.split("\n")[0] ?? error.message).slice(0, 200) : String(error).slice(0, 200))

const stampEqual = (left: FileStamp | undefined, right: FileStamp) => left !== undefined && left.bytes === right.bytes && left.sha256 === right.sha256 && left.folder === right.folder

/** A single-quoted shell word for a path the plugin itself made (absolute, no spaces, no quotes). */
const shell = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`

/** boxd exec starts in /home/boxd: a path under it is relative there, which the fake CLI's guest disk also understands. */
const inHome = (path: string) => (path.startsWith("/home/boxd/") ? path.slice("/home/boxd/".length) : path)

export function createRegistry(core: RegistryCore): Registry {
  let state: CopyState | undefined
  let loaded = false
  let startedAt: number | undefined
  let running: Promise<void> | undefined

  const now = () => core.clock.now()
  const statePath = () => join(core.ledgerRoot, STATE_FILE)
  const remoteRoot = (ledgerId: string) => `${REGISTRY_HOME}/${ledgerId}`

  async function load(): Promise<void> {
    if (loaded) return
    loaded = true
    try {
      const parsed = JSON.parse(await readFile(statePath(), "utf8")) as Partial<CopyState>
      if (
        parsed.format === STATE_FORMAT &&
        typeof parsed.ledgerId === "string" &&
        parsed.machine &&
        typeof parsed.machine.name === "string" &&
        typeof parsed.machine.region === "string" &&
        typeof parsed.machine.id === "string"
      ) {
        state = {
          format: STATE_FORMAT,
          ledgerId: parsed.ledgerId,
          machine: { name: parsed.machine.name, region: parsed.machine.region, id: parsed.machine.id },
          configured: parsed.configured === true,
          ...(typeof parsed.lastCopyAt === "string" ? { lastCopyAt: parsed.lastCopyAt } : {}),
          works: Array.isArray(parsed.works) ? parsed.works.filter((id): id is string => typeof id === "string" && WORK_ID.test(id)) : [],
          files: parsed.files && typeof parsed.files === "object" ? (parsed.files as Record<string, FileStamp>) : {},
          ...(parsed.failure && typeof parsed.failure.at === "string" && typeof parsed.failure.reason === "string" ? { failure: parsed.failure } : {}),
        }
      }
    } catch (error) {
      if (errnoOf(error) !== "ENOENT") core.report("registry", `The registry's local state could not be read: ${reasonOf(error)}.`)
    }
  }

  async function save(): Promise<void> {
    if (!state) return
    await writeJsonAtomic(statePath(), state)
  }

  /** The region of the ledger's first work: the oldest record that names one. */
  function firstRegion(records: readonly WorkRecord[]): { readonly region: Region; readonly workId: string } | undefined {
    const sorted = [...records].sort((left, right) => {
      const at = Date.parse(left.createdAt)
      const other = Date.parse(right.createdAt)
      return (Number.isNaN(at) ? Number.MAX_SAFE_INTEGER : at) - (Number.isNaN(other) ? Number.MAX_SAFE_INTEGER : other) || left.workId.localeCompare(right.workId)
    })
    const first = sorted.find((record) => record.region !== null)
    return first?.region ? { region: first.region, workId: first.workId } : undefined
  }

  /** The listing row of this ledger's registry, by its name and its labels. */
  function rowOf(machines: readonly MachineRow[], ledgerId: string): MachineRow | undefined {
    const name = `${REGISTRY_PREFIX}${ledgerId}`
    return machines.find((machine) => machine.name === name && machine.labels.role === REGISTRY_LABELS.role && machine.labels.ledger === ledgerId)
  }

  /** The registry machine, adopted when it exists and made in the first work's region when it does not. */
  async function ensureMachine(region: Region, ledgerId: string, context: OpContext): Promise<{ readonly target: ChangeTarget; readonly configured: boolean }> {
    const name = `${REGISTRY_PREFIX}${ledgerId}` as MachineName
    const listing = await core.boxd.list({ maxAgeMs: TIMEOUTS.phaseListingMaxAgeMs }, context)
    const row = rowOf(listing.machines, ledgerId)
    if (row) {
      const info = await core.boxd.get(row.region, row.name, context)
      if (info.name !== name || info.labels.role !== REGISTRY_LABELS.role || info.labels.ledger !== ledgerId) {
        throw new Error(`The machine named ${name} in ${row.region} is not this ledger's registry.`)
      }
      const owned = await core.boxd.checkOwned(row.region, name, info.id, context)
      return { target: owned.target, configured: state?.machine.id === info.id && state.configured }
    }
    const created = await core.runner.withMachineLock({ create: { region, name } }, context, () => core.boxd.create({ kind: "registry", region, name, ledger: ledgerId }, context))
    return { target: created.owned.target, configured: false }
  }

  /** Sets the backup schedule once per machine; a failed setting is retried by the next sweep. */
  async function configure(target: ChangeTarget, already: boolean, context: OpContext): Promise<boolean> {
    if (already) return true
    await core.runner.withMachineLock({ id: target.machineId }, context, () => core.boxd.setBackups(target, REGISTRY_BACKUPS, context))
    return true
  }

  /** Every ledger file the copy holds: the id, records, exports, patches and each untracked set. */
  async function entries(): Promise<Entry[]> {
    const found: Entry[] = []
    const add = async (key: string, source: string): Promise<boolean> => {
      try {
        const stamp = await digestFile(source)
        found.push({ key, source, stamp })
        return true
      } catch (error) {
        if (errnoOf(error) === "ENOENT") return false
        throw error
      }
    }
    await add("ledger-id", join(core.ledgerRoot, LEDGER_PATHS.id))
    let names: string[] = []
    try {
      names = await readdir(join(core.ledgerRoot, LEDGER_PATHS.works))
    } catch (error) {
      if (errnoOf(error) !== "ENOENT") throw error
    }
    for (const workId of names.filter((name) => WORK_ID.test(name)).sort()) {
      const folder = join(core.ledgerRoot, LEDGER_PATHS.works, workId)
      await add(`v1/works/${workId}/${WORK_FILES.record}`, join(folder, WORK_FILES.record))
      let exports: string[] = []
      try {
        exports = await readdir(join(folder, WORK_FILES.exports))
      } catch (error) {
        if (errnoOf(error) !== "ENOENT" && errnoOf(error) !== "ENOTDIR") throw error
      }
      for (const name of exports.filter((file) => EXPORT.test(file)).sort()) {
        await add(`v1/works/${workId}/${WORK_FILES.exports}/${name}`, join(folder, WORK_FILES.exports, name))
      }
      await add(`v1/works/${workId}/${WORK_FILES.patch}`, join(folder, WORK_FILES.patch))
      const untracked = await folderEntry(workId, join(folder, WORK_FILES.untracked))
      if (untracked) found.push(untracked)
    }
    return found.sort((left, right) => left.key.localeCompare(right.key))
  }

  /** One `untracked/` set as a single digest, so it moves only when the set changed. */
  async function folderEntry(workId: string, source: string): Promise<Entry | undefined> {
    if (!(await exists(source))) return undefined
    const hash = createHash("sha256")
    let bytes = 0
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const name of (await readdir(dir)).sort()) {
        const path = join(dir, name)
        const info = await lstat(path)
        if (info.isDirectory()) await walk(path, prefix ? `${prefix}/${name}` : name)
        else if (info.isFile()) {
          const digest = await digestFile(path)
          bytes += digest.bytes
          hash.update(`${prefix ? `${prefix}/` : ""}${name}\0${digest.sha256}\n`)
        }
      }
    }
    await walk(source, "")
    return { key: `v1/works/${workId}/${WORK_FILES.untracked}`, source, stamp: { bytes, sha256: hash.digest("hex"), folder: true } }
  }

  /**
   * Stages every changed file, folder and the manifest, then moves them in one shell step: a copy that fails leaves
   * every old file and folder exactly as it was. boxd exec starts in /home/boxd, so its paths are relative there.
   */
  async function stageAndSwap(target: ChangeTarget, ledgerId: string, changed: readonly Entry[], manifest: string, context: OpContext): Promise<void> {
    const root = remoteRoot(ledgerId)
    const stageRoot = `${root}/.stage-${randomBytes(6).toString("hex")}`
    const directories = new Set<string>([inHome(root)])
    try {
      for (const entry of changed) {
        const stage = `${stageRoot}/${entry.key}`
        if (entry.stamp.folder) await core.boxd.copyTree(target, entry.source, stage, context)
        else await core.boxd.copyTo(target, entry.source, stage, context)
        directories.add(inHome(dirname(`${root}/${entry.key}`)))
      }
      const stagedManifest = `${stageRoot}/registry.json`
      await core.boxd.copyTo(target, manifest, stagedManifest, context)
      const script = ["set -e", ...[...directories].sort().map((directory) => `mkdir -p ${shell(directory)}`)]
      for (const entry of changed) {
        const stage = `${stageRoot}/${entry.key}`
        const destination = `${root}/${entry.key}`
        if (!entry.stamp.folder) {
          script.push(`mv -f ${shell(inHome(stage))} ${shell(inHome(destination))}`)
          continue
        }
        const old = `${destination}.old-${randomBytes(6).toString("hex")}`
        script.push(`rm -rf ${shell(inHome(old))}`)
        script.push(`if [ -d ${shell(inHome(destination))} ]; then mv ${shell(inHome(destination))} ${shell(inHome(old))}; fi`)
        script.push(`if mv ${shell(inHome(stage))} ${shell(inHome(destination))}; then rm -rf ${shell(inHome(old))}; else if [ -d ${shell(inHome(old))} ] && [ ! -e ${shell(inHome(destination))} ]; then mv ${shell(inHome(old))} ${shell(inHome(destination))}; fi; exit 1; fi`)
      }
      script.push(`mv -f ${shell(inHome(stagedManifest))} ${shell(inHome(`${root}/registry.json`))}`)
      script.push(`rm -rf ${shell(inHome(stageRoot))}`)
      const moved = await core.boxd.exec(target, script.join("; "), { timeoutSeconds: Math.ceil((TIMEOUTS.helperChange * 2) / 1000), json: true }, context)
      if (moved.code !== 0) throw new Error(`The registry could not move its staged copy into place: ${moved.stdout.slice(-200) || `exit ${moved.code}`}`)
    } catch (error) {
      await core.boxd.exec(target, `rm -rf ${shell(inHome(stageRoot))}`, { timeoutSeconds: Math.ceil(TIMEOUTS.helperChange / 1000), json: true }, context).catch(() => undefined)
      throw error
    }
  }

  async function attempt(context: OpContext): Promise<void> {
    await load()
    startedAt ??= now().getTime()
    const records = await core.ledger.list({ closed: true }, context)
    const region = firstRegion(records)
    if (!region) return
    const ledgerId = await core.ledger.id(context)
    if (state && state.ledgerId !== ledgerId) state = undefined
    const ensured = await ensureMachine(region.region, ledgerId, context)
    const configured = await configure(ensured.target, ensured.configured, context)
    // A copy state belongs to one machine: a new or replaced registry starts empty and receives the whole ledger.
    const previous = state?.ledgerId === ledgerId && state.machine.id === ensured.target.machineId ? state : undefined
    state = {
      format: STATE_FORMAT,
      ledgerId,
      machine: { name: ensured.target.name, region: ensured.target.region, id: ensured.target.machineId },
      configured,
      ...(previous?.lastCopyAt ? { lastCopyAt: previous.lastCopyAt } : {}),
      works: previous?.works ?? [],
      files: previous?.files ?? {},
      ...(previous?.failure ? { failure: previous.failure } : {}),
    }
    const found = await entries()
    const changed = found.filter((entry) => !stampEqual(state?.files[entry.key], entry.stamp))
    const at = now().toISOString()
    const works = found.flatMap((entry) => {
      const workId = /^v1\/works\/([a-z][a-z0-9-]{0,24})\/work\.json$/.exec(entry.key)?.[1]
      return workId ? [workId] : []
    })
    if (changed.length) {
      const manifest = join(core.ledgerRoot, `.registry-manifest.${randomBytes(6).toString("hex")}.tmp`)
      try {
        await writeJsonAtomic(manifest, { format: STATE_FORMAT, ledgerId, at, works, files: Object.fromEntries(found.map((entry) => [entry.key, entry.stamp])) })
        await core.runner.withMachineLock({ id: ensured.target.machineId }, context, () => stageAndSwap(ensured.target, ledgerId, changed, manifest, context))
      } finally {
        await remove(manifest)
      }
    }
    state = {
      format: STATE_FORMAT,
      ledgerId,
      machine: state.machine,
      configured,
      lastCopyAt: at,
      works,
      files: Object.fromEntries(found.map((entry) => [entry.key, entry.stamp])),
    }
    await save()
    core.report("registry", undefined)
  }

  return {
    async sync(context) {
      if (running) return running
      running = (async () => {
        try {
          await attempt(context)
        } catch (error) {
          const at = now().toISOString()
          const reason = reasonOf(error)
          if (state) {
            state = { ...state, failure: { at, reason } }
            await save().catch(() => undefined)
          }
          core.report("registry", `The ledger copy to its registry failed at ${at}: ${reason}.`)
        } finally {
          running = undefined
        }
      })()
      return running
    },
    status() {
      if (!state) return undefined
      const at = now().getTime()
      const last = state.lastCopyAt === undefined ? Number.NaN : Date.parse(state.lastCopyAt)
      let warning: string | undefined
      if (state.failure && (Number.isNaN(last) || Date.parse(state.failure.at) >= last)) warning = `The ledger copy to its registry failed at ${state.failure.at}: ${state.failure.reason}.`
      else if (!Number.isNaN(last) && at - last > REGISTRY_LAG_MS) warning = `The ledger copy to its registry is more than one sweep behind: its last complete copy was at ${state.lastCopyAt}.`
      else if (Number.isNaN(last) && startedAt !== undefined && at - startedAt > REGISTRY_LAG_MS) warning = "The ledger copy to its registry has not completed a copy yet."
      return {
        machine: state.machine.name,
        region: state.machine.region,
        ...(state.lastCopyAt ? { lastCopyAt: state.lastCopyAt } : {}),
        works: state.works,
        ...(warning ? { warning } : {}),
      }
    },
  }
}
