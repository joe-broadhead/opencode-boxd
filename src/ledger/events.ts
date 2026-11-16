/**
 * `events.jsonl` (design §2.2, §3.1, §3.13): phase changes, one JSON line each, with a sequence number that is
 * `boxd_status`'s cursor. Append-only: a line is appended and never rewritten, so this file is the one exception to the
 * copy-on-write rule. At `EVENTS_ROTATE_BYTES` the file is renamed to `events.1.jsonl`, so the log keeps at least the
 * last 5 MiB; a cursor older than the oldest kept event answers `cursorExpired: true`, and the caller gives the full view.
 *
 * Sequence numbers come from the log itself under a short cross-process lock, so two OpenCode processes on one laptop
 * never hand out the same one. A line cut off by a crash is skipped by readers and fenced off by the next writer.
 */
import { createReadStream } from "node:fs"
import { open, rename, stat } from "node:fs/promises"
import { join } from "node:path"
import { boxdError, isCode } from "../errors.js"
import { EVENTS_ROTATE_BYTES, type EventLine } from "./types.js"
import { errnoOf, FILE_MODE } from "./fsx.js"
import { acquireLock, type LockSet } from "./lock.js"

/** The rotated file beside `events.jsonl`. */
export const ROTATED_EVENTS = "events.1.jsonl"
const EVENTS_LOCK = "events.lock"

export type NewEvent = Omit<EventLine, "seq" | "at"> & { readonly at?: string }

export interface EventsSince {
  /** The newest sequence number: pass it as `since` next time. */
  readonly cursor: number
  /** Events after `since`, oldest first; empty when the cursor expired. */
  readonly events: readonly EventLine[]
  /** True when `since` is older than the oldest kept event, or newer than the log: answer with the full view. */
  readonly cursorExpired: boolean
}

export class EventLog {
  readonly file: string
  readonly rotated: string
  private readonly lockPath: string
  private readonly rotateBytes: number
  private readonly now: () => Date
  private readonly locks: LockSet | undefined

  constructor(ledgerDir: string, options: { rotateBytes?: number; now?: () => Date; locks?: LockSet } = {}) {
    this.file = join(ledgerDir, "events.jsonl")
    this.rotated = join(ledgerDir, ROTATED_EVENTS)
    this.lockPath = join(ledgerDir, EVENTS_LOCK)
    this.rotateBytes = options.rotateBytes ?? EVENTS_ROTATE_BYTES
    this.now = options.now ?? (() => new Date())
    this.locks = options.locks
  }

  /**
   * Appends one event with the next sequence number. A code that is not in the §5 table is written as `RUN_FAILED`
   * (L-f), so no guest string can reach a notice through the log.
   */
  async append(event: NewEvent, signal?: AbortSignal): Promise<EventLine> {
    const options = { purpose: "events", waitMs: 10_000, pollMs: 10, ...(signal ? { signal } : {}) }
    const lock = this.locks ? await this.locks.acquire(this.lockPath, options) : await acquireLock(this.lockPath, options)
    if (!lock) throw boxdError("LEDGER_LOCKED", "Another OpenCode process held the event log's lock for 10 seconds.")
    try {
      const tail = await lastLine(this.file)
      const previous = tail.seq ?? (await lastLine(this.rotated)).seq ?? 0
      const line: EventLine = {
        seq: previous + 1,
        at: event.at ?? this.now().toISOString(),
        workId: event.workId,
        phase: event.phase,
        ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
        ...(event.code !== undefined ? { code: isCode(event.code) ? event.code : "RUN_FAILED" } : {}),
        ...(event.asleepBy !== undefined ? { asleepBy: event.asleepBy } : {}),
      }
      const text = `${tail.cut ? "\n" : ""}${JSON.stringify(line)}\n`
      if (tail.size > 0 && tail.size + Buffer.byteLength(text) > this.rotateBytes) {
        await rename(this.file, this.rotated)
        await appendText(this.file, `${JSON.stringify(line)}\n`)
      } else {
        await appendText(this.file, text)
      }
      return line
    } finally {
      await lock.release()
    }
  }

  /** The newest sequence number, 0 for an empty log. */
  async cursor(): Promise<number> {
    return (await lastLine(this.file)).seq ?? (await lastLine(this.rotated)).seq ?? 0
  }

  /** Every kept event after `since`, oldest first; `cursorExpired` when the log no longer reaches back that far. */
  async since(since: number): Promise<EventsSince> {
    const kept = [...(await readLines(this.rotated)), ...(await readLines(this.file))]
    const cursor = kept.length ? kept[kept.length - 1]!.seq : 0
    const oldest = kept.length ? kept[0]!.seq : cursor + 1
    if (since > cursor || since < oldest - 1) return { cursor, events: [], cursorExpired: since !== cursor }
    return { cursor, events: kept.filter((line) => line.seq > since), cursorExpired: false }
  }
}

async function appendText(path: string, text: string): Promise<void> {
  const handle = await open(path, "a", FILE_MODE)
  try {
    await handle.appendFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** The last complete line's sequence number, the file's size, and whether it ends in a line cut off by a crash. */
async function lastLine(path: string): Promise<{ seq: number | undefined; size: number; cut: boolean }> {
  let handle
  try {
    handle = await open(path, "r")
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return { seq: undefined, size: 0, cut: false }
    throw error
  }
  try {
    const size = (await handle.stat()).size
    if (size === 0) return { seq: undefined, size, cut: false }
    const length = Math.min(size, 64 * 1024)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const text = buffer.toString("utf8")
    const cut = !text.endsWith("\n")
    const lines = text.split("\n").filter(Boolean)
    for (let index = lines.length - 1; index >= 0; index--) {
      const seq = parseSeq(lines[index]!)
      if (seq !== undefined) return { seq, size, cut }
    }
    return { seq: undefined, size, cut }
  } finally {
    await handle.close()
  }
}

const parseSeq = (text: string): number | undefined => {
  try {
    const parsed = JSON.parse(text) as { seq?: unknown }
    return typeof parsed.seq === "number" && Number.isSafeInteger(parsed.seq) ? parsed.seq : undefined
  } catch {
    return undefined
  }
}

/** Every complete, parseable line of one file; a line cut off by a crash is skipped. Streamed, never read whole. */
async function readLines(path: string): Promise<EventLine[]> {
  try {
    await stat(path)
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return []
    throw error
  }
  const lines: EventLine[] = []
  let rest = ""
  for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 256 * 1024 })) {
    const parts = (rest + (chunk as string)).split("\n")
    rest = parts.pop() ?? ""
    for (const part of parts) {
      if (!part) continue
      try {
        const parsed = JSON.parse(part) as EventLine
        if (typeof parsed.seq === "number" && typeof parsed.workId === "string") lines.push(parsed)
      } catch {
        // a line cut off by a crash, fenced by the next writer's newline
      }
    }
  }
  return lines
}
