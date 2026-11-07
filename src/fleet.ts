import { BoxdError } from "./errors.js"
import { Ledger, type Work } from "./ledger.js"
import { assertDirectory, assertRepo, assertSessionId, assertSnapshot, assertWorkId, machineName, workDirectory } from "./names.js"
import type { BoxdPort, GitState, GuestPort, MachineInfo, Prover } from "./ports.js"
import { digest, order, parseExport, rewrite, type Transfer } from "./transfer.js"
import { checkGuest, OPENCODE_VERSION } from "./version.js"

export type Deps = {
  boxd: BoxdPort
  guest: GuestPort
  prover: Prover
  ledger: Ledger
  now: () => string
  snapshot: string
}

export type FleetResult = Record<string, unknown>

export function createFleet(deps: Deps) {
  const snapshot = assertSnapshot(deps.snapshot)

  async function loadOwned(workId: string): Promise<Work> {
    assertWorkId(workId)
    const work = await deps.ledger.load(workId)
    if (!work || work.dropped) {
      throw new BoxdError("NOT_OURS", `No open work "${workId}".`, "Call boxd_ensure before acting on a work id.")
    }
    if (work.machine !== machineName(workId)) {
      throw new BoxdError("NOT_OURS", `Work "${workId}" is not bound to its own machine.`, "Do not retarget a work id onto another machine.")
    }
    return work
  }

  async function machineOf(work: Work): Promise<MachineInfo> {
    const machine = await deps.boxd.get(work.machine)
    refuseUnsafe(machine)
    return machine
  }

  async function ready(work: Work): Promise<MachineInfo> {
    const machine = await machineOf(work)
    if (machine.status === "missing" || machine.status === "destroyed") {
      throw new BoxdError("MACHINE_GONE", `Machine ${work.machine} is gone.`, "Call boxd_resume. Do not boot a snapshot of the old session disk.")
    }
    if (machine.status !== "running") {
      if (machine.status === "hibernated" || machine.status === "standby" || machine.status === "stopped") {
        await deps.boxd.wake(work.machine)
      }
      throw new BoxdError("MACHINE_STARTING", `Machine ${work.machine} is ${machine.status}.`, "Call boxd_status. Do not wait inside this call.")
    }
    const server = await deps.guest.server(work.machine)
    if (server !== "up") {
      throw new BoxdError("MACHINE_STARTING", "OpenCode on the machine is not up yet.", "Call boxd_status. Do not wait inside this call.")
    }
    checkGuest(await deps.guest.version(work.machine))
    return machine
  }

  return {
    async status(): Promise<FleetResult> {
      const [works, snapshots] = await Promise.all([deps.ledger.list(), deps.boxd.listSnapshots()])
      const machines = await Promise.all(works.map(async (work) => ({ workId: work.workId, ...(await deps.boxd.get(work.machine)) })))
      return {
        version: OPENCODE_VERSION,
        snapshot,
        works: works.map(summarize),
        machines,
        snapshots: snapshots.map((item) => ({ name: item.name, storage: item.storage, status: item.status })),
      }
    },

    async ensure(input: { workId: string; directory?: string; repo?: string; title?: string }): Promise<FleetResult> {
      assertWorkId(input.workId)
      const directory = input.directory ? assertDirectory(input.directory) : workDirectory(input.workId)
      const repo = input.repo ? assertRepo(input.repo) : undefined
      const name = machineName(input.workId)
      let work = await deps.ledger.load(input.workId)
      if (work?.dropped) {
        throw new BoxdError("NOT_OURS", `Work "${input.workId}" was dropped.`, "Use a new work id. Do not reuse a destroyed machine.")
      }
      let machine = await deps.boxd.get(name)
      refuseUnsafe(machine)
      if (machine.status === "missing" || machine.status === "destroyed") {
        machine = await deps.boxd.create({ name, snapshot, workId: input.workId })
        refuseUnsafe(machine)
      }
      work = {
        workId: input.workId,
        machine: name,
        snapshot,
        directory,
        repo: repo ?? work?.repo,
        rootSessionId: work?.rootSessionId,
        lastSubmitAt: work?.lastSubmitAt,
        proof: work?.proof,
        git: work?.git,
      }
      await deps.ledger.save(work)
      if (machine.status !== "running") {
        if (machine.status === "hibernated" || machine.status === "standby" || machine.status === "stopped") await deps.boxd.wake(name)
        return { workId: input.workId, machine: name, state: "starting", next: "Call boxd_status. Do not wait in this call." }
      }
      checkGuest(await deps.guest.version(name))
      await deps.boxd.holdAwake(name)
      if ((await deps.guest.server(name)) !== "up") {
        return { workId: input.workId, machine: name, state: "starting", next: "Call boxd_status. Do not wait in this call." }
      }
      await deps.guest.prepare(name, directory, work.repo)
      return { workId: input.workId, machine: name, directory, state: "ready", version: OPENCODE_VERSION }
    },

    async submit(input: { workId: string; text: string; title?: string }): Promise<FleetResult> {
      const work = await loadOwned(input.workId)
      if (!input.text.trim()) throw new BoxdError("NAME_INVALID", "Prompt text is empty.", "Pass the task text.")
      await ready(work)
      if (!work.rootSessionId) {
        const created = await deps.guest.createSession(work.machine, work.directory, input.title ?? input.workId)
        work.rootSessionId = assertSessionId(created.id)
      }
      await deps.guest.prompt(work.machine, work.rootSessionId, input.text)
      work.lastSubmitAt = deps.now()
      await deps.ledger.save(work)
      return {
        workId: work.workId,
        machine: work.machine,
        sessionId: work.rootSessionId,
        state: "admitted",
        next: "Call boxd_job later. This call did not wait for the model.",
      }
    },

    async job(input: { workId: string }): Promise<FleetResult> {
      const work = await loadOwned(input.workId)
      if (!work.rootSessionId) {
        return { workId: work.workId, state: "empty", next: "Call boxd_submit." }
      }
      await ready(work)
      const phase = await deps.guest.phase(work.machine, work.rootSessionId)
      return {
        workId: work.workId,
        sessionId: work.rootSessionId,
        state: phase,
        proof: proofState(work),
        next: phase === "busy" ? "Call boxd_job again later. Do not harvest yet." : "Call boxd_harvest before sleep or drop.",
      }
    },

    async harvest(input: { workId: string; localDirectory: string }): Promise<FleetResult> {
      const work = await loadOwned(input.workId)
      const localDirectory = assertDirectory(input.localDirectory)
      if (!work.rootSessionId) throw new BoxdError("NOT_OURS", "This work has no session.", "Call boxd_submit first.")
      await ready(work)
      const phase = await deps.guest.phase(work.machine, work.rootSessionId)
      if (phase === "busy") {
        throw new BoxdError("SESSION_BUSY", "The session is still running.", "Call boxd_job. Harvest only when it is idle.")
      }
      const listed = await deps.guest.listSessions(work.machine)
      const tree = collect(work.rootSessionId, listed)
      const transfers = order(await Promise.all(tree.map(async (id) => parseExport(await deps.guest.exportSession(work.machine, id)))))
      const imported = new Map<string, string>()
      const sessions: Array<{ remoteId: string; importedId: string; parentRemoteId?: string }> = []
      const sha256: Record<string, string> = {}
      for (const transfer of transfers) {
        await deps.ledger.saveExport(work.workId, transfer.info.id, transfer)
        sha256[transfer.info.id] = digest(transfer)
        const rewritten = rewrite(transfer, imported)
        const result = await deps.prover.importTransfer(rewritten, localDirectory)
        const importedId = assertSessionId(result.id)
        imported.set(transfer.info.id, importedId)
        sessions.push({ remoteId: transfer.info.id, importedId, parentRemoteId: transfer.info.parentID })
      }
      const git = await harvestGit(deps, work)
      work.proof = { harvestedAt: deps.now(), guestVersion: OPENCODE_VERSION, sessions, sha256 }
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

    async drop(input: { workId: string }): Promise<FleetResult> {
      const work = await loadOwned(input.workId)
      requireFresh(work)
      if (work.git?.dirty && !work.git.patchStored) {
        throw new BoxdError("DIRTY", "The guest tree has uncommitted work and no patch in the ledger.", "Call boxd_harvest. Do not destroy the disk.")
      }
      const machine = await deps.boxd.get(work.machine)
      if (machine.name !== work.machine) {
        throw new BoxdError("NOT_OURS", "Refusing to remove a machine this work does not own.", "Drop only the machine recorded for this work id.")
      }
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
        return { workId: work.workId, machine: work.machine, state: "starting", resumed: "wake", next: "Call boxd_status. Do not wait in this call." }
      }
      if (machine.status === "starting" || machine.status === "other") {
        throw new BoxdError("MACHINE_STARTING", `Machine ${work.machine} is ${machine.status}.`, "Call boxd_status. Do not wait in this call.")
      }
      let recreated = false
      if (machine.status === "missing" || machine.status === "destroyed") {
        machine = await deps.boxd.create({ name: work.machine, snapshot, workId: work.workId })
        refuseUnsafe(machine)
        recreated = true
        if (machine.status !== "running") {
          return { workId: work.workId, machine: work.machine, state: "starting", resumed: "import", next: "Call boxd_resume again once boxd_status says running." }
        }
      }
      await deps.boxd.holdAwake(work.machine)
      checkGuest(await deps.guest.version(work.machine))
      await deps.guest.prepare(work.machine, work.directory, work.repo)
      if (!recreated && work.rootSessionId) {
        const phase = await deps.guest.phase(work.machine, work.rootSessionId)
        if (phase !== "missing") {
          return { workId: work.workId, machine: work.machine, sessionId: work.rootSessionId, state: phase, resumed: "wake" }
        }
      }
      if (!work.proof) {
        throw new BoxdError("NOT_PROVEN", "The machine is gone and there is no proven export.", "There is nothing to restart. Do not invent a session.")
      }
      const transfers = order(await Promise.all(work.proof.sessions.map((session) => deps.ledger.loadExport(work.workId, session.remoteId))))
      const imported = new Map<string, string>()
      for (const transfer of transfers) {
        const result = await deps.guest.importSession(work.machine, rewrite(transfer, imported), work.directory)
        imported.set(transfer.info.id, assertSessionId(result.id))
      }
      const root = work.rootSessionId ? imported.get(work.rootSessionId) : undefined
      work.rootSessionId = root
      work.proof = undefined
      work.lastSubmitAt = deps.now()
      await deps.ledger.save(work)
      return {
        workId: work.workId,
        machine: work.machine,
        sessionId: root,
        state: "ready",
        resumed: "import",
        next: "The transcript is back. Harvest again before drop. The old proof was for the previous machine.",
      }
    },

    async image(input: { machine: string; name: string }): Promise<FleetResult> {
      const name = assertSnapshot(input.name)
      const existing = await deps.boxd.listSnapshots()
      if (existing.some((item) => item.name === name)) {
        throw new BoxdError("NAME_INVALID", `Snapshot ${name} already exists.`, "Snapshots are immutable. Pick a new name.")
      }
      const machine = await deps.boxd.get(input.machine)
      refuseUnsafe(machine)
      if (machine.status !== "running") {
        throw new BoxdError("MACHINE_STARTING", `Machine ${input.machine} is ${machine.status}.`, "Save an image only from a running machine.")
      }
      checkGuest(await deps.guest.version(input.machine))
      const works = (await deps.ledger.list()).filter((work) => work.machine === input.machine)
      const stale = works.filter((work) => proofState(work) !== "fresh")
      if (stale.length) {
        throw new BoxdError(
          "NOT_PROVEN",
          `Machine ${input.machine} has work without a fresh export.`,
          "Harvest every work on that machine first. An image is not a session store.",
        )
      }
      await deps.boxd.saveSnapshot(input.machine, name)
      return { machine: input.machine, snapshot: name, state: "saved" }
    },
  }
}

function refuseUnsafe(machine: MachineInfo): void {
  if (machine.status === "missing") return
  if (machine.sharing === "shared") {
    throw new BoxdError("MACHINE_SHARED", `Machine ${machine.name} is shared. Sharing deletes OpenCode auth.`, "Use a private machine. Do not pass --shared.")
  }
  if (machine.isolated) {
    throw new BoxdError("MACHINE_ISOLATED", `Machine ${machine.name} is isolated. It has no git integration and no in-VM boxd.`, "Do not pass --isolated for a session machine.")
  }
}

function summarize(work: Work): FleetResult {
  return {
    workId: work.workId,
    machine: work.machine,
    sessionId: work.rootSessionId ?? null,
    proof: proofState(work),
    dirty: work.git?.dirty ?? false,
  }
}

function proofState(work: Work): "fresh" | "stale" | "missing" {
  if (!work.proof) return "missing"
  if (work.lastSubmitAt && work.proof.harvestedAt < work.lastSubmitAt) return "stale"
  return "fresh"
}

function requireFresh(work: Work): void {
  const state = proofState(work)
  if (state === "fresh") return
  throw new BoxdError(
    "NOT_PROVEN",
    state === "missing" ? "No proven export is on the laptop." : "The laptop export is older than the last prompt.",
    "Call boxd_harvest. Do not sleep or destroy until the import has succeeded.",
  )
}

function collect(root: string, listed: Array<{ id: string; parentID?: string }>): string[] {
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
