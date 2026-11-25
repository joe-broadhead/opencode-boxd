// Package C1's test kit: the plugin's own services (the provider on the fake boxd CLI and the ledger as the plugin
// builds them) with a fake guest server, narrow fakes for the watcher, cost and the host's sessions, and C1's runs. A test seeds machines, snapshots and faults on the fake, and reads back the calls, the spawns and the
// ledger.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { boxdError } from "../../src/errors.js"
import { createProvider, type PluginProvider } from "../../src/provider/index.js"
import { machineRuns, type MachineSeam } from "../../src/fleet/machines.js"
import { createLedger } from "../../src/ledger/index.js"
import type { WorkRecord } from "../../src/ledger/types.js"
import { parseOptions } from "../../src/options.js"
import type { CostPort } from "../../src/services.js"
import type { FleetServices, HostServices, SessionAccess } from "../../src/services.js"
import { notBuilt } from "./not-built.js"
import type { ChangeTarget, MachineId, MachineName, OpContext, Region } from "../../src/ports.js"
import type { CallContext } from "../../src/call.js"
import { startFakeGuest, type FakeGuest } from "../host/fake-guest.js"
import { startSpawnCounter, type CountingFake } from "../host/spawn-counter.js"

export const VERSION = "2.4.1"

export interface Kit {
  readonly guest: FakeGuest
  readonly counter: CountingFake
  readonly runtime: PluginProvider
  readonly services: FleetServices
  readonly runs: ReturnType<typeof machineRuns>
  readonly project: string
  readonly problems: Map<string, string>
  /** The session tree the fake host knows: child → parent. */
  readonly parents: Map<string, string>
  budgetReached: boolean
  /**
   * The next this many guest reads (`serve`, `phase`) are refused as a read whose listing aged in the runner's queue,
   * in the read rule's own words and with package D's marker: what a busy runner does to a wait (review 5b).
   */
  staleReads: number
  call(over?: Partial<CallContext>): CallContext
  /** Every boxd call since the last `reset`, as one argv string each. */
  calls(): string[]
  reset(): void
  record(workId: string): Promise<WorkRecord | undefined>
  write(record: WorkRecord): Promise<void>
  /** Runs `fn` as the plugin would on a machine it owns: under its lock, on a target checked by id. */
  change<T>(region: Region, name: string, id: string, fn: (target: ChangeTarget) => Promise<T>): Promise<T>
  /** Installs the plugin's helper on a seeded machine, as a golden image carries it. */
  install(region: Region, name: string, id: string): Promise<void>
  /** A golden image of the plugin's own recipe, built through boxd_golden. */
  golden(region?: Region | "all", size?: string): Promise<unknown>
  dispose(): Promise<void>
}

let calls = 0

export interface KitInput {
  readonly options?: Record<string, unknown>
  /** Options that name a file in the kit's own project folder, which exists by then. */
  readonly optionsFor?: (project: string) => Record<string, unknown>
  readonly seam?: MachineSeam
  readonly hostVersion?: string | null
}

export async function startKit(input: KitInput = {}): Promise<Kit> {
  const guest = startFakeGuest({ version: VERSION })
  const counter = await startSpawnCounter({ guestPort: guest.port, version: VERSION })
  const runtime = createProvider({ boxdBin: counter.boxdBin, opencodeBin: counter.opencodeBin })
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "boxd-c1-")))
  const project = join(root, "project")
  mkdirSync(project, { recursive: true })
  const problems = new Map<string, string>()
  const parents = new Map<string, string>()
  const sessions = {
    get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, ...(parents.has(sessionID) ? { parentID: parents.get(sessionID) } : {}) }),
  } as unknown as SessionAccess
  const host: HostServices = {
    options: parseOptions({ ...input.options, ...input.optionsFor?.(project) }),
    hostVersion: input.hostVersion === undefined ? VERSION : input.hostVersion,
    projectDirectory: project,
    ledgerRoot: join(root, "ledger"),
    clock: { now: () => new Date() },
    sessions,
    report: (area, problem) => void (problem ? problems.set(area, problem) : problems.delete(area)),
  }
  const ledger = createLedger({ ...host, ...runtime })
  const kit = {} as Kit
  const cost: CostPort = {
    ...notBuilt<CostPort>("cost"),
    assertBudget: async () => {
      if (kit.budgetReached) throw boxdError("BUDGET_REACHED", "Today's machine cost reached the budget.", { today: 51, daily: 50, currency: "EUR" })
    },
  }
  const stale = () => boxdError("BOXD_FAILED", "A guest read needs a machine listing at most 2 s old; this one is 2071 ms old.", { rule: "listing-age", kind: "listing-stale" })
  const refuse = () => {
    if (kit.staleReads <= 0) return
    kit.staleReads -= 1
    throw stale()
  }
  const guestPort = {
    ...runtime.guest,
    serve: async (...args: Parameters<typeof runtime.guest.serve>) => (refuse(), runtime.guest.serve(...args)),
    phase: async (...args: Parameters<typeof runtime.guest.phase>) => (refuse(), runtime.guest.phase(...args)),
  }
  const services: FleetServices = {
    ...host,
    ...runtime,
    guest: guestPort,
    ledger,
    watch: { subscribe: () => () => {}, snapshot: () => ({ asOf: new Date(0).toISOString(), works: [] }), sessionGone: () => {} },
    cost,
  }
  const op = (callId: string): OpContext => ({ call: { callId, source: "boxd_ensure" } })
  const runs = machineRuns(services, { intervalMs: 50, ...input.seam })
  Object.assign(kit, {
    guest,
    counter,
    runtime,
    services,
    runs,
    project,
    problems,
    parents,
    budgetReached: false,
    staleReads: 0,
    call: (over: Partial<CallContext> = {}) => ({ sessionID: "ses_coordinator", agent: "build", messageID: "msg_1", id: `call_${++calls}`, signal: new AbortController().signal, via: "rpc" as const, ...over }),
    calls: () => counter.spawns().filter((spawn) => spawn.verb !== "help" && spawn.bin === "boxd").map((spawn) => spawn.argv.join(" ")),
    reset: () => counter.reset(),
    record: (workId: string) => ledger.get(workId, op("kit")),
    write: (record: WorkRecord) => ledger.update([record.workId], async () => ({ write: [record], value: undefined }), op("kit")),
    change: <T,>(region: Region, name: string, id: string, fn: (target: ChangeTarget) => Promise<T>) =>
      runtime.runner.withMachineLock({ id: id as MachineId }, op("kit"), async () => fn((await runtime.boxd.checkOwned(region, name as MachineName, id as MachineId, op("kit"))).target)),
    install: async (region: Region, name: string, id: string) => {
      await kit.change(region, name, id, (target) => runtime.guest.setup(target, { directory: `/home/boxd/work/${name.slice(3)}`, opencode: VERSION }, op("kit")))
    },
    golden: (region: Region | "all" = "all", size = "2x8") => runs.boxd_golden({ region, size }, kit.call()),
    dispose: async () => {
      await runtime.dispose()
      await ledger.dispose()
      await counter.dispose()
      await guest.close()
      rmSync(root, { recursive: true, force: true })
    },
  })
  return kit
}

/** An open work's record as ensure writes it, for a test that seeds the ledger. */
export function workRecord(workId: string, over: Partial<WorkRecord> = {}): WorkRecord {
  const at = new Date().toISOString()
  return {
    format: 1,
    workId,
    state: "open",
    region: "fra",
    machine: `oc-${workId}`,
    machineId: null,
    size: "2x8",
    image: { name: `oc-golden-${VERSION}-2x8`, opencode: VERSION },
    laptopDirectory: "/tmp",
    guestDirectory: `/home/boxd/work/${workId}`,
    createdAt: at,
    touchedAt: at,
    ...over,
  }
}
