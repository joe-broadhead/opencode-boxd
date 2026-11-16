/**
 * Package D's notices (design §3.13): one short line posted into a work's root coordinator session when works change
 * phase. Package D owns this file; the watcher (`src/watch.ts`) feeds it every event it sees.
 *
 * - **Who gets them:** only the session recorded as the work's `session.notify`, the root coordinator that started or
 *   last drove it. It is checked again just before posting: a session that is gone, archived, or now has a parent gets
 *   no notice; its works' subscriptions are cleared, and status's health records it. A wake the host refuses is posted
 *   once more as queue only, and then dropped the same way.
 * - **How often:** changes are coalesced per target, a target gets at most one notice per 60 s, and one notice names at
 *   most 20 works, then "and N more", and points at `boxd_status({ since })`.
 * - **What they say:** only the plugin's own words. Work ids (checked against the work-id pattern), phases and
 *   outcomes from their fixed sets, codes from the §5 table (anything else is `RUN_FAILED`), and a cursor. Never
 *   `lastText` or any other guest text, because a notice lands in the coordinator's context.
 */
import { isCode } from "./errors.js"
import type { Notices as NoticeMode } from "./options.js"
import { PHASES, type SavedState } from "./ledger/types.js"
import type { WorkEvent } from "./ports.js"
import type { SessionAccess } from "./services.js"

/** A target gets at most one notice per this long. */
export const NOTICE_INTERVAL_MS = 60_000
/** One notice names at most this many works. */
export const NOTICE_MAX_WORKS = 20
/** Status's health keeps this many dropped notices. */
const DROPPED_KEPT = 20

const WORK_ID = /^[a-z][a-z0-9-]{0,24}$/
const OUTCOMES = new Set(["completed", "failed", "aborted"])
const ASLEEP_BY: Readonly<Record<string, string>> = { boxd_sleep: "boxd_sleep", automation: "automation", "idle-or-cli": "idle" }

/** A dropped notice, for status's `health.notices`: the session, why, and when. Plugin words only. */
export interface DroppedNotice {
  readonly session: string
  readonly dropped: string
  readonly at: string
}

interface Pending {
  readonly event: WorkEvent
  readonly saved: SavedState
}

export interface NoticeDeps {
  readonly mode: () => NoticeMode
  readonly sessions: Pick<SessionAccess, "get" | "synthetic">
  readonly now: () => Date
  /** Clears `session.notify` on every open work that names this session, after a drop. Never throws. */
  readonly unsubscribe: (session: string) => Promise<void>
}

/** One work's change in a notice: `review-api idle (completed, not saved)`. Plugin words only. */
export function noticeItem(event: WorkEvent, saved: SavedState): string | undefined {
  if (!WORK_ID.test(event.workId) || !PHASES.includes(event.to)) return undefined
  const code = event.code === undefined ? undefined : isCode(event.code) ? event.code : "RUN_FAILED"
  if (event.to === "idle") {
    const outcome = event.outcome && OUTCOMES.has(event.outcome) ? event.outcome : null
    if (outcome === "failed") return `${event.workId} failed (${code ?? "RUN_FAILED"})`
    const facts = [...(outcome ? [outcome] : []), saved === "fresh" ? "saved" : "not saved"]
    return `${event.workId} idle (${facts.join(", ")})`
  }
  if (event.to === "asleep") {
    const by = event.asleepBy ? ASLEEP_BY[event.asleepBy] : undefined
    return `${event.workId} asleep${by ? ` (${by})` : ""}`
  }
  if (event.needsInput === "form" || event.needsInput === "permission") return `${event.workId} ${event.to} (waits on a ${event.needsInput})`
  return `${event.workId} ${event.to}${code ? ` (${code})` : ""}`
}

/** The notice for one target: at most 20 works, then "and N more", and the cursor to read the rest with. */
export function noticeText(items: readonly Pending[]): string | undefined {
  const lines = items.map((item) => noticeItem(item.event, item.saved)).filter((line): line is string => line !== undefined)
  if (!lines.length) return undefined
  const since = Math.max(0, Math.min(...items.map((item) => item.event.seq)) - 1)
  const shown = lines.slice(0, NOTICE_MAX_WORKS)
  const more = lines.length - shown.length
  const works = `${lines.length} ${lines.length === 1 ? "work" : "works"} changed`
  return `boxd: ${works} — ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}. boxd_status({ since: ${since} }) has the details.`
}

/** Why a target may not get a notice now, or undefined when it may: gone, archived, or no longer a root session. */
async function refusal(sessions: Pick<SessionAccess, "get">, target: string): Promise<string | undefined> {
  let info: { readonly parentID?: unknown; readonly time?: { readonly archived?: unknown } } | undefined
  try {
    info = (await sessions.get({ sessionID: target } as never)) as typeof info
  } catch {
    return "the session is gone"
  }
  if (!info) return "the session is gone"
  if (info.time?.archived !== undefined && info.time.archived !== null) return "the session is archived"
  if (typeof info.parentID === "string" && info.parentID !== "") return "the session now has a parent"
  return undefined
}

export class NoticeQueue {
  private readonly pending = new Map<string, Map<string, Pending>>()
  private readonly lastSent = new Map<string, number>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly flushing = new Set<Promise<void>>()
  private readonly droppedList: DroppedNotice[] = []
  private stopped = false
  /** While a sweep runs, nothing is posted: its changes go out together when it ends. */
  private held = 0
  private readonly deps: NoticeDeps

  constructor(deps: NoticeDeps) {
    this.deps = deps
  }

  /** Queues one event for its work's coordinator; the newest change per work wins. */
  enqueue(event: WorkEvent, target: string | undefined, saved: SavedState): void {
    if (this.stopped || !target || this.deps.mode() === "off") return
    const works = this.pending.get(target) ?? new Map<string, Pending>()
    const earlier = works.get(event.workId)
    // The newest change per work, with the cursor of the first change still unseen.
    works.set(event.workId, { event: earlier ? { ...event, seq: Math.min(earlier.event.seq, event.seq) } : event, saved })
    this.pending.set(target, works)
    this.schedule(target)
  }

  /** Holds every post until `release`, so one sweep's changes coalesce into one notice per target. */
  hold(): void {
    this.held += 1
  }

  release(): void {
    this.held = Math.max(0, this.held - 1)
    if (this.held === 0) for (const target of this.pending.keys()) this.schedule(target)
  }

  dropped(): readonly DroppedNotice[] {
    return [...this.droppedList]
  }

  /** Posts every target that is due now, without waiting for its timer: for tests and for disposal. */
  async flushDue(): Promise<void> {
    await Promise.all([...this.pending.keys()].filter((target) => this.due(target) <= 0).map((target) => this.flush(target)))
    await Promise.all([...this.flushing])
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    await Promise.all([...this.flushing])
  }

  private due(target: string): number {
    const last = this.lastSent.get(target)
    return last === undefined ? 0 : last + NOTICE_INTERVAL_MS - this.deps.now().getTime()
  }

  private schedule(target: string): void {
    if (this.timers.has(target)) return
    const timer = setTimeout(() => {
      this.timers.delete(target)
      void this.flush(target)
    }, Math.max(0, this.due(target)))
    timer.unref?.()
    this.timers.set(target, timer)
  }

  private flush(target: string): Promise<void> {
    const run = this.post(target).finally(() => this.flushing.delete(run))
    this.flushing.add(run)
    return run
  }

  private async post(target: string): Promise<void> {
    if (this.stopped || this.held > 0) return
    const works = this.pending.get(target)
    if (!works?.size) return
    if (this.due(target) > 0) return this.schedule(target)
    this.pending.delete(target)
    const items = [...works.values()].sort((a, b) => a.event.seq - b.event.seq)
    const text = noticeText(items)
    const mode = this.deps.mode()
    if (!text || mode === "off") return
    const why = await refusal(this.deps.sessions, target)
    if (why) return this.drop(target, why)
    this.lastSent.set(target, this.deps.now().getTime())
    const post = (resume: boolean) => this.deps.sessions.synthetic({ sessionID: target, text, description: "boxd notice", delivery: "queue", resume } as never)
    try {
      await post(mode === "wake")
    } catch {
      if (mode !== "wake") return this.drop(target, "the host refused the notice")
      try {
        // A wake the host refused (a conflict, the session ended or locked): once more, queue only.
        await post(false)
      } catch {
        return this.drop(target, "the host refused the notice twice")
      }
    }
  }

  private async drop(target: string, why: string): Promise<void> {
    this.droppedList.push({ session: target, dropped: why, at: this.deps.now().toISOString() })
    if (this.droppedList.length > DROPPED_KEPT) this.droppedList.splice(0, this.droppedList.length - DROPPED_KEPT)
    await this.deps.unsubscribe(target)
  }
}
