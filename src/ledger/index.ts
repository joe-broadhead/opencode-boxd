/**
 * Package B's entry for the ledger, format 1. Package B owns `src/ledger/*` (the types file included, whose shapes
 * every package reads). `src/index.ts` calls `createLedger` once.
 *
 * Every write is copy-on-write (temp, verify, fsync, rename), except the append-only `events.jsonl`.
 */
import type { EventPage, LedgerPort } from "../ports.js"
import type { HostServices, Provider } from "../services.js"
import { Ledger, savedState } from "./store.js"

export function createLedger(core: HostServices & Provider): LedgerPort {
  const store = new Ledger(core.ledgerRoot, { now: () => core.clock.now() })
  return ledgerPort(store)
}

/** The port over one store; exported for the tests, which give their own store and clock. */
export function ledgerPort(store: Ledger): LedgerPort {
  return {
    id: (_context) => store.id(),
    currentId: (_context) => store.currentId(),
    get: (workId, _context) => store.get(workId),
    async phases(filter, _context) {
      const { works } = await store.refresh()
      return new Map(Object.entries(works).filter(([, entry]) => filter.closed || entry.state === "open"))
    },
    async list(filter, _context) {
      const records = await store.list({ closed: filter.closed ?? false })
      const wanted = filter.workIds ? new Set(filter.workIds) : undefined
      return records.filter((record) => (!wanted || wanted.has(record.workId)) && (!filter.region || record.region === filter.region))
    },
    async update(workIds, change, context) {
      const ids = [...new Set(workIds)].sort()
      return store.withWorks(
        ids,
        async () => {
          const current = new Map<string, import("./types.js").WorkRecord | undefined>()
          for (const id of ids) current.set(id, await store.get(id))
          const { write, value } = await change(current)
          for (const record of write) {
            if (!ids.includes(record.workId)) throw new Error(`An update holding the locks of ${ids.join(", ")} tried to write work "${record.workId}".`)
          }
          for (const record of write) await store.put(record)
          return value
        },
        context.signal,
      )
    },
    saved: (record) => savedState(record),
    async appendEvent(event, context) {
      // Count the interval before the event lands: if the append fails, the record is already counted to this phase,
      // so the next event counts from here and no second is counted twice.
      await store.countPhase(event.workId, event.to, new Date(event.at), context.signal)
      const line = await store.events.append(event, context.signal)
      await store.setPhase(line.workId, line.to)
      return line
    },
    eventsSince: (cursor, _context): Promise<EventPage> => store.events.since(cursor),
    workFolder: (workId) => store.workDir(workId),
    stageFile: (workId, final, _context) => store.stageFile(workId, final),
    async commitFile(staged, expected, _context) {
      await store.commitStaged(staged, expected)
    },
    stageFolder: (workId, _final, _context) => store.stageFolder(workId),
    commitFolder: (staged, expected, _context) => store.commitFolder(staged, expected),
    discard: (staged) => store.discard(staged),
    dispose: () => store.dispose(),
  }
}
