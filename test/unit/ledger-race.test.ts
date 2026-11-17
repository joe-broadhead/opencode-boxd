// A read of the event log racing a rotation (`EventLog.since`): the reads of `events.1.jsonl` and `events.jsonl` must be
// one consistent pair, or a cursor inside the moved events jumps past them unseen. First the interleaving a review found,
// forced: the rotation lands right after the rotated file is read. Then the same race unforced: a writer rotating a small
// log while a reader pages behind it, checked for holes, repeats, spurious gaps and uncoded errors.
import { expect, mock, test } from "bun:test"
import * as realFs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EventsListResult } from "@we-the-rebel-alliance/source-contract/events"
import type { ImportState } from "../../src/ports.js"

let armed: undefined | (() => void)
const realCreate = realFs.createReadStream
mock.module("node:fs", () => ({
  ...realFs,
  createReadStream: (path: string, options: unknown) => {
    const stream = realCreate(path, options as never)
    if (!String(path).endsWith("events.1.jsonl") || !armed) return stream
    const after = armed
    armed = undefined
    const iterate = stream[Symbol.asyncIterator].bind(stream)
    ;(stream as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = async function* () {
      for await (const chunk of { [Symbol.asyncIterator]: iterate }) yield chunk
      after() // the writer's rotation lands right after the reader finished the rotated file
    }
    return stream
  },
}))

const { EventLog } = await import("../../src/ledger/events.js")
const { encodeWorksCursor, identityOf, listWorks } = await import("../../src/sources.js")
const COMPLETE: ImportState = { state: "complete", works: 0, blocked: [] }
const identity = identityOf("sam", "studio-mac")
const temp = (prefix: string) => realFs.mkdtempSync(join(realFs.realpathSync(tmpdir()), prefix))
const depsOf = (log: InstanceType<typeof EventLog>, now = () => new Date("2026-11-17T12:00:00.000Z")) => ({
  ledger: { eventsSince: (q: number) => log.since(q) },
  importV0: { state: () => COMPLETE },
  identity: () => identity,
  now,
})

test("a read that a rotation lands in lists the moved events: no hole, no gap", async () => {
  const dir = temp("boxd-race-")
  try {
    const line = (seq: number) => `${JSON.stringify({ seq, at: "2026-11-17T10:00:00.000Z", workId: "w", from: "idle", to: "busy" })}\n`
    // As a log looks after one rotation: the rotated file holds 1..10, events.jsonl 11..20.
    realFs.writeFileSync(join(dir, "events.1.jsonl"), Array.from({ length: 10 }, (_, i) => line(i + 1)).join(""))
    realFs.writeFileSync(join(dir, "events.jsonl"), Array.from({ length: 10 }, (_, i) => line(i + 11)).join(""))
    const deps = depsOf(new EventLog(dir))
    // A reader that has listed up to seq 12, behind the head, as a periodic collector is.
    const cursor = encodeWorksCursor(identity.account, { q: 12, t: "2026-11-17T10:00:00.000Z" })
    armed = () => {
      // What EventLog.append does at the rotation size: rename, then append seq 21 to a fresh events.jsonl.
      realFs.renameSync(join(dir, "events.jsonl"), join(dir, "events.1.jsonl"))
      realFs.appendFileSync(join(dir, "events.jsonl"), line(21))
    }
    const page = (await listWorks(deps, { cursor })) as EventsListResult
    expect(armed).toBeUndefined()
    expect(page.gap).toBeUndefined()
    expect(page.events.map((event) => event.external_id)).toEqual(Array.from({ length: 9 }, (_, i) => `w:${i + 13}`))
    const next = (await listWorks(deps, { cursor: page.cursor })) as EventsListResult
    expect(next.events).toEqual([])
    expect(next.gap).toBeUndefined()
  } finally {
    realFs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a log rotating under a reader that pages behind it: no hole, no repeat, no spurious gap, only UNAVAILABLE to retry", async () => {
  const problems: string[] = []
  for (let trial = 0; trial < 8; trial++) {
    const dir = temp("boxd-race-stress-")
    try {
      let clock = Date.parse("2026-11-17T10:00:00.000Z")
      const log = new EventLog(dir, { rotateBytes: 4000, now: () => new Date(clock++) })
      const deps = depsOf(log, () => new Date(clock))
      for (let i = 0; i < 5; i++) await log.append({ workId: "w", from: null, to: "busy" })
      let cursor = ((await listWorks(deps, { since: "2026-11-17T00:00:00Z" })) as EventsListResult).cursor
      let head = 5
      let writing = true
      const writer = (async () => {
        for (let i = 0; i < 200; i++) await log.append({ workId: "w", from: "idle", to: "busy" })
        writing = false
      })()
      for (let reads = 0; writing || reads === 0; reads++) {
        let page: EventsListResult
        try {
          page = (await listWorks(deps, { cursor, limit: 500 })) as EventsListResult
        } catch (error) {
          const { code, message } = error as { code?: string; message: string }
          // The one retryable answer: the cursor is held, so the next read loses nothing.
          if (code !== "UNAVAILABLE" || message.includes(dir)) problems.push(`trial ${trial}: ${message}`)
          continue
        }
        const seqs = page.events.map((event) => Number(event.external_id.split(":")[1]))
        // Nothing was lost while the reader kept up, so a gap that lists nothing is a spurious one.
        if (page.gap !== undefined && seqs.length === 0) problems.push(`trial ${trial}: a gap that lists nothing after ${head}`)
        if (seqs.length > 0) {
          if (seqs[0]! > head + 1 && page.gap === undefined) problems.push(`trial ${trial}: a hole with no gap after ${head}: ${seqs[0]}`)
          if (seqs[0]! <= head) problems.push(`trial ${trial}: a repeat${page.gap ? " with a spurious gap" : ""} after ${head}: ${seqs[0]}`)
          head = Math.max(head, seqs[seqs.length - 1]!)
        }
        cursor = page.cursor
      }
      await writer
      // Whatever the reader saw while racing, it reads on to the head with nothing skipped.
      const rest = (await listWorks(deps, { cursor, limit: 500 })) as EventsListResult
      const last = rest.events.length ? Number(rest.events.at(-1)!.external_id.split(":")[1]) : head
      if (last !== 205) problems.push(`trial ${trial}: the read ended at ${last}, not 205`)
    } finally {
      realFs.rmSync(dir, { recursive: true, force: true })
    }
  }
  expect(problems).toEqual([])
}, 300_000)
