import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Transfer } from "./transfer.js"

export type Proof = {
  harvestedAt: string
  guestVersion: string
  sessions: Array<{ remoteId: string; importedId: string; parentRemoteId?: string }>
  sha256: Record<string, string>
}

export type GitRecord = {
  remote: string | null
  branch: string | null
  sha: string | null
  dirty: boolean
  patchStored: boolean
}

export type Work = {
  workId: string
  machine: string
  snapshot: string
  directory: string
  repo?: string
  rootSessionId?: string
  lastSubmitAt?: string
  proof?: Proof
  git?: GitRecord
  dropped?: boolean
}

export class Ledger {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  async load(workId: string): Promise<Work | undefined> {
    try {
      return JSON.parse(await readFile(this.workPath(workId), "utf8")) as Work
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  async save(work: Work): Promise<void> {
    const path = this.workPath(work.workId)
    await mkdir(join(path, ".."), { recursive: true })
    const temp = `${path}.tmp`
    await writeFile(temp, `${JSON.stringify(work, null, 2)}\n`)
    await rename(temp, path)
  }

  async saveExport(workId: string, remoteId: string, transfer: Transfer): Promise<void> {
    const path = this.exportPath(workId, remoteId)
    await mkdir(join(path, ".."), { recursive: true })
    const temp = `${path}.tmp`
    await writeFile(temp, `${JSON.stringify(transfer)}\n`)
    await rename(temp, path)
  }

  async loadExport(workId: string, remoteId: string): Promise<Transfer> {
    return JSON.parse(await readFile(this.exportPath(workId, remoteId), "utf8")) as Transfer
  }

  async savePatch(workId: string, patch: string): Promise<void> {
    const path = join(this.dir(workId), "patch.diff")
    await mkdir(this.dir(workId), { recursive: true })
    await writeFile(path, patch)
  }

  async list(): Promise<Work[]> {
    let names: string[]
    try {
      names = await readdir(join(this.root, "works"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    const works = await Promise.all(names.map((name) => this.load(name)))
    return works.filter((work): work is Work => work !== undefined && !work.dropped)
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
