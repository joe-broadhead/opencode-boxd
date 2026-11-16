/**
 * Package E's automation loop (design §C.2, §C.3): auto-harvest then auto-sleep of finished and orphaned works, lease
 * renewal, under two locks, never a drop. Package E owns this file. `src/plugin.ts` starts it once and disposes
 * it with the plugin.
 *
 * - **Consent** (round 4, M-2): harvest and sleep run only when `consent(options)` is on: by default at `access: "all"`,
 *   at the other levels only with the person's `automation: "on"`.
 * - **Leases protect work, at every access level.** A work's `lease` is the delete-after timer boxd enforces, set with the
 *   person's `leaseDays` when the work was made: that is the consent (§C.2). So every open record that holds a lease is
 *   renewed with its own `lease.days`, whatever this process's `leaseDays` is, while it is busy or not saved; a renewal
 *   never shortens a lease.
 * - **Two locks, two jobs** (B's heartbeat lock for both). `lease.lock`: any process may take it while an open record
 *   holds a lease, whatever its consent, and its holder alone renews. `automation.lock`: only a process with consent ever
 *   takes it, and its holder alone harvests and sleeps, so a process without consent that renews leases never keeps a
 *   consenting one from cleaning up. Each holder checks its lock again just before each action, so a work is never
 *   harvested or renewed twice at once by two OpenCode processes.
 * - **A finished work** (idle for `autoSleepMinutes`, or ready with no prompt for 30 minutes) and **an orphan** (its
 *   coordinator deleted, archived or re-parented, as the watcher marks it, or untouched for `orphanHours`) is harvested,
 *   then slept, one work at a time. Harvest's export checks the tree is idle in its own exec, so it is the one guest
 *   read before acting. The work is slept only when that harvest answered `saved`, or failed for an old guest or a
 *   timeout (then `UNHARVESTED_SLEEP`: hibernation keeps the memory and the disk). Any other answer, a busy session
 *   above all, means the work moved on or cannot be saved, and it is not slept. A busy work, and one waiting on a
 *   person, is never touched.
 * - **Never a drop:** this module calls `actions.harvest` and `actions.sleep` only, tagged `automation`. It never calls
 *   `actions.drop`, removes a machine, or sets a delete timer the person did not opt into.
 */
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { allowed, sharedOf } from "./cost/shared.js"
import { isCode, type Code } from "./errors.js"
import { acquireLock, type LockHandle } from "./ledger/lock.js"
import { LEDGER_PATHS, type WorkRecord, type WorkWarning } from "./ledger/types.js"
import type { CallTag, MachineName, OpContext, WorkSnapshot } from "./ports.js"
import type { ListResult } from "./results.js"
import type { ActionContext, CostServices, Dispose } from "./services.js"

/** How often the loop looks at the fleet; an event wakes it sooner. */
export const TICK_MS = 60_000
/** A ready work with no prompt counts as finished after this long. */
export const READY_IDLE_MINUTES = 30
/** A failed automatic step is tried again after this long. */
export const RETRY_MS = 30 * 60_000
/** A lease is renewed at most this often per work. */
export const LEASE_RENEW_MS = 6 * 60 * 60_000
/** Before a lease ends, an idle unsaved work is harvested. */
export const LEASE_WARN_MS = 24 * 60 * 60_000
/** Works acted on at once, each harvest then sleep. */
const ACT_CONCURRENCY = 4
/** Works acted on in one pass; the rest wait for the next one. */
const MAX_PER_TICK = 50
/**
 * The harvest failures after which the work is still slept (§C.3 step 1): an old guest whose transcript cannot move, and
 * a step that did not answer in time. Both leave the work idle, and hibernating it keeps everything.
 */
export const SLEEP_DESPITE: ReadonlySet<Code> = new Set(["GUEST_VERSION", "TIMEOUT"])

export type Why = "finished" | "orphan" | "lease"

export interface AutomationSeam {
  /** The loop's interval; tests shorten it. */
  readonly tickMs?: number
  /** Where `automation.lock` lives; the ledger root by default. */
  readonly lockPath?: string
  /** Where `lease.lock` lives; the ledger root by default. */
  readonly leaseLockPath?: string
}

export interface Automation {
  /** One pass: the budget refresh, the lock, harvest and sleep, the lease renewals. Never throws. */
  tick(): Promise<void>
  /** What the loop did, for tests and status: per work, why and how it ended. */
  readonly log: ReadonlyArray<{ readonly workId: string; readonly why: Why; readonly step: "harvest" | "sleep" | "renew" | "skip"; readonly result: string }>
  dispose(): Promise<void>
}

const minutes = (value: number) => value * 60_000

/** A refusal's code, or `RUN_FAILED` for anything that is not a §5 code. */
const codeOf = (item: unknown): Code => {
  const code = (item as { error?: unknown } | undefined)?.error
  return isCode(code) ? code : "RUN_FAILED"
}

/** The lease renewer's lock, beside `automation.lock` in the ledger root. */
export const LEASE_LOCK = "lease.lock"

/** One cross-process lock this loop may hold: taken without waiting, checked again before each action. */
function holder(path: string, purpose: string, root: string, signal: AbortSignal) {
  let lock: LockHandle | null = null
  return {
    /** Holds the lock now, taking it if it is free; false when another live process holds it. */
    async hold(): Promise<boolean> {
      if (lock && !lock.lost) return true
      try {
        await mkdir(root, { recursive: true, mode: 0o700 })
        lock = await acquireLock(path, { purpose, waitMs: 0, signal })
      } catch {
        lock = null
      }
      return lock !== null
    },
    /** Still held, read from the lock folder now. */
    async still(): Promise<boolean> {
      return lock !== null && !lock.lost && !signal.aborted && (await lock.holds().catch(() => false))
    },
    async release(): Promise<void> {
      const held = lock
      lock = null
      await held?.release().catch(() => undefined)
    },
  }
}

/** The loop itself, apart from its timer, so the unit tests drive each pass. */
export function automation(services: CostServices, seam: AutomationSeam = {}): Automation {
  const { options, watch, ledger, boxd, actions, clock } = services
  const shared = sharedOf(services.cost)
  const consented = allowed(options)
  const controller = new AbortController()
  const cleanupLock = holder(seam.lockPath ?? join(services.ledgerRoot, LEDGER_PATHS.automationLock), "automation", services.ledgerRoot, controller.signal)
  const leaseLock = holder(seam.leaseLockPath ?? join(services.ledgerRoot, LEASE_LOCK), "lease", services.ledgerRoot, controller.signal)
  const log: { workId: string; why: Why; step: "harvest" | "sleep" | "renew" | "skip"; result: string }[] = []
  /** The last attempt per work: skipped until the work changes (a new idle start) or `RETRY_MS` passed. */
  const attempts = new Map<string, { readonly key: string; readonly at: number; readonly ok: boolean }>()
  let calls = 0

  const tag = (): CallTag => ({ callId: `automation-${++calls}`, source: "automation" })
  const op = (call: CallTag, pool: OpContext["pool"] = "background"): OpContext => ({ call, signal: controller.signal, pool })
  const act = (call: CallTag): ActionContext => ({ by: "automation", call, signal: controller.signal })
  const now = () => clock.now().getTime()
  const message = (error: unknown) => (error instanceof Error ? error.message.split("\n")[0]!.slice(0, 160) : String(error))

  /** Holds `automation.lock` (consenting processes only); status's `not-owner` when another process holds it. */
  async function holdCleanup(): Promise<boolean> {
    const held = await cleanupLock.hold()
    shared.owner = held ? "owner" : "not-owner"
    return held
  }

  /** Still the cleanup owner, read from the lock folder now: checked just before each work's actions. */
  async function stillOwner(): Promise<boolean> {
    const held = await cleanupLock.still()
    if (!held) shared.owner = "not-owner"
    return held
  }

  /** Why automation should harvest and sleep this work now, or nothing. */
  function due(work: WorkSnapshot, at: number): Why | undefined {
    if (!work.region || !work.machineId || work.needsInput !== undefined) return undefined
    if (work.phase !== "idle" && work.phase !== "ready") return undefined
    if (options.autoSleepMinutes > 0 && work.idleSince) {
      const idleFor = at - Date.parse(work.idleSince)
      const after = work.phase === "idle" ? minutes(options.autoSleepMinutes) : minutes(Math.max(READY_IDLE_MINUTES, options.autoSleepMinutes))
      if (idleFor >= after) return "finished"
    }
    if (work.orphaned) return "orphan"
    if (work.touchedAt && at - Date.parse(work.touchedAt) >= options.orphanHours * 60 * 60_000) return "orphan"
    return undefined
  }

  const attemptKey = (work: WorkSnapshot) => `${work.idleSince ?? ""}|${work.phase}`
  function shouldTry(work: WorkSnapshot, at: number): boolean {
    const last = attempts.get(work.workId)
    if (!last || last.key !== attemptKey(work)) return true
    return !last.ok && at - last.at >= RETRY_MS
  }

  async function addWarning(workId: string, code: WorkWarning["code"]): Promise<void> {
    try {
      await ledger.update(
        [workId],
        async (current) => {
          const record = current.get(workId)
          if (!record || record.warnings?.some((warning) => warning.code === code)) return { write: [], value: undefined }
          return { write: [{ ...record, warnings: [...(record.warnings ?? []), { code, at: clock.now().toISOString() }] }], value: undefined }
        },
        op(tag(), "foreground"),
      )
    } catch (error) {
      services.report("automation", `Could not record ${code} for ${workId}: ${message(error)}`)
    }
  }

  /** One work: still running and still ours, then harvest, then sleep only when the harvest allows it. */
  async function harvestThenSleep(work: WorkSnapshot, why: Why): Promise<void> {
    const { workId } = work
    const done = (ok: boolean) => attempts.set(workId, { key: attemptKey(work), at: now(), ok })
    // A machine already asleep is left alone: a harvest would wake it.
    const listing = await boxd.list({ maxAgeMs: 2_000 }, op(tag()))
    const name = `oc-${workId}` as MachineName
    const row = listing.machines.find((machine) => machine.name === name && machine.region === work.region)
    if (!row || row.status !== "running") {
      log.push({ workId, why, step: "skip", result: "asleep" })
      return void done(true)
    }
    if (!(await stillOwner())) {
      log.push({ workId, why, step: "skip", result: "not-owner" })
      return
    }
    const call = tag()
    let harvested: ListResult<{ state: string }>
    try {
      harvested = await actions.harvest([workId], act(call))
    } catch (error) {
      services.report("automation", `Automatic harvest of ${workId} failed: ${message(error)}`)
      shared.failed.set(workId, { step: "harvest", code: "RUN_FAILED", at: now() })
      log.push({ workId, why, step: "harvest", result: "RUN_FAILED" })
      return void done(false)
    }
    const item = harvested.results[0] as { state?: string } | undefined
    const saved = item?.state === "saved"
    const harvest = saved ? "ok" : item?.state === "partial" ? "partial" : codeOf(item)
    log.push({ workId, why, step: "harvest", result: harvest })
    if (!saved && !SLEEP_DESPITE.has(harvest as Code)) {
      // The work moved on (a new prompt: busy, or a partial export of a running tree), or it cannot be saved now: it is
      // left running, never frozen mid-run. A busy work is not a failure; anything else is recorded.
      if (harvest !== "SESSION_BUSY" && harvest !== "partial") {
        shared.failed.set(workId, { step: "harvest", code: harvest, at: now() })
        await addWarning(workId, "AUTOMATION_BLOCKED")
      }
      return void done(false)
    }
    let sleep: string
    try {
      const slept = await actions.sleep([workId], act(call))
      const answer = slept.results[0] as { state?: string } | undefined
      sleep = answer?.state === "asleep" ? "ok" : codeOf(answer)
    } catch (error) {
      services.report("automation", `Automatic sleep of ${workId} failed: ${message(error)}`)
      sleep = "RUN_FAILED"
    }
    log.push({ workId, why, step: "sleep", result: sleep })
    done(sleep === "ok")
    if (sleep === "ok") {
      shared.failed.delete(workId)
      if (!saved) await addWarning(workId, "UNHARVESTED_SLEEP")
    } else {
      shared.failed.set(workId, { step: "sleep", code: sleep, at: now() })
      await addWarning(workId, "AUTOMATION_BLOCKED")
    }
  }

  async function sweep(): Promise<void> {
    const at = now()
    const queue = watch
      .snapshot()
      .works.flatMap((work) => {
        const why = due(work, at)
        return why && shouldTry(work, at) ? [{ work, why }] : []
      })
      .slice(0, MAX_PER_TICK)
    const worker = async () => {
      for (let next = queue.shift(); next && !controller.signal.aborted; next = queue.shift()) {
        try {
          await harvestThenSleep(next.work, next.why)
        } catch (error) {
          services.report("automation", `Automation of ${next.work.workId} failed: ${message(error)}`)
          attempts.set(next.work.workId, { key: attemptKey(next.work), at: now(), ok: false })
        }
      }
    }
    await Promise.all(Array.from({ length: ACT_CONCURRENCY }, worker))
  }

  /** The open records holding a lease; none until the v0 import is complete, so the loop never starts the import. */
  async function leased(): Promise<readonly WorkRecord[]> {
    if (services.importV0.state().state !== "complete") return []
    try {
      return (await ledger.list({}, op(tag()))).filter((record) => record.lease !== undefined)
    } catch {
      return []
    }
  }

  /**
   * Renewals for busy or unsaved leased works, with each lease's own days, by the `lease.lock` holder (`renewing`); and a
   * harvest before a lease ends, by the `automation.lock` holder (`cleaning`) only (§C.2, L-2).
   */
  async function leases(records: readonly WorkRecord[], renewing: boolean, cleaning: boolean): Promise<void> {
    const at = now()
    const snapshot = new Map(watch.snapshot().works.map((work) => [work.workId, work]))
    const other = records.filter((record) => record.lease!.days !== options.leaseDays)
    services.report(
      "lease",
      other.length
        ? `${other.length} open ${other.length === 1 ? "work holds" : "works hold"} a lease (the timer boxd deletes a machine at) of another length than leaseDays (${options.leaseDays}) would set, from the option when ${other.length === 1 ? "it was" : "they were"} made (${other
            .slice(0, 5)
            .map((record) => `${record.workId}: ${record.lease!.days}d`)
            .join(", ")}${other.length > 5 ? ", …" : ""}). The plugin keeps renewing each with its own length while it is busy or unsaved; boxd_drop ends one.`
        : undefined,
    )
    const expiring: WorkSnapshot[] = []
    for (const record of records) {
      if (!record.region || !record.machineId || controller.signal.aborted) continue
      const work = snapshot.get(record.workId)
      const saved = ledger.saved(record)
      if (renewing && (work?.phase === "busy" || saved !== "fresh") && at - Date.parse(record.lease!.renewedAt) >= LEASE_RENEW_MS) {
        if (!(await leaseLock.still())) return
        try {
          await renew(record.workId)
          log.push({ workId: record.workId, why: "lease", step: "renew", result: "ok" })
        } catch (error) {
          log.push({ workId: record.workId, why: "lease", step: "renew", result: codeOfError(error) })
        }
      }
      if (cleaning && work && work.phase === "idle" && saved !== "fresh" && Date.parse(record.lease!.expiresAt) - at <= LEASE_WARN_MS && shouldTry(work, at)) expiring.push(work)
    }
    for (const work of expiring) {
      if (!(await stillOwner())) return
      try {
        const result = await actions.harvest([work.workId], act(tag()))
        const item = result.results[0] as { state?: string } | undefined
        attempts.set(work.workId, { key: attemptKey(work), at: now(), ok: item?.state === "saved" })
        log.push({ workId: work.workId, why: "lease", step: "harvest", result: item?.state === "saved" ? "ok" : codeOf(item) })
      } catch (error) {
        services.report("automation", `Harvest before ${work.workId}'s lease ends failed: ${message(error)}`)
      }
    }
  }

  /**
   * One renewal, by id, under the work's lock and then the machine's (the lock order of §4.1), with the lease's own
   * length: a renewal moves the end later and never shortens it.
   */
  async function renew(workId: string): Promise<void> {
    const context = op(tag(), "foreground")
    await ledger.update(
      [workId],
      async (current) => {
        const record = current.get(workId)
        if (!record?.lease || !record.region || !record.machineId) return { write: [], value: undefined }
        const { region, machine, machineId } = record
        const days = record.lease.days
        await services.runner.withMachineLock({ id: machineId }, context, async () => {
          const { target } = await boxd.checkOwned(region, machine, machineId, context)
          await boxd.renewLease(target, days, context)
        })
        const renewedAt = clock.now()
        const expiresAt = new Date(Math.max(renewedAt.getTime() + days * 24 * 60 * 60_000, Date.parse(record.lease.expiresAt))).toISOString()
        return { write: [{ ...record, lease: { days, renewedAt: renewedAt.toISOString(), expiresAt } }], value: undefined }
      },
      context,
    )
  }

  async function pass(): Promise<void> {
    try {
      if (options.budget) await services.cost.budget(tag()).catch(() => undefined)
      const holding = await leased()
      // Only a process with consent ever takes automation.lock; any process may renew leases.
      const cleaning = consented && (await holdCleanup())
      if (cleaning) await sweep()
      if (!holding.length) {
        services.report("lease", undefined)
        return
      }
      const renewing = await leaseLock.hold()
      if (renewing || cleaning) await leases(holding, renewing, cleaning)
    } catch (error) {
      if (controller.signal.aborted) return
      services.report("automation", `The automation pass failed: ${message(error)}`)
    }
  }
  let current: Promise<void> = Promise.resolve()

  return {
    log,
    tick() {
      if (controller.signal.aborted) return Promise.resolve()
      current = current.then(pass)
      return current
    },
    async dispose() {
      // Stop first and let the pass in flight end, then give the lock up: no other process acts while this one does.
      controller.abort()
      await current
      await Promise.all([cleanupLock.release(), leaseLock.release()])
    },
  }
}

/** A thrown error's code, when it carries one from the table. */
const codeOfError = (error: unknown): Code => {
  const code = (error as { code?: unknown } | undefined)?.code
  return isCode(code) ? code : "RUN_FAILED"
}

/**
 * Starts the loop: a pass at start, every `TICK_MS`, and soon after a phase change or a coordinator's deletion. A pass
 * with no consent, no leased work and no budget reads nothing from boxd and takes no lock.
 */
export function startAutomation(services: CostServices, seam: AutomationSeam = {}): Dispose {
  const loop = automation(services, seam)
  const shared = sharedOf(services.cost)
  let stopped = false
  let wake: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const nap = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve
      timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  const poke = () => wake?.()
  shared.poke = poke
  const unsubscribe = services.watch.subscribe(poke)
  const running = (async () => {
    while (!stopped) {
      await loop.tick()
      if (stopped) break
      await nap(seam.tickMs ?? TICK_MS)
      clearTimeout(timer)
    }
  })()
  return async () => {
    stopped = true
    unsubscribe()
    shared.poke = () => {}
    poke()
    await loop.dispose()
    await running
  }
}
