import { mkdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { assertTotal, assertWorkPath, loadFile, resolveLaptopPath, rootsOf, sha256, storeFile, FILE_LIMIT, TOTAL_LIMIT } from "./paths.js"
import { boxdError, BoxdError } from "./errors.js"
import type { Ledger, MovedFile, Work, WorkWarning } from "./ledger.js"
import { assertRepo, assertSessionId, assertSnapshot, assertWorkId, machineName, workDirectory } from "./names.js"
import type { BoxdPort, GuestPort, MachineInfo, Prover } from "./ports.js"
import { digest, order, parseExport, rewrite, type Transfer } from "./transfer.js"
import { checkGuest } from "./host-version.js"
import { reasonOf } from "./redact.js"
import { failureCode, failureText, nextStepFor, readRun, type GuestRun, type RunOutcome } from "./outcome.js"

export type Deps = {
  readonly boxd: BoxdPort
  readonly guest: GuestPort
  readonly prover: Prover
  readonly ledger: Ledger
  readonly now: () => string
  readonly snapshot: string
  /** This laptop's OpenCode version: the guest must run the same one. */
  readonly hostVersion: string | null
  /** A problem worth showing in status, such as an awake bound that could not be armed. */
  readonly report?: (problem: string) => void
  /** The OpenCode project folder: the first laptop root a work may use. */
  readonly projectDirectory: string
  /** Further laptop roots the user named; a path outside both is refused. */
  readonly allowedRoots: readonly string[]
}

type FleetResult = Record<string, unknown>

/** One work as status reports it: the ledger's facts, and the machine's live state when boxd answered. */
export interface WorkSummary {
  readonly workId: string
  readonly machine: string
  readonly sessionId: string | null
  readonly proof: "fresh" | "stale" | "missing"
  readonly dirty: boolean
  readonly machineStatus: MachineInfo["status"] | null
  /** Recorded warnings, such as a sleep taken before the last prompt was harvested. */
  readonly warnings: readonly string[]
  /** The guest session's last run, as the last harvest recorded it. */
  readonly outcome: RunOutcome | null
  /** A failed run's redacted error line. */
  readonly error?: string
}

export interface FleetStatus {
  readonly snapshot: string
  /** Whether the golden snapshot exists in the account; null when the listing could not be read. */
  readonly snapshotPresent: boolean | null
  readonly works: readonly WorkSummary[]
  /** `oc-*` machines the account has that no open work records: a create that timed out, most likely. */
  readonly orphans: readonly string[]
}

type Awake = "hold" | "sleep"

/** How long a snapshot listing is reused for status: a read that never wakes or bills, but is still a CLI call. */
const SNAPSHOT_TTL_MS = 30_000

export function createFleet(deps: Deps) {
  const snapshot = assertSnapshot(deps.snapshot)
  /** The account's snapshot names, and when they were read. */
  let snapshots: { at: number; names: Set<string> } | undefined

  /** The snapshot names, from a cache unless `fresh`; undefined when the listing could not be read at all. */
  async function snapshotNames(fresh: boolean): Promise<Set<string> | undefined> {
    if (!fresh && snapshots && Date.now() - snapshots.at < SNAPSHOT_TTL_MS) return snapshots.names
    try {
      const listed = await deps.boxd.listSnapshots()
      snapshots = { at: Date.now(), names: new Set(listed.map((item) => item.name)) }
      return snapshots.names
    } catch {
      return undefined
    }
  }

  /**
   * Refuses to create a machine from a snapshot that is not in the account, before any create runs: a machine that
   * boots from nothing bills and holds no session. An unreadable listing is not a refusal; the create reports its own.
   */
  async function requireSnapshot(): Promise<void> {
    const names = await snapshotNames(true)
    if (names && !names.has(snapshot)) throw boxdError("SNAPSHOT_MISSING", `The golden snapshot "${snapshot}" is not in this boxd account.`)
  }

  const report = (code: string, message: string) => deps.report?.(`${code}: ${message} Next step: Restart OpenCode, then run /boxd-status.`)

  async function loadOwned(workId: string): Promise<Work> {
    assertWorkId(workId)
    const work = await deps.ledger.load(workId)
    if (!work || work.dropped) throw boxdError("NOT_OURS", `No open work "${workId}".`)
    if (work.machine !== machineName(workId)) throw boxdError("NOT_OURS", `Work "${workId}" is not bound to its own machine.`)
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

  /**
   * Arms the awake bound right after any transition to running, before a guest call that can throw. A failure is
   * reported to status rather than skipped: an unbounded machine is the one failure that bills for hours.
   */
  async function armAwake(machine: string, awake: Awake = "hold"): Promise<void> {
    try {
      if (awake === "hold") await deps.boxd.holdAwake(machine)
      else await deps.boxd.allowSleep(machine)
    } catch (error) {
      const reason = error instanceof Error ? error.message.split(" Next step: ")[0] : String(error)
      report("AWAKE_UNBOUND", `The awake bound could not be armed on ${machine}, so it may idle without hibernating (${reason}).`)
    }
  }

  /**
   * A machine that must be running for this call. With `wake: false` (a read) it never wakes: a read that wakes a
   * hibernated machine would bill with no prompt.
   */
  async function ready(work: Work, options: { readonly wake: boolean; readonly arm?: boolean }): Promise<MachineInfo> {
    const machine = await machineOf(work)
    if (machine.status === "missing" || machine.status === "destroyed") {
      throw boxdError("MACHINE_GONE", `Machine ${work.machine} is gone.`)
    }
    if (machine.status === "hibernated" || machine.status === "standby" || machine.status === "stopped") {
      if (!options.wake) throw boxdError("MACHINE_STARTING", `Machine ${work.machine} is ${machine.status}.`)
      await deps.boxd.wake(work.machine)
      // The bound is armed before anything else can throw: a woken machine must never idle for hours.
      await armAwake(work.machine, "hold")
      throw boxdError("MACHINE_STARTING", `Machine ${work.machine} is waking.`)
    }
    if (machine.status !== "running") throw boxdError("MACHINE_STARTING", `Machine ${work.machine} is ${machine.status}.`)
    // An asking call may arm the bound; a read may not, because writing the machine's config is still a write.
    if (options.arm !== false) await armAwake(work.machine, "hold")
    const server = await deps.guest.server(work.machine)
    if (server !== "up") throw boxdError("MACHINE_STARTING", "OpenCode on the machine is not up yet.")
    checkGuest(await deps.guest.version(work.machine), deps.hostVersion)
    return machine
  }

  /** Creates the machine, and adopts one a timed-out `machine new` left behind, so no billing machine is unrecorded. */
  async function create(name: string, workId: string): Promise<MachineInfo> {
    try {
      const machine = await deps.boxd.create({ name, snapshot, workId })
      deps.guest.forget(name)
      return machine
    } catch (error) {
      if (!(error instanceof BoxdError) || error.code !== "TIMEOUT") throw error
      // The create may have landed. Adopt it if it did; otherwise the ledger keeps the intent and status names the gap.
      const machine = await deps.boxd.get(name)
      if (machine.status === "missing") throw boxdError("CREATE_UNCERTAIN", `boxd did not answer within the timeout, and no machine named ${name} exists yet.`)
      deps.guest.forget(name)
      return machine
    }
  }

  /** Removes a machine this plugin just created and refused, so a shared-by-default account cannot leave it billing. */
  async function removeRefused(name: string): Promise<never> {
    await deps.boxd.remove(name).catch(() => undefined)
    throw boxdError("NOT_OURS", `Machine ${name} was created shared or isolated, so it was removed again.`)
  }

  return {
    /** The ledger and each work's machine when the CLI answers. Never starts, wakes or runs a session. */
    async status(): Promise<FleetStatus> {
      const works = await deps.ledger.list()
      const listed = await deps.boxd.list().catch(() => undefined)
      const names = await snapshotNames(false)
      const known = new Set(works.map((work) => work.machine))
      return {
        snapshot,
        snapshotPresent: names ? names.has(snapshot) : null,
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
              warnings: (work.warnings ?? []).map((warning) => warning.code),
              outcome: work.lastOutcome?.state ?? null,
              ...(work.lastOutcome?.error ? { error: work.lastOutcome.error } : {}),
            }
          }),
        ),
        orphans: (listed ?? []).map((machine) => machine.name).filter((name) => name.startsWith("oc-") && !known.has(name)).sort(),
      }
    },

    async ensure(input: { workId: string; directory?: string; repo?: string; title?: string }): Promise<FleetResult> {
      assertWorkId(input.workId)
      // The laptop keeps the work in a folder of its own; the guest always works in /home/boxd/work/<work id>, because a
      // laptop path is not writable there and must never be sent to it. The folder is created when it does not exist.
      const laptopDirectory = await resolveWorkDirectory(deps, input.directory ?? deps.projectDirectory, rootsOf(deps.projectDirectory, deps.allowedRoots), true)
      const guestDirectory = workDirectory(input.workId)
      const directory = guestDirectory
      const repo = input.repo ? assertRepo(input.repo) : undefined
      const name = machineName(input.workId)
      let work = await deps.ledger.load(input.workId)
      if (work?.dropped) throw boxdError("NOT_OURS", `Work "${input.workId}" was dropped. Use a new work id.`)
      let machine = await deps.boxd.get(name)
      refuseUnsafe(machine)
      if (machine.status === "missing" || machine.status === "destroyed") {
        await requireSnapshot()
        // The intent is recorded before the create: a create that times out must never be an unowned billing machine.
        await deps.ledger.mutate(input.workId, (current) => ({
          workId: input.workId,
          machine: name,
          snapshot,
          laptopDirectory,
          guestDirectory,
          ...(repo ?? current?.repo ? { repo: repo ?? current?.repo } : {}),
          ...(current?.rootSessionId ? { rootSessionId: current.rootSessionId } : {}),
          ...(current?.lastSubmitAt ? { lastSubmitAt: current.lastSubmitAt } : {}),
          ...(current?.proof ? { proof: current.proof } : {}),
          ...(current?.git ? { git: current.git } : {}),
          ...(current?.warnings ? { warnings: current.warnings } : {}),
          pendingCreate: { at: deps.now(), snapshot },
        }))
        machine = await create(name, input.workId)
        if (machine.sharing === "shared" || machine.isolated) await removeRefused(name)
      }
      work = await deps.ledger.mutate(input.workId, (current) => {
        const next: Work = {
          workId: input.workId,
          machine: name,
          snapshot,
          laptopDirectory,
          guestDirectory,
          ...(repo ?? current?.repo ? { repo: repo ?? current?.repo } : {}),
          ...(current?.rootSessionId ? { rootSessionId: current.rootSessionId } : {}),
          ...(current?.lastSubmitAt ? { lastSubmitAt: current.lastSubmitAt } : {}),
          ...(current?.proof ? { proof: current.proof } : {}),
          ...(current?.git ? { git: current.git } : {}),
          ...(current?.warnings ? { warnings: current.warnings } : {}),
        }
        return next
      })
      if (machine.status !== "running") {
        if (machine.status === "hibernated" || machine.status === "standby" || machine.status === "stopped") {
          await deps.boxd.wake(name)
          await armAwake(name, "hold")
        }
        return { workId: input.workId, machine: name, state: "starting", next: "Call boxd_status in a later turn." }
      }
      await armAwake(name, "hold")
      checkGuest(await deps.guest.version(name), deps.hostVersion)
      if ((await deps.guest.server(name)) !== "up") {
        return { workId: input.workId, machine: name, state: "starting", next: "Call boxd_status in a later turn." }
      }
      await prepareWorkspace(deps, name, directory, work.repo)
      return { workId: input.workId, machine: name, guestDirectory, laptopDirectory, state: "ready", guestVersion: deps.hostVersion }
    },

    async submit(input: { workId: string; text: string; title?: string; files?: ReadonlyArray<{ from: string; to: string }> }): Promise<FleetResult> {
      const work = await loadOwned(input.workId)
      if (!input.text.trim()) throw boxdError("NAME_INVALID", "Prompt text is empty.")
      // Read and check every file before anything is copied or admitted: a path outside the roots fails the call whole.
      const incoming = await readIncoming(deps, input.files ?? [])
      await ready(work, { wake: true })
      const uploaded = await uploadAll(deps, work, incoming)
      let sessionId = work.rootSessionId
      if (!sessionId) {
        const created = await deps.guest.createSession(work.machine, work.guestDirectory, input.title ?? input.workId)
        sessionId = assertSessionId(created.id)
        await deps.ledger.mutate(work.workId, (current) => ({ ...(current ?? work), rootSessionId: sessionId }))
      }
      // Stamped before the prompt: a crash between the two leaves the proof stale, never falsely fresh.
      const at = deps.now()
      await deps.ledger.mutate(work.workId, (current) => ({ ...(current ?? work), lastSubmitAt: at }))
      await deps.guest.prompt(work.machine, sessionId, input.text)
      return {
        workId: work.workId,
        machine: work.machine,
        sessionId,
        state: "admitted",
        ...(uploaded.length ? { files: uploaded.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })) } : {}),
        next: "Call boxd_job in a later turn. This call did not wait for the model.",
      }
    },

    /**
     * One read. It never wakes a hibernated machine: it reports `asleep` with the machine's own state, and the next step
     * is the asking call that would wake it.
     */
    async job(input: { workId: string }): Promise<FleetResult> {
      const work = await loadOwned(input.workId)
      const machine = await machineOf(work)
      const status = machine.status
      if (status === "missing" || status === "destroyed") {
        return { workId: work.workId, machine: work.machine, state: "gone", next: "Call boxd_resume to rebuild it from the golden snapshot and the proven transcript." }
      }
      if (status === "hibernated" || status === "standby" || status === "stopped") {
        return {
          workId: work.workId,
          machine: work.machine,
          state: "asleep",
          machineStatus: status,
          next: "Call boxd_resume to wake it. This read does not wake a machine, because waking starts billing.",
        }
      }
      if (status !== "running") {
        return { workId: work.workId, machine: work.machine, state: "starting", machineStatus: status, next: "Call boxd_job in a later turn." }
      }
      if (!work.rootSessionId) {
        // No session yet is not the same as a guest that is ready: ask the server before answering.
        if ((await deps.guest.server(work.machine)) !== "up") {
          return { workId: work.workId, machine: work.machine, state: "starting", next: "OpenCode on the machine is not up yet. Call boxd_job in a later turn." }
        }
        return { workId: work.workId, state: "empty", next: "Call boxd_submit." }
      }
      await ready(work, { wake: false, arm: false })
      const { phase, run } = await deps.guest.phase(work.machine, work.rootSessionId)
      return {
        workId: work.workId,
        sessionId: work.rootSessionId,
        state: phase,
        proof: proofState(work),
        // The last run's outcome, so an idle session that failed is never read as a finished job.
        outcome: run.outcome,
        ...(run.outcome === "failed" ? { error: run.error, warning: failureCode(run) } : {}),
        next: jobNext(work.workId, phase, run),
      }
    },

    async harvest(input: { workId: string; localDirectory?: string; files?: readonly string[]; to?: string }): Promise<FleetResult> {
      const work = await loadOwned(input.workId)
      const roots = rootsOf(deps.projectDirectory, deps.allowedRoots)
      // The transcript lands in the work's laptop folder unless the call names another, and both must be inside a root.
      const localDirectory = await resolveWorkDirectory(deps, input.localDirectory ?? work.laptopDirectory, roots)
      // The files a work produced, read before the transcript moves: a refused path fails the call whole.
      const wanted = (input.files ?? []).map((path) => assertWorkPath(path))
      const toDirectory = input.to ? await resolveWorkDirectory(deps, input.to, roots, true) : localDirectory
      if (!work.rootSessionId) throw boxdError("NOT_OURS", "This work has no session. Call boxd_submit first.")
      await ready(work, { wake: true })
      const { phase, run: live } = await deps.guest.phase(work.machine, work.rootSessionId)
      if (phase === "busy") throw boxdError("SESSION_BUSY", "The session is still running.")
      const listed = await deps.guest.listSessions(work.machine)
      const tree = collect(work.rootSessionId, listed)
      const transfers = order(await Promise.all(tree.map(async (id) => parseExport(await deps.guest.exportSession(work.machine, id)))))
      // The outcome comes from the transcript itself: the root export's session info and last idle message. The live
      // phase fills a gap when an export does not carry the session's own outcome.
      const root = transfers.find((transfer) => transfer.info.id === work.rootSessionId)
      const exported = readRun(root?.info, root?.messages)
      const run: GuestRun = exported.outcome ? exported : live
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
      const proof = { harvestedAt: deps.now(), guestVersion: deps.hostVersion ?? "unknown", sessions, sha256 }
      // Under the lock, so a submit that lands during the harvest keeps its own `lastSubmitAt` and the proof goes stale.
      await deps.ledger.mutate(work.workId, (current) => ({
        ...(current ?? work),
        proof,
        git,
        warnings: [],
        ...(run.outcome ? { lastOutcome: { state: run.outcome, ...(run.error ? { error: run.error } : {}), at: deps.now() } } : {}),
      }))
      // Files come back after the proof is recorded: the laptop keeps the transcript even when a file copy is refused.
      const moved = await downloadAll(deps, work, wanted, toDirectory)
      if (moved.length) {
        await deps.ledger.mutate(work.workId, (current) => ({ ...(current ?? work), downloads: mergeFiles(current?.downloads, moved) }))
      }
      return {
        workId: work.workId,
        state: "proven",
        outcome: run.outcome,
        ...(run.outcome === "failed" ? { error: run.error, warning: failureCode(run) } : {}),
        ...(moved.length ? { files: moved.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })) } : {}),
        sessions: sessions.map((session) => ({ remoteId: session.remoteId, importedId: session.importedId })),
        git: { known: git.known, remote: git.remote, sha: git.sha, dirty: git.dirty, patchStored: git.patchStored, untracked: git.untracked, ignored: git.ignored },
        // A failed run is a warning on a successful harvest: the transcript is imported and proven, and the laptop keeps
        // it. The next step says what to do before the next prompt.
        next: run.outcome === "failed" ? `${failureText(run, work.workId)} ${nextStepFor(run)}` : dropAdvice(git, proofState(await loadOwned(work.workId))),
      }
    },

    /**
     * Hibernates. It destroys nothing, so it does not need a proof: a machine whose guest cannot be harvested must always
     * have an exit from billing. A live prompt that was not harvested is recorded as a warning, and status shows it.
     */
    async sleep(input: { workId: string }): Promise<FleetResult> {
      const work = await loadOwned(input.workId)
      const machine = await machineOf(work)
      if (machine.status !== "missing" && machine.status !== "destroyed") {
        await deps.boxd.hibernate(work.machine)
        await armAwake(work.machine, "sleep")
      }
      const unharvested = proofState(work) !== "fresh"
      if (unharvested) {
        await deps.ledger.mutate(work.workId, (current) => ({ ...(current ?? work), warnings: addWarning(current?.warnings, { code: "UNHARVESTED_SLEEP", at: deps.now() }) }))
      }
      return {
        workId: work.workId,
        machine: work.machine,
        state: "hibernated",
        ...(unharvested
          ? { warning: "The last prompt's work is not harvested on this laptop yet. Calling boxd_resume and boxd_harvest recovers it.", next: "Call boxd_resume and boxd_harvest when you need that work." }
          : {}),
      }
    },

    /**
     * Destroys the machine. It is refused unless the laptop has a proven import, the guest's tree is a known git
     * repository, and it has no untracked or ignored path: nothing is destroyed that the ledger cannot account for.
     */
    async drop(input: { workId: string }): Promise<FleetResult> {
      const work = await loadOwned(input.workId)
      await requireDroppable(deps, work)
      const machine = await deps.boxd.get(work.machine)
      if (machine.name !== work.machine) throw boxdError("NOT_OURS", "Refusing to remove a machine this work does not own.")
      refuseUnsafe(machine)
      if (machine.status !== "missing" && machine.status !== "destroyed") await deps.boxd.remove(work.machine)
      // The machine is gone; record it even if the ledger write then fails, because there is nothing left to protect.
      await deps.ledger.mutate(work.workId, (current) => ({ ...(current ?? work), dropped: true }))
      return { workId: work.workId, machine: work.machine, state: "dropped" }
    },

    async resume(input: { workId: string }): Promise<FleetResult> {
      const work = await loadOwned(input.workId)
      let machine = await deps.boxd.get(work.machine)
      refuseUnsafe(machine)
      if (machine.status === "hibernated" || machine.status === "standby" || machine.status === "stopped") {
        await deps.boxd.wake(work.machine)
        await armAwake(work.machine, "hold")
        return { workId: work.workId, machine: work.machine, state: "starting", resumed: "wake", next: "Call boxd_status in a later turn." }
      }
      if (machine.status === "starting" || machine.status === "other") {
        throw boxdError("MACHINE_STARTING", `Machine ${work.machine} is ${machine.status}.`)
      }
      let recreated = false
      if (machine.status === "missing" || machine.status === "destroyed") {
        await requireSnapshot()
        machine = await create(work.machine, work.workId)
        if (machine.sharing === "shared" || machine.isolated) await removeRefused(work.machine)
        recreated = true
        if (machine.status !== "running") return { workId: work.workId, machine: work.machine, state: "starting", resumed: "import", next: "Call boxd_resume again once boxd_status reports running." }
      }
      await armAwake(work.machine, "hold")
      checkGuest(await deps.guest.version(work.machine), deps.hostVersion)
      await prepareWorkspace(deps, work.machine, work.guestDirectory, work.repo)
      // A rebuilt machine has a new disk: nothing is running on it, so start the guest server before importing the
      // transcript. It boots asynchronously, so this call reports starting and the next one imports.
      if (recreated && (await deps.guest.server(work.machine)) !== "up") {
        return { workId: work.workId, machine: work.machine, state: "starting", resumed: "import", next: "Call boxd_resume again once the machine's OpenCode server is up." }
      }
      if (!recreated && work.rootSessionId) {
        const { phase } = await deps.guest.phase(work.machine, work.rootSessionId)
        if (phase !== "missing") return { workId: work.workId, machine: work.machine, sessionId: work.rootSessionId, state: phase, resumed: "wake" }
      }
      if (!work.proof) throw boxdError("NOT_PROVEN", "The machine is gone and there is no proven export to restart from.")
      const transfers = order(await Promise.all(work.proof.sessions.map((session) => deps.ledger.loadExport(work.workId, session.remoteId))))
      const imported = new Map<string, string>()
      for (const transfer of transfers) {
        const result = await deps.guest.importSession(work.machine, rewrite(transfer, imported), work.guestDirectory)
        imported.set(transfer.info.id, assertSessionId(result.id))
      }
      const root = work.rootSessionId ? imported.get(work.rootSessionId) : undefined
      await deps.ledger.mutate(work.workId, (current) => ({
        ...(current ?? work),
        ...(root ? { rootSessionId: root } : {}),
        proof: undefined,
        lastSubmitAt: deps.now(),
        warnings: [],
      }))
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
      if (stale.length) throw boxdError("NOT_PROVEN", `Machine ${input.machine} has work without a fresh export (${stale.map((work) => work.workId).join(", ")}).`)
      await deps.boxd.saveSnapshot(input.machine, name)
      return { machine: input.machine, snapshot: name, state: "saved" }
    },
  }
}

/**
 * Prepares the work tree on the guest. A failure names the folder and the guest's own words, because that is the one
 * place where an image that cannot be written to looks like an unexplained `GUEST_FAILED`.
 */
async function prepareWorkspace(deps: Deps, machine: string, guestDirectory: string, repo: string | undefined): Promise<void> {
  try {
    await deps.guest.prepare(machine, guestDirectory, repo)
  } catch (error) {
    const reason = error instanceof Error ? error.message.split(" Next step: ")[0] : String(error)
    throw boxdError("GUEST_WORKSPACE", `The machine could not prepare ${guestDirectory} (${reason}).`)
  }
}

/** The laptop folder a work uses: inside the project or an allowed root, and a folder. */
async function resolveWorkDirectory(deps: Deps, path: string, roots = rootsOf(deps.projectDirectory, deps.allowedRoots), create = false): Promise<string> {
  const real = await resolveLaptopPath(path, roots, create ? { create: true } : {})
  const info = await stat(real).catch(() => undefined)
  if (info?.isDirectory()) return real
  if (!info && create) {
    await mkdir(real, { recursive: true, mode: 0o700 })
    return real
  }
  throw boxdError("NAME_INVALID", `The local directory "${path}" does not exist.`)
}

/** Every file to copy in, read and checked before anything is uploaded or admitted. */
async function readIncoming(deps: Deps, files: ReadonlyArray<{ from: string; to: string }>): Promise<Array<{ path: string; body: Buffer; bytes: number; sha256: string }>> {
  const roots = rootsOf(deps.projectDirectory, deps.allowedRoots)
  const seen = new Set<string>()
  const out: Array<{ path: string; body: Buffer; bytes: number; sha256: string }> = []
  for (const file of files) {
    const path = assertWorkPath(file.to)
    if (seen.has(path)) throw boxdError("NAME_INVALID", `Two files copy to "${path}".`)
    seen.add(path)
    const loaded = await loadFile(file.from, roots)
    out.push({ path, body: loaded.body, bytes: loaded.bytes, sha256: loaded.sha256 })
  }
  assertTotal(out)
  return out
}

/** Copies the checked files to the guest, and records them by name, size and digest. */
async function uploadAll(deps: Deps, work: Work, files: ReturnType<typeof readIncoming> extends Promise<infer T> ? T : never): Promise<MovedFile[]> {
  const moved: MovedFile[] = []
  for (const file of files) {
    await deps.guest.upload(work.machine, work.guestDirectory, file.path, file.body).catch((error: unknown) => {
      throw boxdError("GUEST_FAILED", `The machine refused the upload of ${file.path} (${reasonOf(error)}).`)
    })
    moved.push({ path: file.path, bytes: file.bytes, sha256: file.sha256, at: deps.now() })
  }
  if (moved.length) await deps.ledger.mutate(work.workId, (current) => ({ ...(current ?? work), uploads: mergeFiles(current?.uploads, moved) }))
  return moved
}

/** Copies the requested files back, atomically and capped, and refuses a symlink, a cap and a local edit. */
async function downloadAll(deps: Deps, work: Work, paths: readonly string[], toDirectory: string): Promise<MovedFile[]> {
  const roots = rootsOf(deps.projectDirectory, deps.allowedRoots)
  const moved: MovedFile[] = []
  let total = 0
  for (const path of paths) {
    const body = await deps.guest.download(work.machine, work.guestDirectory, path).catch((error: unknown) => {
      throw boxdError("GUEST_FAILED", `The machine refused the download of ${path} (${reasonOf(error)}).`)
    })
    if (body.byteLength > FILE_LIMIT) throw boxdError("FILE_TOO_LARGE", `"${path}" is ${body.byteLength} bytes; the limit is ${FILE_LIMIT}.`)
    total += body.byteLength
    if (total > TOTAL_LIMIT) throw boxdError("FILE_TOO_LARGE", `The files total ${total} bytes; the limit is ${TOTAL_LIMIT}.`)
    const target = await resolveLaptopPath(join(toDirectory, path), roots, { create: true })
    const previous = work.downloads?.filter((file) => file.path === path).at(-1)?.sha256
    await storeFile(target, body, previous)
    moved.push({ path, bytes: body.byteLength, sha256: sha256(body), at: deps.now(), laptopPath: target })
  }
  return moved
}

/** The newest record for each path: a second harvest of a file replaces the first. */
function mergeFiles(existing: readonly MovedFile[] | undefined, moved: readonly MovedFile[]): MovedFile[] {
  const replaced = new Set(moved.map((file) => file.path))
  return [...(existing ?? []).filter((file) => !replaced.has(file.path)), ...moved]
}

/** A read's next step: a failed run outranks the harvest advice, because the job did not do what was asked. */
function jobNext(workId: string, phase: "busy" | "idle" | "missing", run: GuestRun): string {
  if (phase === "busy") return "Call boxd_job again in a later turn."
  if (run.outcome === "failed") return `${failureText(run, workId)} ${nextStepFor(run)}`
  if (run.outcome === "aborted") return `The last run of ${workId} was aborted. Call boxd_harvest before sleep, image or drop, then boxd_submit again if you still need it.`
  return "Call boxd_harvest before sleep, image or drop."
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

function addWarning(warnings: readonly WorkWarning[] | undefined, warning: WorkWarning): WorkWarning[] {
  const rest = (warnings ?? []).filter((item) => item.code !== warning.code)
  return [...rest, warning]
}

/**
 * What drop will do with this work, for a harvest's next step. The guard is the truth the drop call itself applies.
 */
function dropAdvice(git: Work["git"], proof: "fresh" | "stale" | "missing"): string {
  if (proof !== "fresh") return "Call boxd_harvest again before drop."
  if (!git || !git.known) return "The guest directory is not a git repository, so boxd_drop will refuse. Hibernate instead, or make it one."
  if (git.untracked.length) return `Commit or delete ${list(git.untracked)} on the machine, then harvest again. boxd_drop will refuse until you do.`
  if (git.ignored.length) return `Remove ${list(git.ignored)} on the machine, then harvest again. boxd_drop will refuse until you do.`
  return "Call boxd_sleep to hibernate, or boxd_drop: the import is proven and the tree is clean."
}

const list = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`)

/**
 * The drop guard: every way the disk is not fully accounted for on this laptop. A file harvested at the digest the guest
 * still has is recovered, so a task that wrote `SUMMARY.md` can be dropped; a file that changed, or was never harvested,
 * keeps the refusal.
 */
async function requireDroppable(deps: Deps, work: Work): Promise<void> {
  const proof = proofState(work)
  if (proof !== "fresh") throw boxdError("NOT_PROVEN", proof === "missing" ? "No proven export is on this laptop." : "The laptop export is older than the last prompt.")
  const git = work.git
  if (!git || !git.known) throw boxdError("GIT_UNKNOWN", "The guest directory is not a git repository, so its files cannot be accounted for.")
  const recovered = await recoveredPaths(deps, work, git)
  const lostUntracked = git.untracked.filter((path) => !recovered.has(path))
  const lostIgnored = git.ignored.filter((path) => !recovered.has(path))
  if (lostUntracked.length) throw boxdError("UNTRACKED", `The guest tree has untracked paths the patch cannot hold: ${list(lostUntracked)}.`)
  if (lostIgnored.length) throw boxdError("UNTRACKED", `The guest tree has ignored paths the patch cannot hold: ${list(lostIgnored)}.`)
  if (git.dirty && !git.patchStored) throw boxdError("DIRTY", "The guest tree has uncommitted work and no patch in the ledger.")
}

/** The untracked and ignored paths whose current guest digest is the one last harvested. */
async function recoveredPaths(deps: Deps, work: Work, git: NonNullable<Work["git"]>): Promise<Set<string>> {
  const recorded = new Map<string, string>()
  for (const file of work.downloads ?? []) recorded.set(file.path, file.sha256)
  const candidates = [...git.untracked, ...git.ignored].filter((path) => recorded.has(path))
  if (!candidates.length) return new Set()
  const digests = await deps.guest.digest(work.machine, work.guestDirectory, candidates).catch(() => ({}) as Record<string, string>)
  return new Set(candidates.filter((path) => digests[path] !== undefined && digests[path] === recorded.get(path)))
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
  const seen = new Set<string>()
  const walk = (id: string) => {
    // The export comes from the guest, which is not trusted: a cyclic parent chain must fail, not recurse forever.
    if (seen.has(id)) throw boxdError("EXPORT_INVALID", `The session tree names ${id} twice, so it has a cycle.`)
    seen.add(id)
    ids.push(id)
    for (const child of children.get(id) ?? []) walk(child)
  }
  walk(root)
  return ids
}

/** Captures the guest's git state, or raises a coded error: a directory the guest cannot vet can never be dropped. */
async function harvestGit(deps: Deps, work: Work): Promise<NonNullable<Work["git"]>> {
  const git = await deps.guest.git(work.machine, work.guestDirectory)
  const patchStored = Boolean(git.known && (git.dirty || git.untracked.length) && git.patch)
  if (patchStored && git.patch) await deps.ledger.savePatch(work.workId, git.patch)
  const untrackedStored = Boolean(Object.keys(git.untrackedFiles).length)
  if (untrackedStored) await deps.ledger.saveUntracked(work.workId, git.untrackedFiles)
  return {
    known: git.known,
    remote: git.remote,
    branch: git.branch,
    sha: git.sha,
    dirty: git.dirty,
    patchStored,
    untracked: git.untracked,
    ignored: git.ignored,
    untrackedStored,
  }
}

export type { Transfer }
