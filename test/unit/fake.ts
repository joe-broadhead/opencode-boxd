import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFleet, type Deps } from "../../src/fleet.js"
import { Ledger } from "../../src/ledger.js"
import type { BoxdPort, GitState, GuestPort, MachineInfo, MachineStatus, Prover } from "../../src/ports.js"
import type { Transfer } from "../../src/transfer.js"
import { boxdError } from "../../src/errors.js"

const HOST = "2.2.6"

export type World = {
  fleet: ReturnType<typeof createFleet>
  boxd: FakeBoxd
  guest: FakeGuest
  prover: FakeProver
  ledger: Ledger
  root: string
}

export async function world(options?: {
  hostVersion?: string | null
  snapshot?: string
  version?: string
  root?: string
  report?: (problem: string) => void
}): Promise<World> {
  const root = options?.root ?? (await mkdtemp(join(tmpdir(), "boxd-unit-")))
  const boxd = new FakeBoxd()
  const guest = new FakeGuest(options?.version ?? HOST)
  const prover = new FakeProver()
  let tick = 0
  const deps: Deps = {
    boxd,
    guest,
    prover,
    ledger: new Ledger(root),
    now: () => `2026-11-07T12:00:${String(tick++).padStart(2, "0")}.000Z`,
    snapshot: options && "snapshot" in options ? options.snapshot! : "opencode-golden",
    hostVersion: options && "hostVersion" in options ? options.hostVersion! : HOST,
    ...(options?.report ? { report: options.report } : {}),
  }
  return { fleet: createFleet(deps), boxd, guest, prover, ledger: deps.ledger, root }
}

export function transfer(id: string, parentID?: string, text = "hello"): Transfer {
  return { info: { id, ...(parentID ? { parentID } : {}), projectID: "proj_test", title: id }, messages: [{ type: "user", text }] }
}

export class FakeBoxd implements BoxdPort {
  readonly calls: string[] = []
  readonly machines = new Map<string, MachineInfo>()
  readonly snapshots: Array<{ name: string; storage: string; status: string }> = [{ name: "opencode-golden", storage: "local", status: "ready" }]
  /** How the next `create` answers: normally, by timing out while the machine lands, by timing out with nothing, or shared. */
  createBehaviour: "ok" | "timeout-then-exists" | "timeout-missing" | "shared" = "ok"
  /** Machines the account has that no ledger records. */
  readonly orphans: string[] = []

  async list(): Promise<MachineInfo[]> {
    this.calls.push("machine list")
    return [...this.machines.values(), ...this.orphans.map((name) => ({ name, status: "running" as const, sharing: "private" as const, isolated: false }))]
  }

  async get(name: string): Promise<MachineInfo> {
    this.calls.push(`get ${name}`)
    return this.machines.get(name) ?? { name, status: "missing", sharing: "unknown", isolated: false }
  }

  async create(input: { name: string; snapshot: string; workId: string }): Promise<MachineInfo> {
    this.calls.push(`create ${input.name} ${input.snapshot}`)
    const machine: MachineInfo = {
      name: input.name,
      status: "running",
      sharing: this.createBehaviour === "shared" ? "shared" : "private",
      isolated: false,
      source: `snapshot/${input.snapshot}`,
    }
    if (this.createBehaviour === "timeout-missing") throw boxdError("TIMEOUT", "boxd machine new did not answer within 30000 ms.")
    this.machines.set(input.name, machine)
    if (this.createBehaviour === "timeout-then-exists") throw boxdError("TIMEOUT", "boxd machine new did not answer within 30000 ms.")
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
    const machine = this.machines.get(name) ?? { name, status, sharing: "private" as const, isolated: false }
    this.machines.set(name, { ...machine, status })
  }
}

export class FakeGuest implements GuestPort {
  readonly sessions: Array<{ id: string; parentID?: string }> = []
  readonly exports = new Map<string, unknown>()
  readonly imports: Transfer[] = []
  readonly prompts: string[] = []
  readonly forgotten: string[] = []
  readonly servers: string[] = []
  gitFails = false
  phaseById = new Map<string, "busy" | "idle" | "missing">()
  /** What the last run of a session did, as the guest would report it. */
  runById = new Map<string, { outcome: "completed" | "failed" | "aborted" | null; error?: string }>()
  /** The export an `exportSession` call returns for a session, when a test wants a specific one. */
  exportOverride = new Map<string, unknown>()
  gitState: GitState = { known: true, remote: null, branch: null, sha: null, dirty: false, untracked: [], ignored: [], untrackedFiles: {} }
  serverUp = true
  prepared: string[] = []

  readonly guestVersion: string

  constructor(guestVersion: string) {
    this.guestVersion = guestVersion
    this.sessions.push({ id: "ses_root_review-api" })
    this.exports.set("ses_root_review-api", transfer("ses_root_review-api"))
    this.phaseById.set("ses_root_review-api", "busy")
  }

  async version(_machine: string) {
    return this.guestVersion
  }
  async server(_machine: string) {
    this.servers.push(_machine)
    return this.serverUp ? ("up" as const) : ("starting" as const)
  }
  async prepare(_machine: string, directory: string) {
    this.prepared.push(directory)
  }
  async listSessions(_machine: string) {
    return [...this.sessions]
  }
  async createSession(_machine: string, _directory: string, _title: string) {
    return { id: "ses_root_review-api" }
  }
  async prompt(_machine: string, sessionID: string, text: string) {
    this.prompts.push(`${sessionID}:${text}`)
  }
  async phase(_machine: string, sessionID: string) {
    const phase = this.phaseById.get(sessionID) ?? "missing"
    return { phase, run: this.runById.get(sessionID) ?? { outcome: null } }
  }
  async exportSession(_machine: string, sessionID: string) {
    return this.exportOverride.get(sessionID) ?? this.exports.get(sessionID)
  }
  async importSession(_machine: string, value: Transfer, _directory: string) {
    this.imports.push(value)
    return { id: value.info.id }
  }
  async git(_machine: string, _directory: string) {
    if (this.gitFails) throw new Error("git status failed")
    return this.gitState
  }
  forget(machine: string) {
    this.forgotten.push(machine)
  }
}

export class FakeProver implements Prover {
  readonly calls: Array<{ remoteId: string; parentID?: string; directory: string }> = []
  fresh = true

  async importTransfer(value: Transfer, directory: string) {
    this.calls.push({ remoteId: value.info.id, ...(value.info.parentID ? { parentID: value.info.parentID } : {}), directory })
    return { id: this.fresh ? value.info.id : `ses_local_${this.calls.length}` }
  }
}
