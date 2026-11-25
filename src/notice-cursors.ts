/**
 * Package D's durable notice cursors (design §3.13, issue #46): one high-water mark per subscriber session, the highest
 * event sequence a delivered notice covered. The watcher's queue skips events at or below it, so a restart, a replay or
 * a re-sweep cannot deliver the same change twice.
 *
 * - **At or below never again:** sequence numbers are the event log's global cursor, so an entry of `n` means every
 *   event up to `n` is settled for that subscriber.
 * - **Only a delivered notice moves it:** the queue writes the entry after the host accepted the synthetic post. A post
 *   the host refused, and a target the host could not answer for, leave it where it was, so the notice is retried.
 * - **Never backwards:** an advance takes a short cross-process lock, reads the file and writes the larger value, so two
 *   OpenCode processes on one laptop cannot lower each other's cursor.
 * - **Plugin words only:** the file holds session ids and sequence numbers, never guest text. It is written
 *   copy-on-write through the ledger's file primitives, under the ledger's `v1/` folder, and is 0600 like every other
 *   ledger file.
 */
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { boxdError } from "./errors.js"
import { ensureDir, writeJsonAtomic } from "./ledger/fsx.js"
import { acquireLock } from "./ledger/lock.js"
import { LEDGER_PATHS } from "./ledger/types.js"

/** The state file's format, so a later shape can be told apart. */
export const NOTICE_CURSORS_FORMAT = 1
/** The file under the ledger's `v1/` folder. */
export const NOTICE_CURSORS_FILE = "notice-cursors.json"
const LOCK_FILE = "notice-cursors.lock"
/** How long an advance waits for another process's cursor write before giving up. */
const LOCK_WAIT_MS = 5_000
/** The only keys stored: an OpenCode session id. Anything else is ignored, so no record text reaches the file. */
const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,80}$/

/** The highest sequence a delivered notice covered for a subscriber, and the way to record a new one. */
export interface NoticeCursors {
  /** The covered high-water mark: 0 when this subscriber has no saved cursor. */
  covered(target: string): Promise<number>
  /** Records that a notice covering `seq` was accepted for `target`; never lowers the saved mark. */
  advance(target: string, seq: number): Promise<void>
}

interface CursorState {
  readonly format: typeof NOTICE_CURSORS_FORMAT
  readonly cursors: Readonly<Record<string, number>>
}

/**
 * The ledger's `v1/notice-cursors.json`. A missing, unreadable or stale-shaped file reads as no cursor (0): a notice may
 * then repeat once rather than be lost, and the next successful advance rewrites the file in this shape.
 */
export class FileNoticeCursors implements NoticeCursors {
  readonly file: string
  readonly lock: string
  private readonly waitMs: number

  constructor(root: string, options: { readonly waitMs?: number } = {}) {
    const dir = join(root, LEDGER_PATHS.v1)
    this.file = join(dir, NOTICE_CURSORS_FILE)
    this.lock = join(dir, LOCK_FILE)
    this.waitMs = options.waitMs ?? LOCK_WAIT_MS
  }

  async covered(target: string): Promise<number> {
    if (!SESSION_ID.test(target)) return 0
    return (await this.read()).cursors[target] ?? 0
  }

  async advance(target: string, seq: number): Promise<void> {
    if (!SESSION_ID.test(target) || !Number.isSafeInteger(seq) || seq < 1) return
    await ensureDir(dirname(this.file))
    const lock = await acquireLock(this.lock, { purpose: "notice cursors", waitMs: this.waitMs })
    if (!lock) throw boxdError("LEDGER_LOCKED", "Another OpenCode process held the notice cursor lock; this notice's cursor was not saved.")
    try {
      const current = await this.read()
      if ((current.cursors[target] ?? 0) >= seq) return
      await writeJsonAtomic(this.file, { format: NOTICE_CURSORS_FORMAT, cursors: { ...current.cursors, [target]: seq } } satisfies CursorState)
    } finally {
      await lock.release()
    }
  }

  private async read(): Promise<{ readonly cursors: Readonly<Record<string, number>> }> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.file, "utf8"))
    } catch {
      return { cursors: {} }
    }
    const state = parsed as Partial<CursorState> | null
    if (!state || state.format !== NOTICE_CURSORS_FORMAT || !state.cursors || typeof state.cursors !== "object") return { cursors: {} }
    const cursors: Record<string, number> = {}
    for (const [target, value] of Object.entries(state.cursors)) {
      if (SESSION_ID.test(target) && typeof value === "number" && Number.isSafeInteger(value) && value > 0) cursors[target] = value
    }
    return { cursors }
  }
}
