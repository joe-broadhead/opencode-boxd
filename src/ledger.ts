import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { boxdError } from "./errors.js"
import type { RunOutcome } from "./outcome.js"
import type { Transfer } from "./transfer.js"

interface Proof {
  harvestedAt: string
  guestVersion: string
  sessions: Array<{ remoteId: string; importedId: string; parentRemoteId?: string }>
  sha256: Record<string, string>
}

/** What the guest's git read found. `known: false` means there is no repository, so nothing can be proven about the disk. */
interface GitRecord {
  known: boolean
  remote: string | null
  branch: string | null
  sha: string | null
  dirty: boolean
  patchStored: boolean
  /** Paths git does not track, which `git diff` never contains. A drop is refused while any exists. */
  untracked: string[]
  /** Paths git ignores: build output, local secrets. Also refused, because the patch cannot hold them. */
  ignored: string[]
  /** True when the untracked files' contents were stored beside the patch. */
  untrackedStored: boolean
}

/** The guest session's last run, recorded at each harvest, so status and the next step know what happened. */
interface LastOutcome {
  state: RunOutcome
  error?: string
  at: string
}

/** One file a work moved in or out: its name in the work tree, its size and digest. Never its content. */
export interface MovedFile {
  path: string
  bytes: number
  sha256: string
  at: string
  /** Where the laptop holds it, for a file that came back. */
  laptopPath?: string
}

/** A recorded warning about a work; the next step is the code's own. */
export interface WorkWarning {
  code: "UNHARVESTED_SLEEP"
  at: string
}

export interface Work {
  workId: string
  machine: string
  snapshot: string
  /** The laptop folder a work belongs to: where the transcript is imported, and where its files go by default. */
  laptopDirectory: string
  /** The folder the guest works in: /home/boxd/work/<workId>, always made by the plugin. */
  guestDirectory: string
  repo?: string
  rootSessionId?: string
  lastSubmitAt?: string
  proof?: Proof
  lastOutcome?: LastOutcome
  git?: GitRecord
  warnings?: WorkWarning[]
  /** Files copied to the guest, by name, size and digest. */
  uploads?: MovedFile[]
  /** Files copied back, by name, size and digest; a drop counts one as recovered while its digest still matches. */
  downloads?: MovedFile[]
  /** When `boxd_sleep` last hibernated the machine; cleared when the plugin wakes or recreates it. */
  sleptAt?: string
  /** Set before `machine new`, and cleared once the machine is recorded: a timeout must not orphan a billing machine. */
  pendingCreate?: { at: string; snapshot: string }
  dropped?: boolean
}

const PRIVATE_DIR = 0o700
const PRIVATE_FILE = 0o600

/**
 * The laptop's store. Every write is atomic (a unique temp file, then a rename) and serialised per work, so two tools in
 * one script cannot lose each other's fields: the last writer wins only for the fields it held under the lock.
 *
 * A file system failure is a coded error, never a raw `ENOENT`: the model and a script must get `CODE: … Next step: …`.
 */
export class Ledger {
  readonly root: string
  /** One promise chain per work id: the writes to one work run in the order they were asked for. */
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(root: string) {
    this.root = root
  }

  async load(workId: string): Promise<Work | undefined> {
    try {
      return JSON.parse(await readFile(this.workPath(workId), "utf8")) as Work
    } catch (error) {
      if (codeOf(error) === "ENOENT") return undefined
      throw ledgerError("read", workId, error)
    }
  }

  /** Writes the whole work atomically. The caller holds the fields it loaded; prefer `mutate`. */
  async save(work: Work): Promise<void> {
    await this.exclusive(work.workId, () => this.writeWork(work))
  }

  /**
   * Reads, changes and writes one work under its lock, so a concurrent writer cannot lose this change. The recipe gets
   * the work as it is now, and its result is what is stored. A failing recipe writes nothing.
   */
  async mutate(workId: string, recipe: (work: Work | undefined) => Work): Promise<Work> {
    return this.exclusive(workId, async () => {
      const next = recipe(await this.load(workId))
      await this.writeWork(next)
      return next
    })
  }

  async saveExport(workId: string, remoteId: string, transfer: Transfer): Promise<void> {
    await this.exclusive(workId, () => this.writeJson(this.exportPath(workId, remoteId), transfer, workId))
  }

  async loadExport(workId: string, remoteId: string): Promise<Transfer> {
    try {
      return JSON.parse(await readFile(this.exportPath(workId, remoteId), "utf8")) as Transfer
    } catch (error) {
      throw ledgerError("read", workId, error)
    }
  }

  async savePatch(workId: string, patch: string): Promise<void> {
    await this.exclusive(workId, async () => {
      const path = join(this.dir(workId), "patch.diff")
      await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR })
      await this.writeAtomic(path, patch, workId)
    })
  }

  /** The untracked files a harvest captured: a JSON map of path to base64 content, beside the patch. */
  async saveUntracked(workId: string, files: Readonly<Record<string, string>>): Promise<void> {
    await this.exclusive(workId, () => this.writeJson(join(this.dir(workId), "untracked.json"), files, workId))
  }

  async list(): Promise<Work[]> {
    let names: string[]
    try {
      names = await readdir(join(this.root, "works"))
    } catch (error) {
      if (codeOf(error) === "ENOENT") return []
      throw ledgerError("list", "works", error)
    }
    const works = await Promise.all(names.map((name) => this.load(name)))
    return works.filter((work): work is Work => work !== undefined && !work.dropped)
  }

  /** Runs `task` after every earlier task for this work, whatever their outcome, and returns its result. */
  private exclusive<T>(workId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(workId) ?? Promise.resolve()
    const next = previous.then(task, task)
    // Keep the chain alive but never let a rejection break the next writer.
    this.queues.set(
      workId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  private async writeWork(work: Work): Promise<void> {
    await this.writeJson(this.workPath(work.workId), work, work.workId)
  }

  private async writeJson(path: string, value: unknown, workId: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR })
    await this.writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`, workId)
  }

  /** A unique temp file in the same directory, then a rename: a reader never sees half a file, and two writers never share a name. */
  private async writeAtomic(path: string, text: string, workId: string): Promise<void> {
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, text, { mode: PRIVATE_FILE })
      await rename(temp, path)
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      throw ledgerError("write", workId, error)
    }
  }

  private dir(workId: string): string {
    return join(this.root, "works", workId)
  }

  private workPath(workId: string): string {
    return join(this.dir(workId), "work.json")
  }

  private exportPath(workId: string, remoteId: string): string {
    return join(this.dir(workId), "exports", `${remoteId}.json`)
  }
}

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code

/** A file system failure, as the one error shape: the code, what happened, and its next step. */
const ledgerError = (action: string, workId: string, error: unknown): never => {
  const reason = error instanceof Error ? error.message : String(error)
  throw boxdError("LEDGER_FAILED", `The ledger could not ${action} work "${workId}" (${reason.slice(0, 160)}).`)
}
