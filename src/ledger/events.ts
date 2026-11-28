/**
 * `events.jsonl` (design §2.2, §3.1, §3.13): changes, one JSON line each, with a sequence number that is
 * `boxd_status`'s cursor. Append-only: a line is appended and never rewritten, so this file is the one exception to the
 * copy-on-write rule. At `EVENTS_ROTATE_BYTES` the file is renamed to `events.1.jsonl`, so the log keeps at least the
 * last 5 MiB; a cursor older than the oldest kept event answers `cursorExpired: true`, and the caller gives the full view.
 *
 * Sequence numbers come from the log itself under a short cross-process lock, so two OpenCode processes on one laptop
 * never hand out the same one. A line cut off by a crash is skipped by readers and fenced off by the next writer.
 */
import { createReadStream, mkdirSync } from "node:fs"
import { open, rename, stat } from "node:fs/promises"
import { join } from "node:path"
import { boxdError, isCode } from "../errors.js"
import type { EventPage } from "../ports.js"
import { EVENTS_ROTATE_BYTES, type EventLine } from "./types.js"
import { errnoOf, FILE_MODE } from "./fsx.js"
import { acquireLock, type LockSet } from "./lock.js"

/** The rotated file beside `events.jsonl`. */
export const ROTATED_EVENTS = "events.1.jsonl"
const EVENTS_LOCK = "events.lock"

export type NewEvent = Omit<EventLine, "seq" | "at"> & { readonly at?: string }

/** The port's `EventPage`. */
export type EventsSince = EventPage

export class EventLog {
  readonly file: string
  readonly rotated: string
  private readonly lockPath: string
  private readonly rotateBytes: number
  private readonly now: () => Date
  private readonly locks: LockSet | undefined

  constructor(ledgerDir: string, options: { rotateBytes?: number; now?: () => Date; locks?: LockSet } = {}) {
    mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
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
      // The one event shape, field by field: nothing the caller adds beyond it reaches the log.
      const line: EventLine = {
        seq: previous + 1,
        at: event.at ?? this.now().toISOString(),
        workId: event.workId,
        from: event.from,
        to: event.to,
        ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
        ...(event.done !== undefined ? { done: true as const } : {}),
        ...(event.code !== undefined ? { code: isCode(event.code) ? event.code : "RUN_FAILED" } : {}),
        ...(event.asleepBy !== undefined ? { asleepBy: event.asleepBy } : {}),
        ...(event.needsInput !== undefined ? { needsInput: event.needsInput } : {}),
        ...(event.warm !== undefined ? { warm: event.warm } : {}),
        ...(event.readySeconds !== undefined && Number.isSafeInteger(event.readySeconds) && event.readySeconds >= 0 ? { readySeconds: event.readySeconds } : {}),
        ...(event.reading !== undefined ? { reading: { residentGiB: event.reading.residentGiB, load1: event.reading.load1 } } : {}),
      }
      // The fence: a sequence number is handed out only while this process still holds the log's lock.
      if (!(await lock.holds())) throw boxdError(this.locks?.disposed ? "CANCELLED" : "LEDGER_LOCKED", "The event log's lock was lost before the append, so nothing was written.")
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

  /**
   * The kept events after `since`, oldest first, and `cursor`: the newest `seq` returned, or `since` when nothing is
   * newer. When `since` is older than the oldest kept event, `cursorExpired` is true and the events start at the oldest
   * kept one. A cursor newer than the log (another ledger's) is expired too: sequence numbers are never reused, so it can
   * only come from somewhere else.
   *
   * The two files are read as one consistent pair, with no lock: a rotation that lands between the two reads (a rename,
   * then a fresh `events.jsonl`) would otherwise leave the moved events in neither, and a cursor inside them would jump
   * past them unseen. Sequence numbers are contiguous across the two files (a line cut off by a crash gives its number
   * to the next writer), so the pair is read again when the rotated file's last number is not one before the current
   * file's first, when the rotated file changed while either file was read, or when `events.jsonl` is missing beside a
   * rotated file (the moment between the rename and the next append). After `SINCE_TRIES` reads that are not a consistent pair it
   * throws `LEDGER_LOCKED`: the caller tries again, and its cursor has not moved.
   */
  async since(since: number): Promise<EventsSince> {
    for (let attempt = 0; attempt < SINCE_TRIES; attempt++) {
      if (attempt > 0) await sleep(SINCE_PAUSE_MS * attempt)
      const kept = await this.consistentPair()
      if (kept === undefined) continue
      const newest = kept.length ? kept[kept.length - 1]!.seq : 0
      const oldest = kept.length ? kept[0]!.seq : newest + 1
      const expired = since > newest || since < oldest - 1
      const events = expired ? kept : kept.filter((line) => line.seq > since)
      return { cursor: events.length ? events[events.length - 1]!.seq : expired ? newest : since, events, cursorExpired: expired }
    }
    throw boxdError("LEDGER_LOCKED", "The event log was rotating each time it was read, so no consistent page could be read; nothing was skipped.")
  }

  /** Both files' lines as one consistent run of sequence numbers, or undefined when a rotation raced the read. */
  private async consistentPair(): Promise<EventLine[] | undefined> {
    const before = await identity(this.rotated)
    const rotated = (await readLines(this.rotated)) ?? []
    const after = await identity(this.rotated)
    if (before?.ino !== after?.ino || before?.size !== after?.size) return undefined
    const current = await readLines(this.file)
    // A rename after the rotated file was read (the first rotation, when there was none) leaves `events.jsonl` missing
    // or new: the rotated file is checked once more.
    const final = await identity(this.rotated)
    if (after?.ino !== final?.ino || after?.size !== final?.size) return undefined
    if (current === undefined) return after === undefined ? rotated : undefined
    const last = rotated[rotated.length - 1]
    const first = current[0]
    if (last !== undefined && first !== undefined && last.seq + 1 !== first.seq) return undefined
    return [...rotated, ...current]
  }
}

/** How often `since` reads the two files before it gives up on a consistent pair, and the pause that grows between. */
const SINCE_TRIES = 5
const SINCE_PAUSE_MS = 20

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A file's inode and size, or undefined when it does not exist. */
async function identity(path: string): Promise<{ ino: number; size: number } | undefined> {
  try {
    const { ino, size } = await stat(path)
    return { ino, size }
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return undefined
    throw error
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
  let handle: Awaited<ReturnType<typeof open>>
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

/**
 * Every complete, parseable line of one file, or undefined when it does not exist (also when it is renamed away before
 * the read opens it); a line cut off by a crash is skipped. Streamed, never read whole.
 */
async function readLines(path: string): Promise<EventLine[] | undefined> {
  const lines: EventLine[] = []
  let rest = ""
  try {
    for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 256 * 1024 })) {
      const parts = (rest + (chunk as string)).split("\n")
      rest = parts.pop() ?? ""
      for (const part of parts) {
        if (!part) continue
        try {
          const parsed = JSON.parse(part) as EventLine
          if (typeof parsed.seq === "number" && typeof parsed.workId === "string" && typeof parsed.to === "string") lines.push(parsed)
        } catch {
          // a line cut off by a crash, fenced by the next writer's newline
        }
      }
    }
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return undefined
    throw error
  }
  return lines
}
