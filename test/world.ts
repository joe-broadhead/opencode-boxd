import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFleet, type Deps } from "../src/fleet.js"
import { Ledger } from "../src/ledger.js"
import type { BoxdPort, GitState, GuestPort, MachineInfo, MachineStatus, Prover } from "../src/ports.js"
import type { Transfer } from "../src/transfer.js"
import { OPENCODE_VERSION } from "../src/version.js"

export type World = {
  fleet: ReturnType<typeof createFleet>
  boxd: FakeBoxd
  guest: FakeGuest
  prover: FakeProver
  ledger: Ledger
  clock: { iso: () => string }
}

export async function world(options?: { version?: string; snapshot?: string }): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "opencode-boxd-"))
  const boxd = new FakeBoxd()
  const guest = new FakeGuest(options?.version ?? OPENCODE_VERSION)
  const prover = new FakeProver()
  let tick = 0
  const clock = { iso: () => `2026-11-07T12:00:${String(tick++).padStart(2, "0")}.000Z` }
  const deps: Deps = {
    boxd,
    guest,
    prover,
    ledger: new Ledger(root),
    now: () => clock.iso(),
    snapshot: options?.snapshot ?? "opencode-claude-final",
  }
  return { fleet: createFleet(deps), boxd, guest, prover, ledger: deps.ledger, clock }
}

export function transfer(id: string, parentID?: string, text = "hello"): Transfer {
  return { info: { id, parentID, projectID: "proj_test", title: id }, messages: [{ type: "user", text }] }
}

export class FakeBoxd implements BoxdPort {
  readonly calls: string[] = []
  readonly machines = new Map<string, MachineInfo>()
  readonly snapshots: Array<{ name: string; storage: string; status: string }> = []

  async get(name: string): Promise<MachineInfo> {
    this.calls.push(`get ${name}`)
    return this.machines.get(name) ?? { name, status: "missing", sharing: "unknown", isolated: false }
  }

  async create(input: { name: string; snapshot: string; workId: string }): Promise<MachineInfo> {
    this.calls.push(`create ${input.name} ${input.snapshot}`)
    const machine: MachineInfo = { name: input.name, status: "running", sharing: "private", isolated: false, source: `snapshot/${input.snapshot}` }
    this.machines.set(input.name, machine)
    return machine
  }

  async hibernate(name: string): Promise<void> {
    this.calls.push(`hibernate ${name}`)
    this.set(name, "hibernated")
  }

  async wake(name: string): Promise<void> {
    this.calls.push(`wake ${name}`)
    this.set(name, "running")
  }

  async remove(name: string): Promise<void> {
    this.calls.push(`remove ${name}`)
    this.set(name, "destroyed")
  }

  async saveSnapshot(machine: string, snapshot: string): Promise<void> {
    this.calls.push(`snapshot ${machine} ${snapshot}`)
    this.snapshots.push({ name: snapshot, storage: "local", status: "ready" })
  }

  async listSnapshots(): Promise<Array<{ name: string; storage: string; status: string }>> {
    return this.snapshots
  }

  async holdAwake(name: string): Promise<void> {
    this.calls.push(`hold ${name}`)
  }

  async allowSleep(name: string): Promise<void> {
    this.calls.push(`sleep-timeout ${name}`)
  }

  seed(name: string, status: MachineStatus, extra?: Partial<MachineInfo>): void {
    this.machines.set(name, { name, status, sharing: "private", isolated: false, ...extra })
  }

  private set(name: string, status: MachineStatus): void {
    const current = this.machines.get(name)
    if (current) current.status = status
  }
}

export class FakeGuest implements GuestPort {
  versionText: string
  phaseById = new Map<string, "busy" | "idle" | "missing">()
  sessions: Array<{ id: string; parentID?: string }> = []
  exports = new Map<string, Transfer>()
  imports: Array<{ id: string; parentID?: string }> = []
  gitState: GitState = { remote: "https://github.com/joe-broadhead/example", branch: "master", sha: "abc", dirty: false }
  prepared: string[] = []
  prompts: string[] = []
  private next = 1

  constructor(versionText: string) {
    this.versionText = versionText
  }

  async version(): Promise<string> {
    return this.versionText
  }

  async server(): Promise<"up" | "starting"> {
    return "up"
  }

  async prepare(_machine: string, directory: string): Promise<void> {
    this.prepared.push(directory)
  }

  async listSessions(): Promise<Array<{ id: string; parentID?: string }>> {
    return this.sessions
  }

  async createSession(_machine: string, _directory: string, title: string): Promise<{ id: string }> {
    const id = `ses_root_${title}`
    this.sessions.push({ id })
    this.exports.set(id, transfer(id, undefined, title))
    this.phaseById.set(id, "idle")
    return { id }
  }

  async prompt(_machine: string, sessionID: string, text: string): Promise<void> {
    this.prompts.push(`${sessionID}:${text}`)
    this.phaseById.set(sessionID, "busy")
  }

  async phase(_machine: string, sessionID: string): Promise<"busy" | "idle" | "missing"> {
    return this.phaseById.get(sessionID) ?? "missing"
  }

  async exportSession(_machine: string, sessionID: string): Promise<unknown> {
    const body = this.exports.get(sessionID)
    if (!body) throw new Error(`no export ${sessionID}`)
    return { data: body }
  }

  async importSession(_machine: string, body: Transfer): Promise<{ id: string }> {
    const id = `ses_guest_${this.next++}`
    this.imports.push({ id: body.info.id, parentID: body.info.parentID })
    this.sessions.push({ id, parentID: body.info.parentID })
    this.exports.set(id, { ...body, info: { ...body.info, id } })
    this.phaseById.set(id, "idle")
    return { id }
  }

  async git(): Promise<GitState> {
    return this.gitState
  }
}

export class FakeProver implements Prover {
  readonly calls: Array<{ remoteId: string; parentID?: string; directory: string }> = []
  private next = 1

  async importTransfer(body: Transfer, directory: string): Promise<{ id: string }> {
    const id = `ses_local_${this.next++}`
    this.calls.push({ remoteId: body.info.id, parentID: body.info.parentID, directory })
    return { id }
  }
}
