/**
 * Package B's entry for the ledger, format 1 (design §2.2). Package B owns `src/ledger/*` (the types file included,
 * whose shapes every package reads). `src/plugin.ts` calls `createLedger` once, after the import.
 *
 * Every method that reads or writes the ledger (records, events, staged files) passes the import gate first: while the v0 import is unfinished, here or in
 * another OpenCode process, it throws `LEDGER_IMPORTING` with `progress`; while the import's listing failed and its
 * 30 s have not passed, `IMPORT_V0_FAILED`; and for a work id whose v0 record could not be imported, `IMPORT_V0_FAILED`.
 * Nothing reads a partial ledger.
 */
import { boxdError } from "../errors.js"
import type { EventPage, ImportState, ImportV0Port, LedgerPort, OpContext } from "../ports.js"
import type { HostServices, Runtime } from "../services.js"
import { Ledger, savedState } from "./store.js"
import type { WorkRecord } from "./types.js"

/** How long a call waits for an import to finish before it answers `LEDGER_IMPORTING`. */
const GATE_WAIT_MS = 250

export function createLedger(core: HostServices & Runtime & { readonly importV0: ImportV0Port }): LedgerPort {
  const store = new Ledger(core.ledgerRoot, { now: () => core.clock.now() })
  return ledgerPort(store, core.importV0, () => core.clock.now())
}

/** The port over one store and one import; exported for the tests, which give their own store and import. */
export function ledgerPort(store: Ledger, importV0: Pick<ImportV0Port, "state" | "run">, now: () => Date = () => new Date()): LedgerPort {
  async function gate(context: OpContext, workIds: readonly string[] = []): Promise<void> {
    let state = importV0.state()
    if (state.state === "failed" && Date.parse(state.retryAt) > now().getTime()) throw importFailed(state.reason)
    if (state.state !== "complete") {
      // A short wait lets a call through when the ledger was published meanwhile (by another process, or a small import).
      state = (await waitAtMost(importV0.run(context), GATE_WAIT_MS)) ?? importV0.state()
      if (state.state === "failed") throw importFailed(state.reason)
      if (state.state !== "complete") {
        const progress = state.state === "importing" ? { done: state.done, total: state.total } : { done: 0, total: 0 }
        throw boxdError("LEDGER_IMPORTING", undefined, { progress })
      }
    }
    const blocked = (state as Extract<ImportState, { state: "complete" }>).blocked
    for (const workId of workIds) {
      if (blocked.includes(workId)) {
        throw boxdError("IMPORT_V0_FAILED", `Work "${workId}"'s v0 record could not be imported, so this id is blocked; its v0 file is untouched (see import-v0.json).`, { workId })
      }
    }
  }

  return {
    ready: (context) => gate(context),

    async get(workId, context) {
      await gate(context, [workId])
      return store.get(workId)
    },

    async list(filter, context) {
      await gate(context)
      const records = await store.list({ closed: filter.closed ?? false })
      const wanted = filter.workIds ? new Set(filter.workIds) : undefined
      return records.filter((record) => (!wanted || wanted.has(record.workId)) && (!filter.region || record.region === filter.region))
    },

    async update(workIds, change, context) {
      await gate(context, workIds)
      const ids = [...new Set(workIds)].sort()
      return store.withWorks(
        ids,
        async () => {
          const current = new Map<string, WorkRecord | undefined>()
          for (const id of ids) current.set(id, await store.get(id))
          const { write, value } = await change(current)
          for (const record of write) {
            if (!ids.includes(record.workId)) throw boxdError("LEDGER_FAILED", `An update holding the locks of ${ids.join(", ")} tried to write work "${record.workId}".`)
          }
          for (const record of write) await store.put(record)
          return value
        },
        context.signal,
      )
    },

    saved: (record) => savedState(record),

    async appendEvent(event, context) {
      await gate(context)
      const line = await store.events.append(event, context.signal)
      await store.setPhase(line.workId, line.to)
      return line
    },

    async eventsSince(cursor, context): Promise<EventPage> {
      await gate(context)
      return store.events.since(cursor)
    },

    workFolder: (workId) => store.workDir(workId),

    async stageFile(workId, final, context) {
      await gate(context, [workId])
      return store.stageFile(workId, final)
    },

    async commitFile(staged, expected, context) {
      await gate(context, [staged.workId])
      await store.commitStaged(staged, expected)
    },

    async stageFolder(workId, _final, context) {
      await gate(context, [workId])
      return store.stageFolder(workId)
    },

    async commitFolder(staged, expected, context) {
      await gate(context, [staged.workId])
      await store.commitFolder(staged, expected)
    },

    discard: (staged) => store.discard(staged),

    dispose: () => store.dispose(),
  }
}

const importFailed = (reason: string) => boxdError("IMPORT_V0_FAILED", `The v0 import could not list the machines: ${reason}.`)

function waitAtMost<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
