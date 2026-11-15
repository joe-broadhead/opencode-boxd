import { mkdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { assertTotal, assertWorkPath, loadFile, resolveLaptopPath, rootsOf, sha256, storeFile, FILE_LIMIT, TOTAL_LIMIT } from "./paths.js"
import { boxdError, BoxdError, CODES, inField, type Code } from "./errors.js"
import type { Ledger, MovedFile, Work, WorkWarning } from "./ledger.js"
import { assertModel, assertRepo, assertSessionId, assertSnapshot, assertWorkId, machineName, workDirectory } from "./names.js"
import type { BoxdPort, GuestActivity, GuestPort, MachineInfo, MachineSize, Prover, SecretInfo } from "./ports.js"
import { digest, order, parseExport, rewrite, type Transfer } from "./transfer.js"
import { checkGuest } from "./host-version.js"
import { reasonOf, shortReason } from "./redact.js"
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
  /** Waits between the polls of a call's bounded `wait`; a timer by default. */
  readonly pause?: (ms: number) => Promise<void>
}

type FleetResult = Record<string, unknown>

/**
 * What a work is doing, as one word: `busy` or `idle` (the guest session), `empty` (no prompt yet), `asleep`, `starting`,
 * `gone` (the machine is destroyed or missing), `missing` (the guest has no such session), or `unreachable` (boxd or the
 * guest did not answer; `error`, `message` and `next` say why).
 */
export type WorkPhase = "busy" | "idle" | "empty" | "asleep" | "starting" | "gone" | "missing" | "unreachable"

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
  /**
   * The guest session's last run: read live in `boxd_status` for a work with an unharvested prompt, else as the last
   * harvest recorded it.
   */
  readonly outcome: RunOutcome | null
  /** A failed run's redacted error line; for an `unreachable` phase, the failure's code, with `message` and `next`. */
  readonly error?: string
  /** The work's phase, in `boxd_status` only: the status command reads machines, never guests. */
  readonly phase?: WorkPhase
  /** What the session last did, read live with the phase: when, its last words, and the prompts waiting. */
  readonly lastActivityAt?: string
  readonly lastText?: string
  readonly pending?: number
  /** For an `unreachable` phase: what failed, redacted and cut to one line, and the code's next step. */
  readonly message?: string
  readonly next?: string
  /** Why a machine that is down is down: `boxd_sleep`, or the idle bound or the boxd CLI. Only while it is down. */
  readonly asleepBy?: AsleepBy
  /** When `boxd_sleep` hibernated it, when that is why. */
  readonly sleptAt?: string
}

/** Who put a machine to sleep: the plugin's own `boxd_sleep`, or something it did not record (the idle bound, the CLI). */
export type AsleepBy = "boxd_sleep" | "idle_or_cli"

export interface FleetStatus {
  readonly snapshot: string
  /** Whether the golden snapshot exists in the account; null when the listing could not be read. */
  readonly snapshotPresent: boolean | null
  readonly works: readonly WorkSummary[]
  /** `oc-*` machines the account has that no open work records: a create that timed out, most likely. */
  readonly orphans: readonly string[]
  /**
   * Whether the boxd CLI answered the machine listing status already makes: it does only when it is signed in. A
   * failure keeps the CLI's own reason, because a network failure fails the same way.
   */
  readonly cli: { readonly signedIn: true } | { readonly signedIn: false; readonly reason: string }
  /**
   * The account's sealed variables, in `boxd_status` only: names, scopes and bound hosts, never a value. boxd does not
   * say when one was last set. A failed read keeps the CLI's redacted reason.
   */
  readonly credentials?: { readonly secrets: readonly SecretInfo[] } | { readonly error: string }
}

/** How long `boxd_status` waits for one work's guest: a sick guest is reported as unreachable, not waited for. */
const STATUS_GUEST_MS = 15_000
/** One guest call's own bound inside that, so its probe still fits. */
const STATUS_CALL_MS = 6_000
/** A call's bounded `wait` for the machine and its OpenCode: polled this often, for at most this long. */
const WAIT_STEP_MS = 3_000
const WAIT_MS = 30_000

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
      await woke(work.workId)
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

  /** The harvest of a work with no session: no transcript, the guest's git state, and the files asked for. */
  async function harvestEmpty(work: Work, wanted: readonly string[], toDirectory: string): Promise<FleetResult> {
    const git = await harvestGit(deps, work)
    const proof = { harvestedAt: deps.now(), guestVersion: deps.hostVersion ?? "unknown", sessions: [], sha256: {} }
    await deps.ledger.mutate(work.workId, (current) => ({ ...(current ?? work), proof, git, warnings: [] }))
    const moved = await downloadAll(deps, work, wanted, toDirectory)
    if (moved.length) {
      await deps.ledger.mutate(work.workId, (current) => ({ ...(current ?? work), downloads: mergeFiles(current?.downloads, moved) }))
    }
    return {
      workId: work.workId,
      state: "proven",
      sessions: [],
      ...(moved.length ? { files: moved.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })) } : {}),
      git: { known: git.known, remote: git.remote, sha: git.sha, dirty: git.dirty, patchStored: git.patchStored, untracked: git.untracked, ignored: git.ignored },
      next: `This work has no session, so there was no transcript to import. ${dropAdvice(git, proofState(await loadOwned(work.workId)))}`,
    }
  }

  /** The plugin woke or recreated the machine, so a sleep it recorded no longer says why the machine is down. */
  async function woke(workId: string): Promise<void> {
    if (!(await deps.ledger.load(workId))?.sleptAt) return
    await deps.ledger.mutate(workId, (current) => {
      const { sleptAt: _, ...rest } = current!
      return rest
    })
  }

  /** Creates the machine, and adopts one a timed-out `machine new` left behind, so no billing machine is unrecorded. */
  async function create(name: string, workId: string): Promise<MachineInfo> {
    try {
      const machine = await deps.boxd.create({ name, snapshot, workId })
      deps.guest.forget(name)
      await woke(workId)
      return machine
    } catch (error) {
      if (!(error instanceof BoxdError) || error.code !== "TIMEOUT") throw error
      // The create may have landed. Adopt it if it did; otherwise the ledger keeps the intent and status names the gap.
      const machine = await deps.boxd.get(name)
      if (machine.status === "missing") throw boxdError("CREATE_UNCERTAIN", `boxd did not answer within the timeout, and no machine named ${name} exists yet.`)
      deps.guest.forget(name)
      await woke(workId)
      return machine
    }
  }

  /** Removes a machine this plugin just created and refused, so a shared-by-default account cannot leave it billing. */
  async function removeRefused(name: string): Promise<never> {
    await deps.boxd.remove(name).catch(() => undefined)
    throw boxdError("NOT_OURS", `Machine ${name} was created shared or isolated, so it was removed again.`)
  }

  /**
   * A call's bounded wait: while `attempt` reports the machine or its OpenCode starting, it is polled again every 3 s,
   * for at most 30 s. The last answer is returned as it is, so a machine that is still starting says so.
   */
  async function waited<T>(wait: boolean | undefined, attempt: () => Promise<T>, starting: (result: T) => boolean): Promise<T> {
    const pause = deps.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const until = Date.now() + WAIT_MS
    for (let polls = 0; ; polls++) {
      const result = await attempt().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      const still = "error" in result ? result.error instanceof BoxdError && result.error.code === "MACHINE_STARTING" : starting(result.value)
      if (!wait || !still || polls >= WAIT_MS / WAIT_STEP_MS || Date.now() + WAIT_STEP_MS > until) {
        if ("error" in result) throw result.error
        return result.value
      }
      await pause(WAIT_STEP_MS)
    }
  }

  /**
   * One work for `boxd_status`. A machine that is not running is not touched. A running one is read live only while its
   * last prompt is not harvested: a harvested work's outcome is the harvest's, and reading its guest would only keep the
   * machine busy. The read is bounded, so one sick guest does not slow the rest.
   */
  async function summarize(work: Work, live: boolean): Promise<WorkSummary> {
    const read = await deps.boxd.get(work.machine).then(
      (machine) => ({ machine }),
      (error: unknown) => ({ error }),
    )
    const machine = "machine" in read ? read.machine : undefined
    const base: WorkSummary = {
      workId: work.workId,
      machine: work.machine,
      sessionId: work.rootSessionId ?? null,
      proof: proofState(work),
      dirty: work.git?.dirty ?? false,
      machineStatus: machine?.status ?? null,
      warnings: (work.warnings ?? []).map((warning) => warning.code),
      outcome: work.lastOutcome?.state ?? null,
      ...(work.lastOutcome?.error ? { error: work.lastOutcome.error } : {}),
      ...(machine ? asleepOf(work, machine.status) : {}),
    }
    if (!live) return base
    if (!machine) return unreachable(base, "error" in read ? read.error : undefined)
    const status = machine.status
    if (status === "missing" || status === "destroyed") return { ...base, phase: "gone" }
    if (status === "hibernated" || status === "standby" || status === "stopped") return { ...base, phase: "asleep" }
    if (status !== "running") return { ...base, phase: "starting" }
    if (!work.rootSessionId) return { ...base, phase: "empty" }
    if (base.proof === "fresh") return { ...base, phase: "idle" }
    try {
      const { phase, run, activity } = await deadline(deps.guest.phase(work.machine, work.rootSessionId, { timeoutMs: STATUS_CALL_MS }), STATUS_GUEST_MS, work.machine)
      const { error: _, ...rest } = base
      // A live outcome replaces the harvest's, and its error with it; no live outcome keeps the harvest's.
      const error = run.outcome ? (run.outcome === "failed" ? run.error : undefined) : base.error
      return { ...rest, phase, outcome: run.outcome ?? base.outcome, ...(error ? { error } : {}), ...activityFields(activity) }
    } catch (error) {
      return unreachable(base, error)
    }
  }

  /**
   * One pass of `boxd_ensure`, once its input is checked: the machine, created or woken when it is not there or down, and
   * the work recorded. `created` says this pass made the machine, so a size is applied to it and to nothing that runs.
   */
  async function openWork(input: OpenInput): Promise<{ result: FleetResult; created: boolean; vcpu?: number }> {
    const { laptopDirectory, repo, model } = input
    const guestDirectory = workDirectory(input.workId)
    const directory = guestDirectory
    let created = false
    const name = machineName(input.workId)
    let work = await deps.ledger.load(input.workId)
    if (work?.dropped) throw boxdError("NOT_OURS", `Work "${input.workId}" was dropped. Use a new work id.`)
    let machine = await deps.boxd.get(name)
    refuseUnsafe(machine)
    if (machine.status === "missing" || machine.status === "destroyed") {
      await requireSnapshot()
      // The intent is recorded before the create: a create that times out must never be an unowned billing machine.
      await deps.ledger.mutate(input.workId, (current) => ({
        ...current,
        workId: input.workId,
        machine: name,
        snapshot,
        laptopDirectory,
        guestDirectory,
        ...(repo ?? current?.repo ? { repo: repo ?? current?.repo } : {}),
        pendingCreate: { at: deps.now(), snapshot },
      }))
      machine = await create(name, input.workId)
      if (machine.sharing === "shared" || machine.isolated) await removeRefused(name)
      created = true
    }
    work = await deps.ledger.mutate(input.workId, (current) => {
      // Everything the ledger knows stays, such as the files moved and the last outcome, which a drop and status read.
      // Only the create intent is done once the machine is recorded.
      const { pendingCreate: _, ...known } = current ?? {}
      const next: Work = {
        ...known,
        workId: input.workId,
        machine: name,
        snapshot,
        laptopDirectory,
        guestDirectory,
        ...(repo ?? current?.repo ? { repo: repo ?? current?.repo } : {}),
        // The work's default model, for the session its first prompt creates.
        ...(model ?? current?.model ? { model: model ?? current?.model } : {}),
        ...(created && input.vcpu ? { vcpu: input.vcpu } : current?.vcpu ? { vcpu: current.vcpu } : {}),
      }
      return next
    })
    const size = machine.vcpu !== undefined ? { vcpu: machine.vcpu } : {}
    const starting = { result: { workId: input.workId, machine: name, state: "starting", next: STARTING_NEXT }, created, ...size }
    // A machine from a snapshot keeps the snapshot's size, so a size is set by a resize, which reboots it. Only a machine
    // this call created is resized: nothing runs on it yet, and the reboot costs nothing.
    if (created && input.vcpu && machine.vcpu !== input.vcpu) {
      await deps.boxd.resize(name, input.vcpu)
      deps.guest.forget(name)
      await armAwake(name, "hold")
      return starting
    }
    if (machine.status !== "running") {
      if (machine.status === "hibernated" || machine.status === "standby" || machine.status === "stopped") {
        await deps.boxd.wake(name)
        await armAwake(name, "hold")
        await woke(input.workId)
      }
      return starting
    }
    await armAwake(name, "hold")
    checkGuest(await deps.guest.version(name), deps.hostVersion)
    if ((await deps.guest.server(name)) !== "up") return starting
    await prepareWorkspace(deps, name, directory, work.repo)
    return {
      result: {
        workId: input.workId,
        machine: name,
        guestDirectory,
        laptopDirectory,
        state: "ready",
        guestVersion: deps.hostVersion,
        ...(work.model ? { model: work.model } : {}),
        // A default model reaches the session the first prompt creates; one that exists already keeps its own.
        ...(model && work.rootSessionId ? { next: "The work's session exists already, so it keeps its model. Pass model to boxd_submit to switch it." } : {}),
      },
      created,
      ...size,
    }
  }

  return {
    /**
     * The ledger and each work's machine when the CLI answers. Never starts, wakes or runs a session. With `live` (the
     * tool, not the status command), each work also gets its phase and what its session last did, and the account's
     * sealed variables are listed by name.
     */
    async status(options: { readonly live?: boolean } = {}): Promise<FleetStatus> {
      const live = options.live === true
      const works = await deps.ledger.list()
      const [listing, names, secrets, summaries] = await Promise.all([
        deps.boxd.list().then(
          (machines) => ({ machines }),
          // The CLI's stderr is untrusted text: it reaches the model's tool output, so it is redacted and cut here.
          (error: unknown) => ({ error: reasonOf(error) }),
        ),
        snapshotNames(false),
        live
          ? deps.boxd.listSecrets().then(
              (list) => ({ secrets: list }),
              (error: unknown) => ({ error: reasonOf(error) }),
            )
          : undefined,
        Promise.all(works.map((work) => summarize(work, live))),
      ])
      const listed = "machines" in listing ? listing.machines : undefined
      const known = new Set(works.map((work) => work.machine))
      return {
        snapshot,
        snapshotPresent: names ? names.has(snapshot) : null,
        works: summaries,
        orphans: (listed ?? []).map((machine) => machine.name).filter((name) => name.startsWith("oc-") && !known.has(name)).sort(),
        cli: "machines" in listing ? { signedIn: true } : { signedIn: false, reason: listing.error },
        ...(secrets ? { credentials: secrets } : {}),
      }
    },

    async ensure(input: { workId: string; directory?: string; repo?: string; title?: string; model?: string; vcpu?: MachineSize; wait?: boolean }): Promise<FleetResult> {
      assertWorkId(input.workId)
      const model = input.model ? assertModel(input.model) : undefined
      // The laptop keeps the work in a folder of its own; the guest always works in /home/boxd/work/<work id>, because a
      // laptop path is not writable there and must never be sent to it. The folder is created when it does not exist.
      const laptopDirectory = await inField("directory", () =>
        resolveWorkDirectory(deps, input.directory ?? deps.projectDirectory, rootsOf(deps.projectDirectory, deps.allowedRoots), true),
      )
      const repo = input.repo ? assertRepo(input.repo) : undefined
      let created = false
      let current: number | undefined
      const result = await waited(
        input.wait,
        async () => {
          const opened = await openWork({ workId: input.workId, laptopDirectory, ...(repo ? { repo } : {}), ...(model ? { model } : {}), ...(input.vcpu ? { vcpu: input.vcpu } : {}) })
          created ||= opened.created
          current = opened.vcpu
          return opened.result
        },
        (answer) => answer.state === "starting",
      )
      return { ...result, ...sizeNote(input.vcpu, created, current) }
    },

    async submit(input: { workId: string; text: string; title?: string; model?: string; files?: ReadonlyArray<{ from: string; to: string }>; wait?: boolean }): Promise<FleetResult> {
      const work = await loadOwned(input.workId)
      if (!input.text.trim()) throw boxdError("NAME_INVALID", "text: the prompt is empty.", { field: "text" })
      const model = input.model ? assertModel(input.model) : undefined
      // Read and check every file before anything is copied or admitted: a path outside the roots fails the call whole.
      const incoming = await readIncoming(deps, input.files ?? [])
      // Nothing is copied or admitted until the machine and its OpenCode answer, so a poll inside the wait repeats no step.
      await waited(input.wait, () => ready(work, { wake: true }), () => false)
      const uploaded = await uploadAll(deps, work, incoming)
      let sessionId = work.rootSessionId
      // A new session starts on the call's model, else the work's default; an existing one switches only when asked.
      let switchTo = model
      let started: string | undefined
      if (!sessionId) {
        started = model ?? work.model
        const created = await deps.guest.createSession(work.machine, work.guestDirectory, input.title ?? input.workId, started)
        sessionId = assertSessionId(created.id)
        switchTo = undefined
        await deps.ledger.mutate(work.workId, (current) => ({ ...(current ?? work), rootSessionId: sessionId }))
      }
      // Stamped before the prompt: a crash between the two leaves the proof stale, never falsely fresh.
      const at = deps.now()
      await deps.ledger.mutate(work.workId, (current) => ({ ...(current ?? work), lastSubmitAt: at }))
      const { queued } = await deps.guest.prompt(work.machine, sessionId, input.text, switchTo)
      const onModel = switchTo ?? started
      return {
        workId: work.workId,
        machine: work.machine,
        sessionId,
        state: "admitted",
        ...(queued ? { queued: true } : {}),
        ...(onModel ? { model: onModel } : {}),
        ...(uploaded.length ? { files: uploaded.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })) } : {}),
        next: queued
          ? "The session was running, so this prompt waits in its inbox until that run takes it. Call boxd_job in a later turn: pending says how many wait."
          : "Call boxd_job in a later turn. This call did not wait for the model.",
      }
    },

    /**
     * One read. It never wakes a hibernated machine: it reports `asleep` with the machine's own state, and the next step
     * is the asking call that would wake it. `tail` adds the session's newest assistant messages, oldest first.
     */
    async job(input: { workId: string; tail?: number }): Promise<FleetResult> {
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
          ...asleepOf(work, status),
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
      const { phase, run, activity } = await deps.guest.phase(work.machine, work.rootSessionId, input.tail ? { tail: input.tail } : undefined)
      return {
        workId: work.workId,
        sessionId: work.rootSessionId,
        state: phase,
        proof: proofState(work),
        // The last run's outcome, so an idle session that failed is never read as a finished job.
        outcome: run.outcome,
        ...(run.outcome === "failed" ? { error: run.error, warning: failureCode(run) } : {}),
        // What the session last did, in its own words: a completed run can still report that its task did not happen.
        ...activity,
        next: jobNext(work.workId, phase, run),
      }
    },

    async harvest(input: { workId: string; localDirectory?: string; files?: readonly string[]; to?: string }): Promise<FleetResult> {
      const work = await loadOwned(input.workId)
      const roots = rootsOf(deps.projectDirectory, deps.allowedRoots)
      // The transcript lands in the work's laptop folder unless the call names another, and both must be inside a root.
      // A refusal names the field: `localDirectory` must be an existing folder, while `to` is made when it does not exist.
      const localDirectory = await inField("localDirectory", () => resolveWorkDirectory(deps, input.localDirectory ?? work.laptopDirectory, roots))
      // The files a work produced, read before the transcript moves: a refused path fails the call whole.
      const wanted = await Promise.all((input.files ?? []).map((path, index) => inField(`files[${index}]`, () => assertWorkPath(path))))
      const toDirectory = input.to ? await inField("to", () => resolveWorkDirectory(deps, input.to!, roots, true)) : localDirectory
      await ready(work, { wake: true })
      // A work that never had a prompt has no transcript to import, but its tree is still accounted for: the proof
      // records no session and the guest's git state, so drop applies its usual guard instead of refusing for good.
      if (!work.rootSessionId) return harvestEmpty(work, wanted, toDirectory)
      const { phase, run: live } = await deps.guest.phase(work.machine, work.rootSessionId)
      if (phase === "busy") throw boxdError("SESSION_BUSY", "The session is still running.")
      const listed = await deps.guest.listSessions(work.machine)
      const tree = collect(work.rootSessionId, listed)
      const transfers = order(await Promise.all(tree.map(async (id) => parseExport(await deps.guest.exportSession(work.machine, id)))))
      // The outcome comes from the transcript itself: the root export's session info and last idle message. The live
      // phase fills a gap when an export does not carry the session's own outcome.
      const root = transfers.find((transfer) => transfer.info.id === work.rootSessionId)
      const exported = readRun(root?.info, root?.messages)
      // An interrupted run is what happened last, even when the transcript carries an earlier run's outcome.
      const run: GuestRun = live.outcome === "aborted" ? live : exported.outcome ? exported : live
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
      const hibernated = machine.status !== "missing" && machine.status !== "destroyed"
      if (hibernated) {
        await deps.boxd.hibernate(work.machine)
        await armAwake(work.machine, "sleep")
      }
      // A work that never had a prompt has no unharvested prompt to warn about.
      const unharvested = work.lastSubmitAt !== undefined && proofState(work) !== "fresh"
      if (unharvested || hibernated) {
        const at = deps.now()
        await deps.ledger.mutate(work.workId, (current) => ({
          ...(current ?? work),
          // Recorded, so a later read can say the machine is down because it was put to sleep, not because it idled.
          ...(hibernated ? { sleptAt: at } : {}),
          ...(unharvested ? { warnings: addWarning(current?.warnings, { code: "UNHARVESTED_SLEEP", at }) } : {}),
        }))
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
        await woke(work.workId)
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
        // The rebuilt machine gets the size the work was created with; the resize reboots it, which costs nothing yet.
        if (work.vcpu && machine.vcpu !== work.vcpu) {
          await deps.boxd.resize(work.machine, work.vcpu)
          deps.guest.forget(work.machine)
          await armAwake(work.machine, "hold")
          return { workId: work.workId, machine: work.machine, state: "starting", resumed: "import", next: "Call boxd_resume again once boxd_status reports running." }
        }
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
        const { phase, run } = await deps.guest.phase(work.machine, work.rootSessionId)
        // The guest's OpenCode died mid-run: say so, and let the next calls keep what exists and start again.
        if (phase === "idle" && run.outcome === "aborted") throw boxdError("RUN_INTERRUPTED", "The run was interrupted: the guest's OpenCode stopped during it.")
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
        // Only a restored transcript is a prompt to harvest again; a work with no session has none.
        ...(transfers.length ? { lastSubmitAt: deps.now() } : {}),
        warnings: [],
      }))
      return {
        workId: work.workId,
        machine: work.machine,
        sessionId: root ?? null,
        state: "ready",
        resumed: "import",
        next: `${transfers.length ? "The transcript is back." : "This work has no session, so there was no transcript to restore."} Harvest again before sleep, image or drop, because the old proof was for the previous machine.`,
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
  throw boxdError("NAME_INVALID", info ? `"${path}" is not a folder.` : `"${path}" does not exist.`)
}

/** Every file to copy in, read and checked before anything is uploaded or admitted. */
async function readIncoming(deps: Deps, files: ReadonlyArray<{ from: string; to: string }>): Promise<Array<{ path: string; body: Buffer; bytes: number; sha256: string }>> {
  const roots = rootsOf(deps.projectDirectory, deps.allowedRoots)
  const seen = new Set<string>()
  const out: Array<{ path: string; body: Buffer; bytes: number; sha256: string }> = []
  for (const [index, file] of files.entries()) {
    const path = await inField(`files[${index}].to`, () => assertWorkPath(file.to))
    if (seen.has(path)) throw boxdError("NAME_INVALID", `files[${index}].to: two files copy to "${path}".`, { field: `files[${index}].to` })
    seen.add(path)
    const loaded = await inField(`files[${index}].from`, () => loadFile(file.from, roots))
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

/**
 * Why a machine that is down is down. `boxd_sleep` is recorded with its time; anything else is the idle bound or the
 * boxd CLI, whose time boxd does not report. A machine that is up has no answer.
 */
function asleepOf(work: Work, status: MachineInfo["status"]): { asleepBy?: AsleepBy; sleptAt?: string } {
  if (status !== "hibernated" && status !== "standby" && status !== "stopped") return {}
  return work.sleptAt && status === "hibernated" ? { asleepBy: "boxd_sleep", sleptAt: work.sleptAt } : { asleepBy: "idle_or_cli" }
}

/** What `boxd_ensure` hands one pass, once its input is checked. */
interface OpenInput {
  readonly workId: string
  readonly laptopDirectory: string
  readonly repo?: string
  readonly model?: string
  readonly vcpu?: MachineSize
}

const STARTING_NEXT = "Call boxd_status in a later turn, or call again with wait: true."

/**
 * What an ensure says about the size it was asked for: set on a machine it created, already that size, or kept on a
 * machine that was there with another size.
 */
function sizeNote(vcpu: MachineSize | undefined, created: boolean, current: number | undefined): FleetResult {
  if (!vcpu) return {}
  if (created || current === vcpu) return { vcpu }
  const was = current === undefined ? "its size" : `its ${current} vCPU`
  return {
    ...(current === undefined ? {} : { vcpu: current }),
    sizeNote: `The machine was already there, so it keeps ${was}: boxd applies a size by rebooting, which would stop a run. Resize it with the boxd CLI when it is idle.`,
  }
}

/** A guest read that has not answered within `ms` is a TIMEOUT, so a status of many works never waits on one. */
function deadline<T>(work: Promise<T>, ms: number, machine: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(boxdError("TIMEOUT", `The guest on ${machine} did not answer within ${ms / 1000} s.`)), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/** A work boxd or its guest did not answer for: the code, the redacted reason, and the code's next step. */
function unreachable(base: WorkSummary, error: unknown): WorkSummary {
  const { error: _, ...rest } = base
  const coded = error instanceof BoxdError ? error : undefined
  const code: Code = coded?.code ?? "BOXD_FAILED"
  return {
    ...rest,
    phase: "unreachable",
    error: code,
    message: shortReason(coded ? coded.what : error instanceof Error ? error.message : String(error)) ?? "no reason given",
    next: coded?.next ?? CODES[code],
  }
}

/** The activity a phase read returned, as status carries it: no tail, which only `boxd_job` asks for. */
function activityFields(activity: GuestActivity): Pick<WorkSummary, "lastActivityAt" | "lastText" | "pending"> {
  return {
    ...(activity.lastActivityAt ? { lastActivityAt: activity.lastActivityAt } : {}),
    ...(activity.lastText ? { lastText: activity.lastText } : {}),
    ...(activity.pending !== undefined ? { pending: activity.pending } : {}),
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
  if (git.untracked.length) return `Commit or delete ${some(git.untracked)} on the machine, then harvest again. boxd_drop will refuse until you do.`
  if (git.ignored.length) return `Remove ${some(git.ignored)} on the machine, then harvest again. boxd_drop will refuse until you do.`
  if (git.dirty) {
    return git.patchStored
      ? "The uncommitted change is stored as a patch on this laptop. Call boxd_sleep to hibernate, or boxd_drop, which keeps the patch and then destroys the machine."
      : "The uncommitted work has no patch on this laptop, so boxd_drop will refuse. Commit it on the machine, harvest again, or hibernate instead."
  }
  return "Call boxd_sleep to hibernate, or boxd_drop: the import is proven and the tree is clean."
}

const list = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`)

/** How many paths a sentence names before it counts the rest: an ignored `node_modules` can hold thousands. */
const NAMED_PATHS = 10
/** How many paths a refusal's `paths` carries for a program. */
const LISTED_PATHS = 50

/** The first few paths, and how many more there are. */
const some = (names: readonly string[]) =>
  names.length <= NAMED_PATHS ? list(names) : `${names.slice(0, NAMED_PATHS).join(", ")} and ${names.length - NAMED_PATHS} more`

/** A refusal's paths for a program: the first 50, and the count of them all. */
const pathDetails = (names: readonly string[]) => ({ paths: names.slice(0, LISTED_PATHS), count: names.length })

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
  if (lostUntracked.length) throw boxdError("UNTRACKED", `The guest tree has ${count(lostUntracked, "untracked path")} the patch cannot hold: ${some(lostUntracked)}.`, { kind: "untracked", ...pathDetails(lostUntracked) })
  if (lostIgnored.length) throw boxdError("UNTRACKED", `The guest tree has ${count(lostIgnored, "ignored path")} the patch cannot hold: ${some(lostIgnored)}.`, { kind: "ignored", ...pathDetails(lostIgnored) })
  if (git.dirty && !git.patchStored) throw boxdError("DIRTY", "The guest tree has uncommitted work and no patch in the ledger.")
}

const count = (names: readonly string[], noun: string) => `${names.length} ${noun}${names.length === 1 ? "" : "s"}`

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
