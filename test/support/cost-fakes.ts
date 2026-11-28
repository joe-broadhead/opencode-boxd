// Narrow fakes for package E's tests: a fleet snapshot, a fake FleetActions (C2's in-process actions) that records
// every call, a boxd port with usage, listing, by-id checks and lease renewals, a guest that answers `phase`, a
// ledger of records in memory, and the host's session API. Nothing here spawns a process.
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCost } from "../../src/cost/index.js"
import { boxdError } from "../../src/errors.js"
import type { Phase, SavedState, WorkRecord } from "../../src/ledger/types.js"
import { parseOptions } from "../../src/options.js"
import type { FleetWatch, Listing, MachineId, MachineRow, PhaseAnswer, Region, Usage, WorkEvent, WorkSnapshot } from "../../src/ports.js"
import type { ListResult } from "../../src/results.js"
import type { ActionContext, CostServices, FleetActions, SelectorValues } from "../../src/services.js"

export const tempRoot = (prefix: string) => realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)))
export const removeRoot = (root: string) => rmSync(root, { recursive: true, force: true })

export const T0 = new Date("2026-11-16T12:00:00.000Z")
export const minutesAgo = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString()

/** One snapshot work, running idle and finished by default. */
export function work(workId: string, over: Partial<WorkSnapshot> = {}): WorkSnapshot {
  return {
    workId,
    region: "fra",
    machineId: `vm_${workId}` as MachineId,
    size: "4x16",
    phase: "idle",
    outcome: "completed",
    saved: "stale",
    reading: { residentGiB: 3, load1: 0, at: T0.toISOString() },
    idleSince: minutesAgo(T0, 60),
    touchedAt: minutesAgo(T0, 60),
    notify: "ses_coord",
    ...over,
  }
}

export interface FakeWatch extends FleetWatch {
  works: WorkSnapshot[]
  listeners: Set<(event: WorkEvent) => void>
  emit(event: Partial<WorkEvent>): void
  /** Every `sessionGone` call, as the watcher (D) received it. */
  readonly gone: Array<{ sessionID: string; why: string }>
}

export function fakeWatch(works: WorkSnapshot[] = []): FakeWatch {
  const listeners = new Set<(event: WorkEvent) => void>()
  let current: WorkSnapshot[] = works
  let frozen: readonly WorkSnapshot[] = [...works]
  const watch: FakeWatch = {
    get works() {
      return current
    },
    set works(value: WorkSnapshot[]) {
      current = value
      frozen = [...value]
    },
    listeners,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    // The same array while nothing changed, as the watcher keeps it: the hooks rebuild their owner set only on change.
    snapshot: () => {
      if (frozen.length !== current.length || frozen.some((item, index) => item !== current[index])) frozen = [...current]
      return { asOf: T0.toISOString(), works: frozen }
    },
    emit(event) {
      for (const listener of listeners) listener({ seq: 1, at: T0.toISOString(), workId: "x", from: "busy", to: "idle", ...event })
    },
    gone: [],
    // As the watcher does: every open work that session drove is orphaned, and its notify cleared.
    sessionGone(sessionID, why) {
      watch.gone.push({ sessionID, why })
      watch.works = current.map((item) => (item.notify === sessionID ? { ...item, notify: undefined, orphaned: { why, session: sessionID, at: T0.toISOString() } } : item))
    },
  }
  return watch
}

export interface ActionCall {
  readonly method: "match" | "harvest" | "sleep"
  readonly ids: readonly string[]
  readonly context: ActionContext
  readonly select?: string
}

/** C2's `FleetActions`, faked: `match` answers from a table; each action answers its success state unless told to fail. */
export interface FakeActions extends FleetActions {
  readonly calls: ActionCall[]
  matches: Partial<Record<keyof SelectorValues, readonly string[]>>
  /** Per method, the ids whose item is refused with this code. */
  failing: Partial<Record<"harvest" | "sleep", Record<string, string>>>
}

function envelope<T extends { state: string }>(ids: readonly string[], success: (id: string) => T, failing: Record<string, string> = {}): ListResult<T> {
  const results = ids.map((id) =>
    failing[id] ? ({ state: "refused", workId: id, error: failing[id], message: "fake refusal", next: "none" } as never) : success(id),
  )
  const counts: Record<string, number> = {}
  for (const item of results) counts[(item as { state: string }).state] = (counts[(item as { state: string }).state] ?? 0) + 1
  const ok = results.filter((item) => !(item as { workId?: string; error?: string }).error).length
  return { state: ok === ids.length ? "done" : ok ? "partial" : "failed", counts, results }
}

export function fakeActions(): FakeActions {
  const calls: ActionCall[] = []
  const actions: FakeActions = {
    calls,
    matches: {},
    failing: {},
    async match(tool, select, context) {
      calls.push({ method: "match", ids: [], context, select: `${tool}:${select}` })
      return actions.matches[tool] ?? []
    },
    async harvest(ids, context) {
      calls.push({ method: "harvest", ids, context })
      return envelope(ids, (workId) => ({ state: "saved", workId, outcome: "completed", sessions: [], git: { known: true, dirty: false, patchStored: false, untracked: 0, ignored: 0, unpushed: 0 }, next: "" }) as never, actions.failing.harvest)
    },
    async sleep(ids, context) {
      calls.push({ method: "sleep", ids, context })
      return envelope(ids, (workId) => ({ state: "asleep", workId, machine: `oc-${workId}`, region: "fra", next: "" }) as never, actions.failing.sleep)
    },
  }
  return actions
}

export function record(workId: string, over: Partial<WorkRecord> = {}): WorkRecord {
  return {
    format: 1,
    workId,
    state: "open",
    region: "fra",
    machine: `oc-${workId}`,
    machineId: `vm_${workId}` as MachineId,
    size: "4x16",
    image: { name: "oc-golden-2.4.4-4x16", opencode: "2.4.4" },
    laptopDirectory: "/work/laptop",
    guestDirectory: `/home/boxd/work/${workId}`,
    createdAt: minutesAgo(T0, 600),
    session: { rootId: `ses_${workId}`, notify: "ses_coord" },
    ...over,
  }
}

export interface FakeBoxdLog {
  readonly calls: string[]
}

export interface Fakes {
  readonly services: CostServices
  readonly watch: FakeWatch
  readonly actions: FakeActions
  readonly records: Map<string, WorkRecord>
  readonly calls: string[]
  readonly reports: Map<string, string>
  readonly synthetic: Array<{ sessionID: string; text: string; metadata?: Record<string, unknown>; resume?: boolean | null }>
  /** What `ctx.session.context` answers, per session. */
  readonly contexts: Map<string, Array<{ type: string; metadata?: Record<string, unknown> }>>
  readonly sessions: Map<string, { archived?: number } | "missing">
  readonly root: string
  clock: { now: Date }
  usage: Usage
  /** The guest's phase answer per work id; idle by default. `throws` makes the read fail. */
  phases: Map<string, Partial<PhaseAnswer> & { throws?: boolean }>
  /** Listing status per machine name; running by default. */
  statuses: Map<string, MachineRow["status"]>
  /** Listing labels per machine name; `{ ledger }` by default, the steady state. */
  labels: Map<string, Record<string, string>>
  dispose(): void
}

export const LEDGER_ID = "0a1b2c3d4e"

export const RATES_EUR = { currency: "EUR", vcpuHour: 0.039, ramGiBHour: 0.012, diskGiBHour: 0.00008, source: "usage" } as const

export function fakes(input: { options?: Record<string, unknown>; works?: WorkSnapshot[]; records?: WorkRecord[]; usage?: Usage } = {}): Fakes {
  const root = tempRoot("boxd-cost-")
  const watch = fakeWatch(input.works ?? [])
  const actions = fakeActions()
  const records = new Map((input.records ?? []).map((item) => [item.workId, item]))
  const calls: string[] = []
  const reports = new Map<string, string>()
  const synthetic: Fakes["synthetic"] = []
  const contexts = new Map<string, Array<{ type: string; metadata?: Record<string, unknown> }>>()
  const sessionTable = new Map<string, { archived?: number } | "missing">()
  const state = {
    clock: { now: T0 },
    usage: input.usage ?? ({ available: true, currency: "EUR", total: 2, estimated: true, complete: true, asOf: T0.toISOString(), rates: RATES_EUR, machines: [] } as Usage),
    phases: new Map<string, Partial<PhaseAnswer> & { throws?: boolean }>(),
    statuses: new Map<string, MachineRow["status"]>(),
    labels: new Map<string, Record<string, string>>(),
  }
  const options = parseOptions(input.options ?? {})
  const listing = (): Listing => ({
    takenAt: state.clock.now.getTime(),
    fresh: true,
    machines: watch.works.map((item) => ({
      name: `oc-${item.workId}`,
      region: (item.region ?? "fra") as Region,
      id: null,
      status: state.statuses.get(`oc-${item.workId}`) ?? (item.phase === "asleep" ? "hibernated" : "running"),
      size: item.size,
      labels: state.labels.get(`oc-${item.workId}`) ?? { ledger: LEDGER_ID },
      sharing: "private",
      isolated: null,
    })),
  })
  const phase = (workId: string): PhaseAnswer & { throws?: boolean } => ({ phase: "idle", outcome: "completed", waiting: { steer: 0, queue: 0 }, guestVersion: "2.4.4", ...state.phases.get(workId) })
  const workOf = (name: string) => name.replace(/^oc-/, "")
  const saved = (item: WorkRecord): SavedState => (item.saved ? (item.saved.complete && (!item.lastSubmit || item.saved.at >= item.lastSubmit.at) ? "fresh" : "stale") : "none")
  const core = {
    options,
    hostVersion: "2.4.4",
    projectDirectory: root,
    ledgerRoot: join(root, "ledger"),
    boxdBin: "boxd",
    opencodeBin: "opencode",
    clock: { now: () => state.clock.now },
    report: (area: string, problem: string | undefined) => { problem ? reports.set(area, problem) : reports.delete(area) },
    sessions: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const entry = sessionTable.get(sessionID)
        if (entry === "missing") throw Object.assign(new Error(`Session not found: ${sessionID}`), { name: "NotFoundError" })
        return { id: sessionID, time: { created: 0, updated: 0, ...(entry?.archived ? { archived: entry.archived } : {}) } }
      },
      synthetic: async (value: { sessionID: string; text: string; metadata?: Record<string, unknown>; resume?: boolean | null }) => {
        synthetic.push(value)
        const list = contexts.get(value.sessionID) ?? []
        list.push({ type: "synthetic", metadata: value.metadata })
        contexts.set(value.sessionID, list)
        return {} as never
      },
      context: async ({ sessionID }: { sessionID: string }) => (contexts.get(sessionID) ?? []) as never,
    },
    runner: {
      singleFlight: <T>(_key: string, fn: () => Promise<T>) => fn(),
      withMachineLock: async <T>(_key: unknown, _context: unknown, fn: () => Promise<T>) => fn(),
    },
    boxd: {
      usage: async (since: string) => {
        calls.push(`usage ${since}`)
        return state.usage
      },
      list: async () => {
        calls.push("list")
        return listing()
      },
      checkOwned: async (region: Region, name: string, machineId: MachineId) => {
        calls.push(`checkOwned ${name} ${machineId}`)
        return { target: { region, name, machineId, checkedAt: state.clock.now.getTime() }, status: "running" } as never
      },
      setLabels: async (target: { machineId: string }, labels: Record<string, string>) =>
        void calls.push(`setLabels ${target.machineId} ${Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(",")}`),
      renewLease: async (target: { machineId: string }, days: number) => void calls.push(`renewLease ${target.machineId} ${days}d`),
      remove: async () => void calls.push("remove"),
      hibernate: async () => void calls.push("hibernate"),
    },
    guest: {
      phase: async (target: { name: string }) => {
        calls.push(`phase ${target.name}`)
        const answer = phase(workOf(target.name))
        if (answer.throws) throw boxdError("GUEST_UNRESPONSIVE")
        return answer
      },
    },
    ledger: {
      id: async () => LEDGER_ID,
      currentId: async () => LEDGER_ID,
      get: async (workId: string) => records.get(workId),
      list: async (filter: { readonly closed?: boolean } = {}) => [...records.values()].filter((item) => filter.closed || item.state === "open"),
      saved,
      update: async (ids: readonly string[], change: (current: ReadonlyMap<string, WorkRecord | undefined>) => Promise<{ write: readonly WorkRecord[]; value: unknown }>) => {
        const result = await change(new Map(ids.map((id) => [id, records.get(id)])))
        for (const item of result.write) records.set(item.workId, item)
        return result.value
      },
    },
  }
  const cost = createCost({ ...core, watch } as never)
  const services = { ...(core as object), watch, cost, actions } as unknown as CostServices
  return Object.assign(state, {
    services,
    watch,
    actions,
    records,
    calls,
    reports,
    synthetic,
    contexts,
    sessions: sessionTable,
    root,
    dispose: () => removeRoot(root),
  }) as Fakes
}

export type { Phase }
