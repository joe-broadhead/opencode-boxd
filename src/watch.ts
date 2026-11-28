/**
 * Package D's watcher and notices (design §3.13): the sweep, `events.jsonl`, the notices to each work's root
 * coordinator, and the event stream package E consumes. Package D owns this file, `src/notices.ts` and
 * `src/fleet/model.ts`. `src/index.ts` calls `createWatch` once and disposes it with the plugin.
 *
 * - **A local tick every 60 s** (no CLI call): it reads the ledger's index and tails `events.jsonl`, only when the file
 *   changed, so an event a change tool or another OpenCode process appended reaches the subscribers and the notices.
 * - **A sweep, while any open work is busy, creating or starting** (or idle and running inside its `autoSleepMinutes`
 *   window, for automation): one `machine list --region all --json`, then one read-only `phase` read for each busy work
 *   the listing just showed `running`, in the background pool (at most 4 at once, one per machine). It never reads an
 *   idle, ready or asleep guest, because an inbound exec resets the machine's idle clock, and it never uploads anything.
 *   The sweep runs every 60 s, or every twice its own duration when that is longer.
 * - **A phase change is appended** to `events.jsonl` (`unreachable` after two failed reads in a row, `gone` after two
 *   listings in a row without the machine), handed to every subscriber in `seq` order, and queued as a notice; the
 *   queue's durable cursor per coordinator (`src/notice-cursors.ts`) keeps each change to one delivery.
 * - **Every tick that appended or tailed an event** calls `changed` once, after all its events, so the works source's
 *   subscribers can re-read. A tick with nothing new calls nothing, and a failed call never loses the event.
 * - **It stops** sweeping when nothing is busy, when the plugin is disposed, and after three failed sweeps in a row
 *   (`boxd_status`'s `health.watcher` says why; the next status call starts it again).
 */
import { statSync } from "node:fs"
import { join } from "node:path"
import { LEDGER_PATHS, type Phase, type WorkRecord } from "./ledger/types.js"
import { base, codeOf, notRead, observe, observeFailure, outcomeOf, phaseOf, promptedSince, readGuest, recordPhase, STATUS_TEXT_LIMIT, wantsRead, type Observed } from "./fleet/model.js"
import { FileNoticeCursors } from "./notice-cursors.js"
import { checkTarget, NoticeQueue, type DroppedNotice, type GoneCause } from "./notices.js"
import type { DoneReport, FleetSnapshot, FleetWatch, Listing, OpContext, WorkEvent, WorkSnapshot } from "./ports.js"
import { TIMEOUTS } from "./ports.js"
import { reasonOf } from "./redact.js"
import type { CoreServices, Dispose } from "./services.js"

/** The sweep's interval, and the local tick's. */
export const WATCH_INTERVAL_MS = 60_000
/** The watcher does not read a guest that status or a job read this recently. */
const WATCH_READ_REUSE_MS = 30_000
/** Failed sweeps in a row before the watcher stops and says why. */
const STOP_AFTER_FAILURES = 3
/** Late automation reads: the watcher keeps sweeping this long past `autoSleepMinutes` for an idle running work. */
const AUTOMATION_SLACK_MS = 2 * 60_000

/** What package D's status and job read and feed: the watcher's knowledge, shared in-process. */
export interface WatchHandle {
  /** What the plugin last observed of a work's guest, or undefined. */
  observed(workId: string): Observed | undefined
  /** Records a guest read made by status or a job: the watcher appends the change at its next sweep. */
  remember(workId: string, observed: Observed): void
  /** Tails the event log and returns the newest cursor. */
  cursor(context: OpContext): Promise<number>
  /** Starts the watcher again when it stopped, and makes it sweep soon when there is something to watch. */
  kick(): void
  health(): { readonly notices: readonly DroppedNotice[]; readonly watcher?: string }
  /** Why a work is an orphan: its coordinator session is gone, archived or under another session (§3.13, §C.3). */
  orphaned(workId: string): WorkSnapshot["orphaned"]
}

const handles = new WeakMap<FleetWatch, WatchHandle>()

/** The handle behind a watcher this module built; undefined for any other `FleetWatch`. */
export const watchHandle = (watch: FleetWatch): WatchHandle | undefined => handles.get(watch)

export interface WatchOptions {
  /** Start the timer at once (the plugin) or not (tests, which call `tick`). */
  readonly autoStart?: boolean
  readonly intervalMs?: number
  /** Called once after a tick that appended or tailed at least one event: the plugin nudges the works source with the contract's `changed`. */
  readonly changed?: () => void | Promise<void>
}

export interface Watcher {
  readonly watch: FleetWatch
  readonly dispose: Dispose
  readonly handle: WatchHandle
  /** One tick now: the local read, and a sweep when there is something to watch. */
  tick(): Promise<void>
  /** Posts the notices that are due now. */
  flushNotices(): Promise<void>
}

const ACTIVE: ReadonlySet<Phase> = new Set<Phase>(["busy", "creating", "starting", "unreachable"])

export function createWatch(core: CoreServices, options: WatchOptions = {}): Watcher {
  const auto = options.autoStart ?? true
  const interval = options.intervalMs ?? WATCH_INTERVAL_MS
  const now = () => core.clock.now()
  const observed = new Map<string, Observed>()
  /** The last phase the event log holds per work, and when. */
  /** `seenAt` is when this process learned it (`Date.now()`, the listing's clock). */
  const logged = new Map<string, { readonly phase: Phase; readonly at: string; readonly seenAt: number }>()
  const records = new Map<string, WorkRecord>()
  const listeners = new Set<(event: WorkEvent) => void>()
  /** Sequence numbers this process already handed out, so the tail does not hand them out twice. */
  const dispatched = new Set<number>()
  /** Works whose coordinator is gone: written only here, from the sweep, a dropped notice, or `sessionGone`. */
  const orphans = new Map<string, NonNullable<WorkSnapshot["orphaned"]>>()
  /** The listing that last counted a work's machine as absent. */
  const absentListing = new Map<string, number>()
  const abort = new AbortController()
  let cursor = 0
  let seeded = false
  let logStamp = ""
  let listingAt: string | undefined
  let sweepFailures = 0
  let problem: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = !auto
  let disposed = false
  let lastSweepMs = 0
  let current: Promise<void> | undefined
  let calls = 0

  const notices = new NoticeQueue({
    mode: () => core.options.notices,
    sessions: core.sessions,
    now,
    cursors: new FileNoticeCursors(core.ledgerRoot),
    unsubscribe: (session, cause) => orphan(session, cause),
    report: (problem) => core.report("notices", problem),
  })

  /**
   * A coordinator session is gone: its open works are marked orphaned (when `cause` says it is gone, rather than that
   * the host refused a notice), and their `session.notify` is cleared. Never throws.
   */
  async function orphan(session: string, cause?: GoneCause): Promise<void> {
    const ids = [...records.values()].filter((record) => record.state === "open" && record.session?.notify === session).map((record) => record.workId)
    if (cause) for (const id of ids) if (!orphans.has(id)) orphans.set(id, { why: cause, session, at: now().toISOString() })
    if (!ids.length) return
    try {
      await core.ledger.update(
        ids,
        async (current) => ({
          write: [...current.values()].flatMap((record) => {
            if (!record || record.session?.notify !== session) return []
            const { notify: _gone, ...rest } = record.session
            return [{ ...record, session: rest }]
          }),
          value: undefined,
        }),
        context(),
      )
    } catch (error) {
      core.report("notices", `A notice target could not be unsubscribed: ${reasonOf(error)}.`)
    }
  }

  function context(): OpContext {
    return { call: { callId: `watcher-${++calls}`, source: "watcher" }, pool: "background", signal: abort.signal }
  }

  function phaseNow(record: WorkRecord): Phase {
    return observed.get(record.workId)?.phase ?? logged.get(record.workId)?.phase ?? (record.state === "closed" ? "closed" : recordPhase(record))
  }

  function dispatch(event: WorkEvent, notice: boolean, record = records.get(event.workId)): void {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch (error) {
        core.report("watch-subscriber", `A watcher subscriber failed: ${reasonOf(error)}.`)
      }
    }
    if (!notice) return
    notices.enqueue(event, record?.session?.notify, record ? core.ledger.saved(record) : "none")
  }

  /** What an event says, kept unless a guest read since is newer. */
  function learn(event: WorkEvent): void {
    logged.set(event.workId, { phase: event.to, at: event.at, seenAt: Date.now() })
    const previous = observed.get(event.workId)
    if (previous?.readAt !== undefined && previous.readAt >= Date.parse(event.at)) return
    const at = new Date(event.at)
    observed.set(event.workId, {
      ...base(previous, event.to, at),
      outcome: event.to === "idle" ? (event.outcome ?? null) : (previous?.outcome ?? null),
      ...(event.code !== undefined ? { code: event.code as Observed["code"] } : {}),
      ...(event.needsInput ? { needsInput: event.needsInput } : {}),
      ...(event.reading ? { reading: { ...event.reading, at: event.at } } : {}),
    })
  }

  /**
   * Seeds once from the ledger's cached phases (the `to` of each work's last event, with no replay of the log) and the
   * log's newest cursor, then tails the log whenever the file changed. Answers how many events it handed out.
   */
  async function sync(op: OpContext): Promise<number> {
    // The events of one tail go out together: nothing is posted until the whole page is dispatched.
    notices.hold()
    try {
      return await tail(op)
    } finally {
      notices.release()
    }
  }

  async function tail(op: OpContext): Promise<number> {
    if (!seeded) {
      const phases = await core.ledger.phases({}, op)
      const at = now()
      for (const [workId, entry] of phases) {
        if (entry.phase === null) continue
        // Known from the index, not from a read or an event this process saw: it never blocks a listing.
        logged.set(workId, { phase: entry.phase, at: new Date(0).toISOString(), seenAt: 0 })
        if (!observed.has(workId)) observed.set(workId, base(undefined, entry.phase, at))
      }
      cursor = (await core.ledger.eventsSince(0, op)).cursor
      seeded = true
      logStamp = stampOf()
      return 0
    }
    const stamp = stampOf()
    if (stamp === logStamp) return 0
    const page = await core.ledger.eventsSince(cursor, op)
    let tailed = 0
    for (const event of page.events) {
      if (event.seq <= cursor || dispatched.has(event.seq)) continue
      learn(event)
      // A work a change tool just closed has left the open list: its record still names its coordinator.
      const record = records.get(event.workId) ?? (await core.ledger.get(event.workId, op).catch(() => undefined))
      dispatch(event, true, record)
      tailed += 1
    }
    cursor = Math.max(cursor, page.cursor)
    for (const seq of dispatched) if (seq <= cursor) dispatched.delete(seq)
    logStamp = stamp
    return tailed
  }

  /** The event log's size and mtime: the tail reads the log only when this changed. */
  function stampOf(): string {
    try {
      const info = statSync(join(core.ledgerRoot, LEDGER_PATHS.events))
      return `${info.size}:${info.mtimeMs}`
    } catch {
      return "absent"
    }
  }

  function wantsSweep(open: readonly WorkRecord[]): boolean {
    const at = now().getTime()
    const window = core.options.autoSleepMinutes * 60_000 + AUTOMATION_SLACK_MS
    return open.some((record) => {
      if (record.pendingCreate) return true
      const phase = phaseNow(record)
      if (ACTIVE.has(phase)) return true
      if (promptedSince(record, observed.get(record.workId))) return true
      if ((phase === "idle" || phase === "ready") && core.options.autoSleepMinutes > 0) {
        const since = Date.parse(observed.get(record.workId)?.since ?? "")
        return !Number.isNaN(since) && at - since < window
      }
      return false
    })
  }

  async function append(record: WorkRecord, phase: Phase, obs: Observed | undefined, op: OpContext): Promise<void> {
    const before = logged.get(record.workId)
    const outcome = phase === "idle" ? outcomeOf(record, obs) : undefined
    const done = phase === "idle" ? obs?.done : undefined
    // An idle event carries a code for a failed run, and for any code the observation has (a missing session).
    const code = phase === "idle" ? (outcome === "failed" || obs?.code ? codeOf(record, obs) : undefined) : phase === "unreachable" ? obs?.code : undefined
    const sleptByPlugin = record.slept && (!before || Date.parse(record.slept.at) >= Date.parse(before.at))
    const event: Omit<WorkEvent, "seq"> = {
      at: now().toISOString(),
      workId: record.workId,
      from: before?.phase ?? null,
      to: phase,
      ...(phase === "idle" ? { outcome: outcome ?? null } : {}),
      ...(done ? { done: true as const } : {}),
      ...(code ? { code } : {}),
      ...(phase === "asleep" ? { asleepBy: sleptByPlugin ? record.slept!.by : "idle-or-cli" } : {}),
      ...(obs?.needsInput && (phase === "busy" || phase === "idle") ? { needsInput: obs.needsInput } : {}),
      ...(obs?.reading && (phase === "busy" || phase === "idle") ? { reading: { residentGiB: obs.reading.residentGiB, load1: obs.reading.load1 } } : {}),
    }
    const line = await core.ledger.appendEvent(event, op)
    dispatched.add(line.seq)
    logged.set(record.workId, { phase: line.to, at: line.at, seenAt: Date.now() })
    // A first sight of a work the log never named is a fact to record, not news for its coordinator.
    dispatch(line, line.from !== null)
    // The record keeps the report, so a restart, a sleep and a harvest keep it; the tick then nudges the source changed.
    if (done) await recordDone(record, done, op)
  }

  /** Keeps a done report the sweep saw in the record; a later prompt wins over it. Never throws. */
  async function recordDone(record: WorkRecord, done: DoneReport, op: OpContext): Promise<void> {
    if (record.done?.at === done.at) return
    try {
      await core.ledger.update(
        [record.workId],
        async (current) => {
          const now = current.get(record.workId)
          const submitted = now?.lastSubmit ? Date.parse(now.lastSubmit.at) : Number.NaN
          if (now?.state !== "open" || now.done?.at === done.at || (!Number.isNaN(submitted) && submitted > Date.parse(done.at))) return { write: [], value: undefined }
          return { write: [{ ...now, done }], value: undefined }
        },
        op,
      )
    } catch (error) {
      if (!abort.signal.aborted) core.report("watch", `The done report for ${record.workId} was not recorded: ${reasonOf(error)}.`)
    }
  }

  async function sweep(open: readonly WorkRecord[], op: OpContext): Promise<number> {
    const started = Date.now()
    let listing: Listing
    try {
      listing = await core.boxd.list({ maxAgeMs: TIMEOUTS.readListingMaxAgeMs }, op)
      sweepFailures = 0
      problem = undefined
    } catch (error) {
      if (abort.signal.aborted) return 0
      sweepFailures += 1
      problem = `The watcher's machine listing failed ${sweepFailures} ${sweepFailures === 1 ? "time" : "times"} in a row: ${reasonOf(error)}.`
      if (sweepFailures >= STOP_AFTER_FAILURES) {
        problem = `The watcher stopped after ${sweepFailures} failed sweeps in a row: ${reasonOf(error)}. boxd_status starts it again.`
        stopped = true
      }
      return 0
    }
    let appended = 0
    listingAt = new Date(listing.takenAt).toISOString()
    const at = now().getTime()
    const reads = open.filter((record) => wantsRead(record, listing, observed.get(record.workId), at, WATCH_READ_REUSE_MS))
    /** Works this sweep's guest read answered: their phase is news newer than any listing. */
    const readNow = new Set<string>()
    await Promise.all(
      reads.map(async (record) => {
        const previous = observed.get(record.workId)
        try {
          observed.set(record.workId, observe(await readGuest(core, record, listing, {}, op), previous, now(), STATUS_TEXT_LIMIT))
          readNow.add(record.workId)
        } catch (error) {
          // A read the read rule refused learned nothing: the work keeps what was known, and the listing decides below.
          if (abort.signal.aborted || notRead(error)) return
          observed.set(record.workId, observeFailure(error, previous, phaseOf(record, listing, previous), now()))
        }
      }),
    )
    for (const record of open) {
      if (abort.signal.aborted) return appended
      const previous = observed.get(record.workId)
      let phase = phaseOf(record, listing, previous)
      let absent = 0
      if (phase === "gone" && record.region !== null) {
        // The same shared listing seen twice is one listing, not two.
        const counted = absentListing.get(record.workId) === listing.takenAt
        absentListing.set(record.workId, listing.takenAt)
        absent = (previous?.absent ?? 0) + (counted ? 0 : 1)
        // One listing without the machine is not enough: it takes two in a row. Until then the work keeps what was known.
        if (absent < 2) {
          observed.set(record.workId, { ...(previous ?? base(undefined, recordPhase(record), now())), absent })
          continue
        }
      }
      if (absent === 0) absentListing.delete(record.workId)
      if (!previous || previous.phase !== phase || previous.absent !== absent) observed.set(record.workId, { ...base(previous, phase, now()), absent })
      const last = logged.get(record.workId)
      if (last?.phase === phase) continue
      // A listing taken before the log's newest word on this work (a sleep a change tool just recorded) never
      // contradicts it; the next sweep's listing decides.
      if (last && last.seenAt > listing.takenAt && !readNow.has(record.workId)) continue
      try {
        await append(record, phase, observed.get(record.workId), op)
        appended += 1
      } catch (error) {
        if (abort.signal.aborted) return appended
        core.report("watch", `The watcher could not record a phase change: ${reasonOf(error)}.`)
      }
    }
    await checkTargets(open)
    lastSweepMs = Date.now() - started
    return appended
  }

  /** The ground truth for orphans (§C.3): each notice target, read locally with no CLI call. */
  async function checkTargets(open: readonly WorkRecord[]): Promise<void> {
    const targets = new Set(open.map((record) => record.session?.notify).filter((target): target is string => typeof target === "string"))
    for (const target of targets) {
      // Only the host's own "not found", an archive or a new parent orphans the works; any other error says nothing.
      const check = await checkTarget(core.sessions, target)
      if (check.state === "gone") await orphan(target, check.cause)
    }
  }

  /** A work subscribed to a live coordinator again (a model-path call) is no longer an orphan. */
  function clearOrphans(): void {
    for (const [workId, flag] of orphans) {
      const record = records.get(workId)
      if (!record || record.state !== "open" || (record.session?.notify && record.session.notify !== flag.session)) orphans.delete(workId)
    }
  }

  /** Tells the works source's subscribers, once per tick, that it appended or tailed an event. Never throws. */
  async function notifyChanged(events: number): Promise<void> {
    if (events === 0 || disposed) return
    try {
      await options.changed?.()
    } catch (error) {
      core.report("watch", `The changed nudge for the works source failed: ${reasonOf(error)}.`)
    }
  }

  async function tick(): Promise<void> {
    if (disposed) return
    if (current) return current
    let events = 0
    const run = (async () => {
      const op = context()
      try {
        const list = await core.ledger.list({}, op)
        for (const id of [...records.keys()]) if (!list.some((record) => record.workId === id)) records.delete(id)
        for (const record of list) records.set(record.workId, record)
        clearOrphans()
        events += await sync(op)
        const open = list.filter((record) => record.state === "open")
        if (!(auto && stopped) && wantsSweep(open)) {
          notices.hold()
          try {
            events += await sweep(open, op)
          } finally {
            notices.release()
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) core.report("watch", `The watcher's tick failed: ${reasonOf(error)}.`)
      } finally {
        await notifyChanged(events)
      }
    })()
    current = run
    try {
      await run
    } finally {
      current = undefined
    }
  }

  function schedule(delay: number): void {
    if (disposed || timer || stopped) return
    timer = setTimeout(() => {
      timer = undefined
      void tick().finally(() => schedule(Math.max(interval, 2 * lastSweepMs)))
    }, delay)
    timer.unref?.()
  }

  const handle: WatchHandle = {
    observed: (workId) => observed.get(workId),
    remember(workId, value) {
      observed.set(workId, value)
    },
    async cursor(op) {
      await sync(op)
      return cursor
    },
    kick() {
      if (disposed || !auto) return
      if (stopped) {
        stopped = false
        sweepFailures = 0
      }
      schedule(0)
    },
    health: () => ({ notices: notices.dropped(), ...(problem ? { watcher: problem } : {}) }),
    orphaned: (workId) => orphans.get(workId),
  }

  const watch: FleetWatch = {
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    snapshot(): FleetSnapshot {
      const works: WorkSnapshot[] = []
      for (const record of records.values()) {
        if (record.state !== "open") continue
        const obs = observed.get(record.workId)
        const phase = phaseNow(record)
        works.push({
          workId: record.workId,
          region: record.region,
          machineId: record.machineId,
          size: record.size,
          phase,
          outcome: outcomeOf(record, obs),
          saved: core.ledger.saved(record),
          ...(obs?.needsInput ? { needsInput: obs.needsInput } : {}),
          ...(obs?.reading ? { reading: obs.reading } : {}),
          ...((phase === "idle" || phase === "ready") && obs?.since ? { idleSince: obs.since } : {}),
          ...(record.touchedAt ? { touchedAt: record.touchedAt } : {}),
          ...(record.session?.notify ? { notify: record.session.notify } : {}),
          ...(orphans.has(record.workId) ? { orphaned: orphans.get(record.workId)! } : {}),
        })
      }
      return { asOf: listingAt ?? new Date(0).toISOString(), works }
    },
    sessionGone(sessionID, why) {
      void orphan(sessionID, why).catch(() => undefined)
    },
  }
  handles.set(watch, handle)

  if (auto) {
    // The first tick waits a moment, so the plugin's start is not held up by the ledger read.
    schedule(1_000)
  }

  return {
    watch,
    handle,
    tick,
    flushNotices: () => notices.flushDue(),
    dispose: async () => {
      disposed = true
      abort.abort()
      if (timer) clearTimeout(timer)
      timer = undefined
      await current?.catch(() => undefined)
      await notices.stop()
      listeners.clear()
    },
  }
}
