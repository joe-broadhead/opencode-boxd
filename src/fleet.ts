import { boxdError } from "./errors.js"
import type { Ledger, Work } from "./ledger.js"
import { assertDirectory, assertRepo, assertSessionId, assertSnapshot, assertWorkId, machineName, workDirectory } from "./names.js"
import type { BoxdPort, GitState, GuestPort, MachineInfo, Prover } from "./ports.js"
import { digest, order, parseExport, rewrite, type Transfer } from "./transfer.js"
import { checkGuest } from "./host-version.js"

export type Deps = {
  readonly boxd: BoxdPort
  readonly guest: GuestPort
  readonly prover: Prover
  readonly ledger: Ledger
  readonly now: () => string
  readonly snapshot: string
  /** This laptop's OpenCode version: the guest must run the same one. */
  readonly hostVersion: string | null
}

export type FleetResult = Record<string, unknown>

/** One work as status reports it: the ledger's facts, and the machine's live state when boxd answered. */
export interface WorkSummary {
  readonly workId: string
  readonly machine: string
  readonly sessionId: string | null
  readonly proof: "fresh" | "stale" | "missing"
  readonly dirty: boolean
  readonly machineStatus: MachineInfo["status"] | null
}

export interface FleetStatus {
  readonly snapshot: string
  readonly works: readonly WorkSummary[]
}

export function createFleet(deps: Deps) {
  const snapshot = assertSnapshot(deps.snapshot)

  async function loadOwned(workId: string): Promise<Work> {
    assertWorkId(workId)
    const work = await deps.ledger.load(workId)
    if (!work || work.dropped) throw boxdError("NOT_OURS", `No open work "${workId}".`)
    if (work.machine !== machineName(workId)) {
      throw boxdError("NOT_OURS", `Work "${workId}" is not bound to its own machine.`)
    }
    return work
  }

  async function ownedBy(machine: string): Promise<Work | undefined> {
    return (await deps.ledger.list()).find((work) => work.machine === machine)
  }

  async function machineOf(work: Work): Promise<MachineInfo> {
    const machine = await deps.boxd.get(work.machine)
    refuseUnsafe(machine)
    return machine
  }

  async function ready(work: Work): Promise<MachineInfo> {
    const machine = await machineOf(work)
    if (machine.status === "missing" || machine.status === "destroyed") {
      throw boxdError("MACHINE_GONE", `Machine ${work.machine} is gone.`)
    }
    if (machine.status !== "running") {
      if (machine.status === "hibernated" || machine.status === "standby" || machine.status === "stopped") {
        await deps.boxd.wake(work.machine)
      }
      throw boxdError("MACHINE_STARTING", `Machine ${work.machine} is ${machine.status}.`)
    }
    const server = await deps.guest.server(work.machine)
    if (server !== "up") throw boxdError("MACHINE_STARTING", "OpenCode on the machine is not up yet.")
    checkGuest(await deps.guest.version(work.machine), deps.hostVersion)
    return machine
  }

  return {
    /** The ledger, and each work's machine when the CLI answers. Never starts, wakes or reads a session. */
    async status(): Promise<FleetStatus> {
      const works = await deps.ledger.list()
      return {
        snapshot,
        works: await Promise.all(
          works.map(async (work) => {
            const machine = await deps.boxd.get(work.machine).catch(() => undefined)
            return {
              workId: work.workId,
              machine: work.machine,
              sessionId: work.rootSessionId ?? null,
              proof: proofState(work),
              dirty: work.git?.dirty ?? false,
              machineStatus: machine?.status ?? null,
            }
          }),
        ),
      }
    },

    async ensure(input: { workId: string; directory?: string; repo?: string; title?: string }): Promise<FleetResult> {
      assertWorkId(input.workId)
      const directory = input.directory ? assertDirectory(input.directory) : workDirectory(input.workId)
      const repo = input.repo ? assertRepo(input.repo) : undefined
      const name = machineName(input.workId)
      let work = await deps.ledger.load(input.workId)
      if (work?.dropped) throw boxdError("NOT_OURS", `Work "${input.workId}" was dropped. Use a new work id.`)
      let machine = await deps.boxd.get(name)
      refuseUnsafe(machine)
      if (machine.status === "missing" || machine.status === "destroyed") {
        machine = await deps.boxd.create({ name, snapshot, workId: input.workId })
        refuseUnsafe(machine)
      }
      // The session id is written before the prompt is admitted: a crash must not lose the transcript's address.
      work = {
        workId: input.workId,
        machine: name,
        snapshot,
        directory,
        ...(repo ?? work?.repo ? { repo: repo ?? work?.repo } : {}),
        ...(work?.rootSessionId ? { rootSessionId: work.rootSessionId } : {}),
        ...(work?.lastSubmitAt ? { lastSubmitAt: work.lastSubmitAt } : {}),
        ...(work?.proof ? { proof: work.proof } : {}),
        ...(work?.git ? { git: work.git } : {}),
      }
      await deps.ledger.save(work)
      if (machine.status !== "running") {
        if (machine.status === "hibernated" || machine.status === "standby" || machine.status === "stopped") await deps.boxd.wake(name)
        return { workId: input.workId, machine: name, state: "starting", next: "Call boxd_status in a later turn." }
      }
      checkGuest(await deps.guest.version(name), deps.hostVersion)
      await deps.boxd.holdAwake(name)
      if ((await deps.guest.server(name)) !== "up") {
        return { workId: input.workId, machine: name, state: "starting", next: "Call boxd_status in a later turn." }
      }
      await deps.guest.prepare(name, directory, work.repo)
      return { workId: input.workId, machine: name, directory, state: "ready", guestVersion: deps.hostVersion }
    },

    async submit(input: { workId: string; text: string; title?: string }): Promise<FleetResult> {
      const work = await loadOwned(input.workId)
      if (!input.text.trim()) throw boxdError("NAME_INVALID", "Prompt text is empty.")
      await ready(work)
      if (!work.rootSessionId) {
        const created = await deps.guest.createSession(work.machine, work.directory, input.title ?? input.workId)
        work.rootSessionId = assertSessionId(created.id)
        await deps.ledger.save(work)
      }
      await deps.guest.prompt(work.machine, work.rootSessionId, input.text)
      work.lastSubmitAt = deps.now()
      await deps.ledger.save(work)
      return {
        workId: work.workId,
        machine: work.machine,
        sessionId: work.rootSessionId,
        state: "admitted",
        next: "Call boxd_job in a later turn. This call did not wait for the model.",
      }
    },

    async job(input: { workId: string }): Promise<FleetResult> {
      const work = await loadOwned(input.workId)
      if (!work.rootSessionId) return { workId: work.workId, state: "empty", next: "Call boxd_submit." }
      await ready(work)
      const phase = await deps.guest.phase(work.machine, work.rootSessionId)
      return {
        workId: work.workId,
        sessionId: work.rootSessionId,
        state: phase,
        proof: proofState(work),
        next: phase === "busy" ? "Call boxd_job again in a later turn." : "Call boxd_harvest before sleep, image or drop.",
      }
    },

    async harvest(input: { workId: string; localDirectory: string }): Promise<FleetResult> {
      const work = await loadOwned(input.workId)
      const localDirectory = assertDirectory(input.localDirectory)
      if (!work.rootSessionId) throw boxdError("NOT_OURS", "This work has no session. Call boxd_submit first.")
      await ready(work)
      const phase = await deps.guest.phase(work.machine, work.rootSessionId)
      if (phase === "busy") throw boxdError("SESSION_BUSY", "The session is still running.")
      const listed = await deps.guest.listSessions(work.machine)
      const tree = collect(work.rootSessionId, listed)
      const transfers = order(await Promise.all(tree.map(async (id) => parseExport(await deps.guest.exportSession(work.machine, id)))))
      const imported = new Map<string, string>()
      const sessions: Array<{ remoteId: string; importedId: string; parentRemoteId?: string }> = []
      const sha256: Record<string, string> = {}
      for (const transfer of transfers) {
        // The export is stored before the import: a refused import must not lose the only copy on the laptop.
        await deps.ledger.saveExport(work.workId, transfer.info.id, transfer)
        sha256[transfer.info.id] = digest(transfer)
        const result = await deps.prover.importTransfer(rewrite(transfer, imported), localDirectory)
        const importedId = assertSessionId(result.id)
        imported.set(transfer.info.id, importedId)
        sessions.push({ remoteId: transfer.info.id, importedId, ...(transfer.info.parentID ? { parentRemoteId: transfer.info.parentID } : {}) })
      }
      const git = await harvestGit(deps, work)
      work.proof = { harvestedAt: deps.now(), guestVersion: deps.hostVersion ?? "unknown", sessions, sha256 }
      work.git = git
      await deps.ledger.save(work)
      return {
        workId: work.workId,
        state: "proven",
        sessions: sessions.map((session) => ({ remoteId: session.remoteId, importedId: session.importedId })),
        git: { remote: git.remote, sha: git.sha, dirty: git.dirty, patchStored: git.patchStored },
      }
    },

    async sleep(input: { workId: string }): Promise<FleetResult> {
      const work = await loadOwned(input.workId)
      requireFresh(work)
      await deps.boxd.hibernate(work.machine)
      await deps.boxd.allowSleep(work.machine)
      return { workId: work.workId, machine: work.machine, state: "hibernated" }
    },

    /** Destroys the machine. Refused unless the laptop import is fresh and the tree is clean or already stored. */
    async drop(input: { workId: string }): Promise<FleetResult> {
      const work = await loadOwned(input.workId)
      requireFresh(work)
      if (work.git?.dirty && !work.git.patchStored) {
        throw boxdError("DIRTY", "The guest tree has uncommitted work and no patch in the ledger.")
      }
      const machine = await deps.boxd.get(work.machine)
      if (machine.name !== work.machine) throw boxdError("NOT_OURS", "Refusing to remove a machine this work does not own.")
      refuseUnsafe(machine)
      if (machine.status !== "missing" && machine.status !== "destroyed") await deps.boxd.remove(work.machine)
      work.dropped = true
      await deps.ledger.save(work)
      return { workId: work.workId, machine: work.machine, state: "dropped" }
    },

    async resume(input: { workId: string }): Promise<FleetResult> {
      const work = await loadOwned(input.workId)
      let machine = await deps.boxd.get(work.machine)
      refuseUnsafe(machine)
      if (machine.status === "hibernated" || machine.status === "standby" || machine.status === "stopped") {
        await deps.boxd.wake(work.machine)
        return { workId: work.workId, machine: work.machine, state: "starting", resumed: "wake", next: "Call boxd_status in a later turn." }
      }
      if (machine.status === "starting" || machine.status === "other") {
        throw boxdError("MACHINE_STARTING", `Machine ${work.machine} is ${machine.status}.`)
      }
      let recreated = false
      if (machine.status === "missing" || machine.status === "destroyed") {
        machine = await deps.boxd.create({ name: work.machine, snapshot, workId: work.workId })
        refuseUnsafe(machine)
        recreated = true
        if (machine.status !== "running") {
          return { workId: work.workId, machine: work.machine, state: "starting", resumed: "import", next: "Call boxd_resume again once boxd_status reports running." }
        }
      }
      await deps.boxd.holdAwake(work.machine)
      checkGuest(await deps.guest.version(work.machine), deps.hostVersion)
      await deps.guest.prepare(work.machine, work.directory, work.repo)
      if (!recreated && work.rootSessionId) {
        const phase = await deps.guest.phase(work.machine, work.rootSessionId)
        if (phase !== "missing") {
          return { workId: work.workId, machine: work.machine, sessionId: work.rootSessionId, state: phase, resumed: "wake" }
        }
      }
      if (!work.proof) throw boxdError("NOT_PROVEN", "The machine is gone and there is no proven export to restart from.")
      const transfers = order(await Promise.all(work.proof.sessions.map((session) => deps.ledger.loadExport(work.workId, session.remoteId))))
      const imported = new Map<string, string>()
      for (const transfer of transfers) {
        const result = await deps.guest.importSession(work.machine, rewrite(transfer, imported), work.directory)
        imported.set(transfer.info.id, assertSessionId(result.id))
      }
      const root = work.rootSessionId ? imported.get(work.rootSessionId) : undefined
      if (root) work.rootSessionId = root
      work.proof = undefined
      work.lastSubmitAt = deps.now()
      await deps.ledger.save(work)
      return {
        workId: work.workId,
        machine: work.machine,
        sessionId: root ?? null,
        state: "ready",
        resumed: "import",
        next: "The transcript is back. Harvest again before sleep, image or drop, because the old proof was for the previous machine.",
      }
    },

    /** Saves a new immutable snapshot of a machine this plugin owns. */
    async image(input: { machine: string; name: string }): Promise<FleetResult> {
      const name = assertSnapshot(input.name)
      const owner = await ownedBy(input.machine)
      if (!owner) throw boxdError("NOT_OURS", `No work id owns machine ${input.machine}.`)
      const existing = await deps.boxd.listSnapshots()
      if (existing.some((item) => item.name === name)) throw boxdError("SNAPSHOT_EXISTS", `Snapshot ${name} already exists.`)
      const machine = await deps.boxd.get(input.machine)
      refuseUnsafe(machine)
      if (machine.status !== "running") throw boxdError("MACHINE_STARTING", `Machine ${input.machine} is ${machine.status}.`)
      checkGuest(await deps.guest.version(input.machine), deps.hostVersion)
      const stale = (await deps.ledger.list()).filter((work) => work.machine === input.machine && proofState(work) !== "fresh")
      if (stale.length) {
        throw boxdError("NOT_PROVEN", `Machine ${input.machine} has work without a fresh export (${stale.map((work) => work.workId).join(", ")}).`)
      }
      await deps.boxd.saveSnapshot(input.machine, name)
      return { machine: input.machine, snapshot: name, state: "saved" }
    },
  }
}

function refuseUnsafe(machine: MachineInfo): void {
  if (machine.status === "missing") return
  if (machine.sharing === "shared") throw boxdError("MACHINE_SHARED", `Machine ${machine.name} is shared, and sharing deletes OpenCode's sign-in.`)
  if (machine.isolated) throw boxdError("MACHINE_ISOLATED", `Machine ${machine.name} is isolated, so it has no git integration and no in-VM boxd.`)
}

/** A work's proof: the laptop has an import newer than the last prompt. */
export function proofState(work: Work): "fresh" | "stale" | "missing" {
  if (!work.proof) return "missing"
  if (work.lastSubmitAt && work.proof.harvestedAt < work.lastSubmitAt) return "stale"
  return "fresh"
}

function requireFresh(work: Work): void {
  const state = proofState(work)
  if (state === "fresh") return
  throw boxdError("NOT_PROVEN", state === "missing" ? "No proven export is on this laptop." : "The laptop export is older than the last prompt.")
}

function collect(root: string, listed: ReadonlyArray<{ id: string; parentID?: string }>): string[] {
  const children = new Map<string, string[]>()
  for (const session of listed) {
    if (!session.parentID) continue
    const group = children.get(session.parentID) ?? []
    group.push(session.id)
    children.set(session.parentID, group)
  }
  const ids: string[] = []
  const walk = (id: string) => {
    ids.push(id)
    for (const child of children.get(id) ?? []) walk(child)
  }
  walk(root)
  return ids
}

async function harvestGit(deps: Deps, work: Work): Promise<NonNullable<Work["git"]>> {
  let git: GitState
  try {
    git = await deps.guest.git(work.machine, work.directory)
  } catch {
    return { remote: null, branch: null, sha: null, dirty: false, patchStored: false }
  }
  const patchStored = Boolean(git.dirty && git.patch)
  if (patchStored && git.patch) await deps.ledger.savePatch(work.workId, git.patch)
  return { remote: git.remote, branch: git.branch, sha: git.sha, dirty: git.dirty, patchStored }
}

export type { Transfer }
