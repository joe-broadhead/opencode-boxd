/**
 * Package E's automation loop (design §C.2, §C.3): auto-harvest then auto-sleep of finished and orphaned works, lease
 * renewal, under `automation.lock`, never a drop. Package E owns this file. `src/plugin.ts` starts it once and disposes
 * it with the plugin.
 *
 * - **Consent** (round 4, M-2): harvest and sleep run only when `consent(options)` is on: by default at `access: "all"`,
 *   at the other levels only with the person's `automation: "on"`. Lease renewals need only `leaseDays`, which is
 *   itself the person's consent to them (§C.2).
 * - **One owner:** only the process holding `automation.lock` (B's heartbeat lock) acts, so a work is never harvested
 *   twice at once by two OpenCode processes.
 * - **A finished work** (idle for `autoSleepMinutes`, or ready with no prompt for 30 minutes) and **an orphan** (its
 *   coordinator deleted or archived, or untouched for `orphanHours`) is harvested, then slept. A busy work, and a work
 *   waiting on a person, is left alone. A failed harvest still sleeps (`UNHARVESTED_SLEEP`); a failed sleep is recorded
 *   (`AUTOMATION_BLOCKED`) and retried after 30 minutes.
 * - **Reads:** the loop works from the watcher's snapshot. The only guest read of an idle work is one `phase` read just
 *   before acting, under the read rule, which confirms no prompt arrived and nobody is asked anything.
 * - **Never a drop:** this module calls `actions.harvest` and `actions.sleep` only, tagged `automation`. It never calls
 *   `actions.drop`, removes a machine, or sets a delete timer the person did not opt into.
 */
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { allowed, sharedOf } from "./cost/shared.js"
import { isCode } from "./errors.js"
import { acquireLock, type LockHandle } from "./ledger/lock.js"
import { LEDGER_PATHS, type WorkRecord, type WorkWarning } from "./ledger/types.js"
import type { CallTag, MachineName, OpContext, PhaseAnswer, ReadTarget, WorkSnapshot } from "./ports.js"
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
/** Guest reads before acting, at once. */
const READ_CONCURRENCY = 4
/** Works acted on in one pass; the rest wait for the next one. */
const MAX_PER_TICK = 50

export type Why = "finished" | "orphan" | "lease"

export interface AutomationSeam {
  /** The loop's interval; tests shorten it. */
  readonly tickMs?: number
  /** Where `automation.lock` lives; the ledger root by default. */
  readonly lockPath?: string
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
const codeOf = (item: unknown) => {
  const code = (item as { error?: unknown } | undefined)?.error
  return isCode(code) ? code : "RUN_FAILED"
}

/** The loop itself, apart from its timer, so the unit tests drive each pass. */
export function automation(services: CostServices, seam: AutomationSeam = {}): Automation {
  const { options, watch, ledger, boxd, guest, importV0, actions, clock } = services
  const shared = sharedOf(services.cost)
  const consented = allowed(options)
  const lockPath = seam.lockPath ?? join(services.ledgerRoot, LEDGER_PATHS.automationLock)
  const log: { workId: string; why: Why; step: "harvest" | "sleep" | "renew" | "skip"; result: string }[] = []
  /** The last attempt per work: skipped until the work changes (a new idle start) or `RETRY_MS` passed. */
  const attempts = new Map<string, { readonly key: string; readonly at: number; readonly ok: boolean }>()
  const controller = new AbortController()
  let lock: LockHandle | null = null
  let calls = 0

  const tag = (): CallTag => ({ callId: `automation-${++calls}`, source: "automation" })
  const op = (call: CallTag, pool: OpContext["pool"] = "background"): OpContext => ({ call, signal: controller.signal, pool })
  const act = (call: CallTag): ActionContext => ({ by: "automation", call, signal: controller.signal })
  const now = () => clock.now().getTime()

  async function holdLock(): Promise<boolean> {
    if (lock && !lock.lost) return true
    try {
      await mkdir(services.ledgerRoot, { recursive: true, mode: 0o700 })
      lock = await acquireLock(lockPath, { purpose: "automation", waitMs: 0, signal: controller.signal })
    } catch {
      lock = null
    }
    shared.owner = lock ? "owner" : "not-owner"
    return lock !== null
  }

  /** Checks each coordinator once per pass with the host's own session read: archived or not found is gone. */
  async function checkCoordinators(works: readonly WorkSnapshot[]): Promise<void> {
    const targets = new Set(works.flatMap((work) => (work.notify && !shared.goneSessions.has(work.notify) ? [work.notify] : [])))
    for (const sessionID of targets) {
      try {
        const session = (await services.sessions.get({ sessionID })) as { time?: { archived?: number } } | undefined
        if (session?.time?.archived) shared.goneSessions.add(sessionID)
      } catch (error) {
        const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
        if (/not ?found|404/i.test(text)) shared.goneSessions.add(sessionID)
      }
    }
  }

  /** Why automation should harvest and sleep this work now, or nothing. */
  function due(work: WorkSnapshot, at: number): Why | undefined {
    if (!work.region || !work.machineId || work.needsInput !== undefined) return undefined
    if (work.phase !== "idle" && work.phase !== "ready") return undefined
    const idleFor = work.idleSince ? at - Date.parse(work.idleSince) : 0
    if (options.autoSleepMinutes > 0 && work.idleSince) {
      const after = work.phase === "idle" ? minutes(options.autoSleepMinutes) : minutes(Math.max(READY_IDLE_MINUTES, options.autoSleepMinutes))
      if (idleFor >= after) return "finished"
    }
    if (work.notify && shared.goneSessions.has(work.notify)) return "orphan"
    if (work.touchedAt && at - Date.parse(work.touchedAt) >= options.orphanHours * 60 * 60_000) return "orphan"
    return undefined
  }

  const attemptKey = (work: WorkSnapshot) => `${work.idleSince ?? ""}|${work.phase}`
  function shouldTry(work: WorkSnapshot, at: number): boolean {
    const last = attempts.get(work.workId)
    if (!last || last.key !== attemptKey(work)) return true
    return !last.ok && at - last.at >= RETRY_MS
  }

  /** The one guest read before acting: still running, not busy, nobody asked anything. */
  async function confirm(work: WorkSnapshot, record: WorkRecord | undefined): Promise<"act" | "skip" | "asleep"> {
    const call = tag()
    const listing = await boxd.list({ maxAgeMs: 2_000 }, op(call))
    const name = `oc-${work.workId}` as MachineName
    const row = listing.machines.find((machine) => machine.name === name && machine.region === work.region)
    if (!row || row.status !== "running") return "asleep"
    const sessionId = record?.session?.rootId
    // A work never prompted has no session to read: the listing is the only check it needs.
    if (!sessionId) return "act"
    const target: ReadTarget = { region: work.region!, name, listing, machineId: work.machineId }
    const answer: PhaseAnswer = record?.guestHelper === "v0" ? await importV0.readPhase(target, { sessionId }, op(call)) : await guest.phase(target, { sessionId }, op(call))
    return answer.phase === "busy" || answer.needsInput !== undefined ? "skip" : "act"
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
      services.report("automation", `Could not record ${code} for ${workId}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`)
    }
  }

  /** Harvest, then sleep, the confirmed works; a failed harvest still sleeps. */
  async function harvestThenSleep(works: ReadonlyArray<{ readonly work: WorkSnapshot; readonly why: Why }>): Promise<void> {
    if (!works.length) return
    const ids = works.map(({ work }) => work.workId)
    const whyOf = new Map(works.map(({ work, why }) => [work.workId, why]))
    const call = tag()
    const outcome = (result: ListResult<{ state: string }> | undefined, index: number, success: string) => {
      const item = result?.results[index] as { state?: string } | undefined
      return item?.state === success ? "ok" : (codeOf(item) as string)
    }
    let harvested: ListResult<{ state: string }> | undefined
    try {
      harvested = await actions.harvest(ids, act(call))
    } catch (error) {
      services.report("automation", `Automatic harvest failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`)
    }
    let slept: ListResult<{ state: string }> | undefined
    try {
      slept = await actions.sleep(ids, act(call))
    } catch (error) {
      services.report("automation", `Automatic sleep failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`)
    }
    for (const [index, workId] of ids.entries()) {
      const why = whyOf.get(workId)!
      const harvest = outcome(harvested, index, "saved")
      const sleep = outcome(slept, index, "asleep")
      log.push({ workId, why, step: "harvest", result: harvest }, { workId, why, step: "sleep", result: sleep })
      const work = works[index]!.work
      attempts.set(workId, { key: attemptKey(work), at: now(), ok: sleep === "ok" })
      if (sleep === "ok") {
        shared.failed.delete(workId)
        if (harvest !== "ok") await addWarning(workId, "UNHARVESTED_SLEEP")
      } else {
        shared.failed.set(workId, { step: "sleep", code: sleep, at: now() })
        await addWarning(workId, "AUTOMATION_BLOCKED")
      }
    }
  }

  async function sweep(): Promise<void> {
    const at = now()
    const works = watch.snapshot().works.filter((work) => work.phase === "idle" || work.phase === "ready")
    await checkCoordinators(works)
    const candidates = works.flatMap((work) => {
      const why = due(work, at)
      return why && shouldTry(work, at) ? [{ work, why }] : []
    })
    const confirmed: { work: WorkSnapshot; why: Why }[] = []
    const queue = candidates.slice(0, MAX_PER_TICK)
    const reader = async () => {
      for (let next = queue.shift(); next && !controller.signal.aborted; next = queue.shift()) {
        try {
          const answer = await confirm(next.work, await ledger.get(next.work.workId, op(tag())))
          if (answer === "act") confirmed.push(next)
          else {
            log.push({ workId: next.work.workId, why: next.why, step: "skip", result: answer })
            attempts.set(next.work.workId, { key: attemptKey(next.work), at: now(), ok: answer === "asleep" })
          }
        } catch (error) {
          const code = (error as { code?: unknown }).code
          shared.failed.set(next.work.workId, { step: "read", code: isCode(code) ? code : "RUN_FAILED", at: now() })
          attempts.set(next.work.workId, { key: attemptKey(next.work), at: now(), ok: false })
          log.push({ workId: next.work.workId, why: next.why, step: "skip", result: isCode(code) ? code : "RUN_FAILED" })
        }
      }
    }
    await Promise.all(Array.from({ length: READ_CONCURRENCY }, reader))
    // Input order, so a test and a person read the same sequence.
    confirmed.sort((a, b) => candidates.indexOf(a) - candidates.indexOf(b))
    await harvestThenSleep(confirmed)
  }

  /** `leaseDays` renewals for busy or unsaved works nobody calls, and a harvest before a lease ends (§C.2, L-2). */
  async function leases(): Promise<void> {
    const at = now()
    const phases = new Map(watch.snapshot().works.map((work) => [work.workId, work.phase]))
    const records = await ledger.list({}, op(tag()))
    const expiring: { work: WorkSnapshot; why: Why }[] = []
    for (const record of records) {
      if (!record.lease || !record.region || !record.machineId || controller.signal.aborted) continue
      const phase = phases.get(record.workId)
      const saved = ledger.saved(record)
      if ((phase === "busy" || saved !== "fresh") && at - Date.parse(record.lease.renewedAt) >= LEASE_RENEW_MS) {
        try {
          await renew(record.workId)
          log.push({ workId: record.workId, why: "lease", step: "renew", result: "ok" })
        } catch (error) {
          const code = (error as { code?: unknown }).code
          log.push({ workId: record.workId, why: "lease", step: "renew", result: isCode(code) ? code : "RUN_FAILED" })
        }
      }
      const work = watch.snapshot().works.find((item) => item.workId === record.workId)
      if (consented && work && phase === "idle" && saved !== "fresh" && Date.parse(record.lease.expiresAt) - at <= LEASE_WARN_MS && shouldTry(work, at)) expiring.push({ work, why: "lease" })
    }
    if (!expiring.length) return
    const call = tag()
    const ids = expiring.map(({ work }) => work.workId)
    try {
      const result = await actions.harvest(ids, act(call))
      for (const [index, { work }] of expiring.entries()) {
        const item = result.results[index] as { state?: string } | undefined
        attempts.set(work.workId, { key: attemptKey(work), at: now(), ok: item?.state === "saved" })
        log.push({ workId: work.workId, why: "lease", step: "harvest", result: item?.state === "saved" ? "ok" : codeOf(item) })
      }
    } catch (error) {
      services.report("automation", `Harvest before a lease ends failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`)
    }
  }

  /** One renewal, by id, under the work's lock and then the machine's (the lock order of §4.1). */
  async function renew(workId: string): Promise<void> {
    const call = tag()
    const context = op(call, "foreground")
    await ledger.update(
      [workId],
      async (current) => {
        const record = current.get(workId)
        if (!record?.lease || !record.region || !record.machineId) return { write: [], value: undefined }
        const { region, machine, machineId } = record
        await services.runner.withMachineLock({ id: machineId }, context, async () => {
          const target = await boxd.checkOwned(region, machine, machineId, context)
          await boxd.renewLease(target, options.leaseDays, context)
        })
        const renewedAt = clock.now()
        const lease = { days: options.leaseDays, renewedAt: renewedAt.toISOString(), expiresAt: new Date(renewedAt.getTime() + options.leaseDays * 24 * 60 * 60_000).toISOString() }
        return { write: [{ ...record, lease }], value: undefined }
      },
      context,
    )
  }

  async function pass(): Promise<void> {
    try {
      if (options.budget) await services.cost.budget(tag()).catch(() => undefined)
      if (!consented && options.leaseDays === 0) return
      if (!(await holdLock())) return
      if (consented) await sweep()
      if (options.leaseDays > 0) await leases()
    } catch (error) {
      if (controller.signal.aborted) return
      services.report("automation", `The automation pass failed: ${error instanceof Error ? error.message.split("\n")[0]!.slice(0, 160) : String(error)}`)
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
      const held = lock
      lock = null
      await held?.release().catch(() => undefined)
    },
  }
}

/**
 * Starts the loop: a pass every `TICK_MS`, and one soon after a phase change or a coordinator's deletion. Nothing runs
 * when there is nothing to do: no consent, no lease and no budget means no timer at all.
 */
export function startAutomation(services: CostServices, seam: AutomationSeam = {}): Dispose {
  const options = services.options
  if (!allowed(options) && options.leaseDays === 0 && !options.budget) return async () => {}
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
