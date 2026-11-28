// The ledger's durable copy on its registry machine (boxd-plugin#129): one machine in the first work's region, its
// labels and daily backups, an incremental copy by digest, a failed copy that leaves the last good copy whole, its own
// machine class, and the status warning when it falls behind or fails.
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fleetStatus, statusInput } from "../../src/fleet/status.js"
import { classifyMachines, machineSummary } from "../../src/fleet/orphans.js"
import { machineCounts } from "../../src/cost/machines.js"
import type { WorkRecord } from "../../src/ledger/types.js"
import type { MachineRow } from "../../src/ports.js"
import { startWorld, type World } from "../support/fleet-world.js"

setDefaultTimeout(60_000)

let world: World | undefined
afterEach(async () => {
  await world?.dispose()
  world = undefined
})

const registryOf = (w: World) => w.counter.fake.read().machines.find((machine) => machine.labels.role === "registry" && machine.status !== "destroyed")
const remote = (w: World, machine: { id: string }, ledgerId: string, path: string) => join(w.counter.fake.disk(machine.id), "home/boxd/.boxd-plugin/registry", ledgerId, path)
const local = (w: World, path: string) => readFileSync(join(w.root, path), "utf8")
const cpCalls = (w: World) => w.counter.spawns().filter((spawn) => spawn.verb === "machine cp").map((spawn) => spawn.argv.join(" "))

describe("the registry machine", () => {
  test("is made once in the first work's region, labelled, with daily backups, and holds the record and ledger id", async () => {
    world = await startWorld()
    const w = world
    await w.work("first")
    await w.watcher.tick()
    const ledgerId = await w.ledger.id(w.context("id"))
    const machine = registryOf(w)!
    expect(machine.name).toBe(`oc-reg-${ledgerId}`)
    expect(machine.region).toBe("fra")
    expect(machine.labels).toEqual({ owner: "boxd", role: "registry", ledger: ledgerId })
    expect(machine.backupsPeriod).toBe("24h")
    expect(w.watcher.registry.status()).toMatchObject({ machine: `oc-reg-${ledgerId}`, region: "fra", works: ["first"] })
    expect(readFileSync(remote(w, machine, ledgerId, "ledger-id"), "utf8")).toBe(local(w, "ledger-id"))
    expect(readFileSync(remote(w, machine, ledgerId, "v1/works/first/work.json"), "utf8")).toBe(local(w, "v1/works/first/work.json"))
    expect(w.watcher.registry.status()!.lastCopyAt).toBeDefined()
    // A second sweep finds the same machine and makes no second one.
    await w.watcher.tick()
    expect(w.counter.fake.read().machines.filter((entry) => entry.labels.role === "registry")).toHaveLength(1)
  })

  test("a replaced registry machine receives the whole copy, never an empty current one", async () => {
    world = await startWorld()
    const w = world
    await w.work("first")
    const bytes = "{\"info\":{\"id\":\"ses_first\"}}\n"
    const staged = await w.ledger.stageFile("first", "exports/ses_first.json", w.context("stage", "boxd_harvest"))
    await Bun.write(staged.path, bytes)
    await w.ledger.commitFile(staged, { bytes: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") }, w.context("commit", "boxd_harvest"))
    await w.watcher.tick()
    const ledgerId = await w.ledger.id(w.context("id"))
    const lost = registryOf(w)!
    const oldCopyAt = w.watcher.registry.status()!.lastCopyAt!
    expect(readFileSync(remote(w, lost, ledgerId, "v1/works/first/work.json"), "utf8")).toBe(local(w, "v1/works/first/work.json"))
    w.counter.fake.update((state) => {
      state.machines.find((machine) => machine.id === lost.id)!.status = "destroyed"
    })
    // A listing is shared for 10 s; a fresh sweep takes one after it ages out.
    await Bun.sleep(2_100)
    // The first copy to the replacement fails: status must not carry the old machine's complete copy.
    w.counter.fake.fault("machine cp", { stderr: "error: connection reset during copy" })
    await w.watcher.tick()
    const made = registryOf(w)!
    expect(made.id).not.toBe(lost.id)
    const failed = w.watcher.registry.status()!
    expect(failed.machine).toBe(`oc-reg-${ledgerId}`)
    expect(failed.lastCopyAt).not.toBe(oldCopyAt)
    expect(failed.lastCopyAt).toBeUndefined()
    expect(failed.warning).toContain("failed")
    expect(existsSync(remote(w, made, ledgerId, "v1/works/first/work.json"))).toBe(false)
    // The next sweep stages and moves the whole ledger to the new machine.
    await w.watcher.tick()
    expect(readFileSync(remote(w, made, ledgerId, "ledger-id"), "utf8")).toBe(local(w, "ledger-id"))
    expect(readFileSync(remote(w, made, ledgerId, "v1/works/first/work.json"), "utf8")).toBe(local(w, "v1/works/first/work.json"))
    expect(readFileSync(remote(w, made, ledgerId, "v1/works/first/exports/ses_first.json"), "utf8")).toBe(bytes)
    const status = w.watcher.registry.status()!
    expect(status).toMatchObject({ machine: `oc-reg-${ledgerId}`, works: ["first"] })
    expect(status.lastCopyAt).toBeDefined()
    expect(status.warning).toBeUndefined()
  })

  test("moves only what changed, by digest, and leaves the last good copy whole when a copy fails", async () => {
    world = await startWorld()
    const w = world
    await w.work("first")
    await w.watcher.tick()
    const ledgerId = await w.ledger.id(w.context("id"))
    const machine = registryOf(w)!
    const before = readFileSync(remote(w, machine, ledgerId, "v1/works/first/work.json"), "utf8")
    // Nothing changed: no file is copied again.
    w.counter.reset()
    await w.watcher.tick()
    expect(cpCalls(w).filter((call) => !call.includes("registry.json"))).toEqual([])
    // One record changes: its file moves, the ledger id does not.
    await w.record("first", (record) => ({ ...record, title: "changed" }))
    w.counter.reset()
    await w.watcher.tick()
    const moved = cpCalls(w)
    expect(moved.some((call) => call.includes("v1/works/first/work.json"))).toBe(true)
    expect(moved.some((call) => call.includes("ledger-id"))).toBe(false)
    const after = readFileSync(remote(w, machine, ledgerId, "v1/works/first/work.json"), "utf8")
    expect(after).not.toBe(before)
    expect(after).toBe(local(w, "v1/works/first/work.json"))
    // The next copy of that file fails: the registry keeps the last good copy, and status says so.
    await w.record("first", (record) => ({ ...record, title: "later" }))
    w.counter.fake.fault("machine cp", { stderr: "error: connection reset during copy" })
    await w.watcher.tick()
    expect(readFileSync(remote(w, machine, ledgerId, "v1/works/first/work.json"), "utf8")).toBe(after)
    expect(w.watcher.registry.status()!.warning).toContain("failed")
    const fleet = await fleetStatus(w.services, statusInput({}), { tag: { callId: "status-registry", source: "boxd_status" }, guestReads: false })
    expect(fleet.registry?.warning).toContain("failed")
    // The next sweep copies it, and the warning clears.
    await w.watcher.tick()
    expect(readFileSync(remote(w, machine, ledgerId, "v1/works/first/work.json"), "utf8")).toBe(local(w, "v1/works/first/work.json"))
    expect(w.watcher.registry.status()!.warning).toBeUndefined()
  })

  test("warns when the last complete copy is more than one sweep behind", async () => {
    world = await startWorld()
    const w = world
    await w.work("first")
    await w.watcher.tick()
    const copied = w.watcher.registry.status()!.lastCopyAt!
    w.clock.now = new Date(Date.parse(copied) + 61_000)
    expect(w.watcher.registry.status()!.warning).toContain("more than one sweep behind")
    const fleet = await fleetStatus(w.services, statusInput({}), { tag: { callId: "status-lag", source: "boxd_status" }, guestReads: false })
    expect(fleet.registry?.lastCopyAt).toBe(copied)
    expect(fleet.registry?.warning).toContain("more than one sweep behind")
    await w.watcher.tick()
    expect(w.watcher.registry.status()!.warning).toBeUndefined()
  })
})

describe("the registry machine's class", () => {
  const row = (name: string, labels: Record<string, string>): MachineRow => ({
    name,
    region: "fra",
    id: null,
    status: "running",
    size: "2x8",
    labels,
    sharing: "private",
    isolated: false,
  })

  test("is never an orphan, never adoptable and never counted against budget.machines", () => {
    const ledgerId = "0123456789"
    const registry = row(`oc-reg-${ledgerId}`, { owner: "boxd", role: "registry", ledger: ledgerId })
    const work = row("oc-lane", { owner: "boxd", role: "session", work: "lane", ledger: ledgerId })
    const record = { format: 1, workId: "lane", state: "open", region: "fra", machine: "oc-lane" } as unknown as WorkRecord
    const classified = classifyMachines([registry, work], [record], ledgerId, [])
    expect(classified.map((item) => [item.row.name, item.machineClass, item.actionable])).toEqual([
      [registry.name, "registry", false],
      [work.name, "work", false],
    ])
    expect(machineSummary(classified, 10).counts).toEqual({ work: 1, registry: 1, "other-ledger": 0, kept: 0, golden: 0, orphan: 0 })
    expect(machineSummary(classified, 10).orphans).toEqual([])
    const counts = machineCounts({ takenAt: Date.now(), fresh: true, machines: [registry, work] }, ledgerId, [])
    expect(counts).toEqual({ ledger: 1, org: 2 })
  })

  test("a registry in another ledger is still a registry, not another ledger's work or an orphan", () => {
    const ledgerId = "0123456789"
    const classified = classifyMachines([row("oc-reg-abcdef1234", { role: "registry", owner: "boxd", ledger: "abcdef1234" })], [], ledgerId, [])
    expect(classified[0]).toMatchObject({ machineClass: "registry", actionable: false })
  })

  test("a work's export and untracked set are copied byte for byte", async () => {
    world = await startWorld()
    const w = world
    await w.work("first")
    const folder = join(w.root, "v1", "works", "first")
    const bytes = "{\"info\":{\"id\":\"ses_first\"}}\n"
    const staged = await w.ledger.stageFile("first", "exports/ses_first.json", w.context("stage", "boxd_harvest"))
    await Bun.write(staged.path, bytes)
    await w.ledger.commitFile(staged, { bytes: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") }, w.context("commit", "boxd_harvest"))
    mkdirSync(join(folder, "untracked", "src"), { recursive: true })
    writeFileSync(join(folder, "untracked", "src", "new.ts"), "export const value = 1\n")
    await w.watcher.tick()
    const ledgerId = await w.ledger.id(w.context("id"))
    const machine = registryOf(w)!
    expect(readFileSync(remote(w, machine, ledgerId, "v1/works/first/exports/ses_first.json"), "utf8")).toBe(bytes)
    expect(readFileSync(remote(w, machine, ledgerId, "v1/works/first/untracked/src/new.ts"), "utf8")).toBe("export const value = 1\n")
    expect(existsSync(join(folder, "exports", "ses_first.json"))).toBe(true)
  })
})
