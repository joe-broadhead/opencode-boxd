// Package D's world for the fleet view and the watcher: the real runtime over the fake boxd CLI and the fake guest, a
// real published ledger in a temp root, a fake host session API that records notices, and the watcher with no timer.
import { cpSync } from "node:fs"
import { join } from "node:path"
import { createCost } from "../../src/cost/index.js"
import { createLedger } from "../../src/ledger/index.js"
import type { WorkRecord } from "../../src/ledger/types.js"
import { parseOptions } from "../../src/options.js"
import { createProvider, type PluginProvider } from "../../src/provider/index.js"
import type { ChangeTarget, CallTag, LedgerPort, MachineId, MachineName, OpContext } from "../../src/ports.js"
import { notBuilt } from "./not-built.js"
import type { CoreServices, CostPort, FleetServices, SessionAccess } from "../../src/services.js"
import { createWatch, type Watcher } from "../../src/watch.js"
import { startFakeGuest, type FakeGuest } from "../host/fake-guest.js"
import { startSpawnCounter, type CountingFake } from "../host/spawn-counter.js"
import { removeRoot, tempRoot } from "./temp.js"

export interface Posted {
  readonly sessionID: string
  readonly text: string
  readonly resume: boolean
  readonly delivery?: string
}

/** The host's sessions as the notices see them: each can be gone, archived, re-parented, or refuse a wake. */
export class FakeSessions {
  readonly posted: Posted[] = []
  readonly sessions = new Map<string, { parentID?: string; archived?: number; refuseWake?: boolean; refuseAll?: boolean }>()

  add(id: string, over: { parentID?: string; archived?: number; refuseWake?: boolean; refuseAll?: boolean } = {}) {
    this.sessions.set(id, over)
  }

  get api(): SessionAccess {
    return {
      get: (async (input: { sessionID: string }) => {
        const session = this.sessions.get(input.sessionID)
        if (!session) throw new Error(`session ${input.sessionID} not found`)
        return { id: input.sessionID, ...(session.parentID ? { parentID: session.parentID } : {}), time: { created: 1, updated: 1, ...(session.archived ? { archived: session.archived } : {}) } }
      }) as never,
      synthetic: (async (input: { sessionID: string; text: string; resume?: boolean; delivery?: string }) => {
        const session = this.sessions.get(input.sessionID)
        if (!session || session.refuseAll || (session.refuseWake && input.resume)) throw new Error("conflict")
        this.posted.push({ sessionID: input.sessionID, text: input.text, resume: input.resume === true, ...(input.delivery ? { delivery: input.delivery } : {}) })
        return {} as never
      }) as never,
      context: notBuilt<SessionAccess>("sessions").context,
    }
  }
}

export interface World {
  readonly root: string
  readonly guest: FakeGuest
  readonly counter: CountingFake
  readonly runtime: PluginProvider
  readonly ledger: LedgerPort
  readonly sessions: FakeSessions
  readonly services: FleetServices
  readonly watcher: Watcher
  /** The clock every part reads; a test moves it. */
  readonly clock: { now: Date }
  /** A running work with the helper installed and one session, recorded in the ledger as `over` says. */
  work(workId: string, over?: Partial<WorkRecord> & { readonly busy?: boolean; readonly notify?: string }): Promise<WorkRecord>
  /** Many works at once, with no guest: machines in the fake listing and records in the ledger, idle by their record. */
  bulk(records: ReadonlyArray<Partial<WorkRecord> & { readonly workId: string; readonly status?: string }>): Promise<void>
  record(workId: string, change: (record: WorkRecord) => WorkRecord): Promise<WorkRecord>
  /** Installs the helper on bulk machines by copying a set-up work's machine disk onto theirs. */
  installHelper(from: WorkRecord, workIds: readonly string[]): void
  context(callId: string, source?: CallTag["source"]): OpContext
  dispose(): Promise<void>
}

export async function startWorld(
  options: {
    readonly options?: Record<string, unknown>
    /** A fake cost port, or "real" for package E's own `createCost` over this world. */
    readonly cost?: CostPort | "real"
    readonly latencyMs?: readonly [number, number]
  } = {},
): Promise<World> {
  const root = tempRoot("boxd-fleet-")
  const guest = startFakeGuest({ version: "2.4.1" })
  const counter = await startSpawnCounter({ guestPort: guest.port, ...(options.latencyMs ? { latencyMs: options.latencyMs } : {}) })
  const runtime = createProvider({ boxdBin: counter.boxdBin, opencodeBin: counter.opencodeBin })
  const sessions = new FakeSessions()
  const clock = { now: new Date("2026-11-16T10:00:00.000Z") }
  const host = {
    options: parseOptions(options.options ?? {}),
    hostVersion: "2.4.1",
    projectDirectory: root,
    ledgerRoot: root,
    clock: { now: () => clock.now },
    sessions: sessions.api,
    report: () => {},
  }
  const ledger = createLedger({ ...host, ...runtime })
  const core: CoreServices = { ...host, ...runtime, ledger }
  const watcher = createWatch(core, { autoStart: false })
  const cost = options.cost === "real" ? createCost({ ...core, watch: watcher.watch }) : (options.cost ?? notBuilt<CostPort>("cost"))
  const services: FleetServices = { ...core, watch: watcher.watch, cost }
  const context = (callId: string, source: CallTag["source"] = "boxd_status"): OpContext => ({ call: { callId, source } })

  async function record(workId: string, change: (record: WorkRecord) => WorkRecord): Promise<WorkRecord> {
    return ledger.update(
      [workId],
      async (current) => {
        const next = change(current.get(workId)!)
        return { write: [next], value: next }
      },
      context("seed", "boxd_ensure"),
    )
  }

  function baseRecord(workId: string, machineId: string): WorkRecord {
    const at = clock.now.toISOString()
    return {
      format: 1,
      workId,
      state: "open",
      region: "fra",
      machine: `oc-${workId}` as MachineName,
      machineId: machineId as MachineId,
      size: "2x8",
      image: { name: "oc-golden-2.4.1-2x8", opencode: "2.4.1" },
      laptopDirectory: root,
      guestDirectory: `/home/boxd/work/${workId}`,
      createdAt: at,
      session: { rootId: `ses_${workId.replace(/-/g, "_")}` },
      lastSubmit: { at, delivery: "steer" },
    }
  }

  async function bulk(items: ReadonlyArray<Partial<WorkRecord> & { readonly workId: string; readonly status?: string }>): Promise<void> {
    counter.fake.update((state) => {
      for (const item of items) {
        state.machines.push({
          id: `vm_bulk_${item.workId}`,
          name: `oc-${item.workId}`,
          region: "fra",
          status: item.status ?? "running",
          vcpu: 2,
          labels: { owner: "boxd", role: "session", work: item.workId },
          sharing: "private",
          isolated: false,
          source: "oc-golden-2.4.1-2x8",
          autoSuspend: 0,
          autoHibernate: 7200,
          ignoreOutbound: "off",
        })
      }
    })
    for (let start = 0; start < items.length; start += 25) {
      await Promise.all(
        items.slice(start, start + 25).map((item) => {
          const { status: _status, ...fields } = item
          const record = { ...baseRecord(item.workId, `vm_bulk_${item.workId}`), ...fields }
          return ledger.update([item.workId], async () => ({ write: [record], value: undefined }), context("seed", "boxd_ensure"))
        }),
      )
    }
    counter.reset()
  }

  async function work(workId: string, over: Partial<WorkRecord> & { readonly busy?: boolean; readonly notify?: string } = {}): Promise<WorkRecord> {
    const { busy, notify, ...fields } = over
    const name = `oc-${workId}` as MachineName
    const machine = counter.fake.machine({ name, region: "fra", labels: { owner: "boxd", role: "session", work: workId } })
    const directory = `/home/boxd/work/${workId}`
    const session = `ses_${workId.replace(/-/g, "_")}`
    const op = context(`seed-${workId}`, "boxd_ensure")
    const change = async <T>(fn: (target: ChangeTarget) => Promise<T>) =>
      runtime.runner.withMachineLock({ id: machine.id as MachineId }, op, async () => fn((await runtime.boxd.checkOwned("fra", name, machine.id as MachineId, op)).target))
    await change((target) => runtime.guest.setup(target, { directory, opencode: "2.4.1" }, op))
    guest.next(session)
    await change((target) => runtime.guest.prompt(target, { directory, sessionId: null, title: workId, text: "start", delivery: "steer" }, op))
    if (!busy) guest.complete(session)
    const base: WorkRecord = { ...baseRecord(workId, machine.id), session: { rootId: session, ...(notify ? { notify } : {}) } }
    const written = await ledger.update([workId], async () => ({ write: [{ ...base, ...fields }], value: { ...base, ...fields } }), op)
    counter.reset()
    return written
  }

  return {
    root,
    guest,
    counter,
    runtime,
    ledger,
    sessions,
    services,
    watcher,
    clock,
    work,
    bulk,
    record,
    installHelper(from, workIds) {
      const disks = (counter.fake.read() as unknown as { root: string }).root
      for (const id of workIds) cpSync(join(disks, from.machineId!), join(disks, `vm_bulk_${id}`), { recursive: true })
    },
    context,
    async dispose() {
      await watcher.dispose()
      await ledger.dispose()
      await runtime.dispose()
      await counter.dispose()
      await guest.close()
      removeRoot(root)
    },
  }
}
