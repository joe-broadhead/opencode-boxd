// Review of #23, round 2: a listing refresh that fails while status's reads are queued leaves works stale, never unreachable.
import { afterEach, expect, test } from "bun:test"
import { cpSync } from "node:fs"
import { fleetStatus, statusInput } from "../../src/fleet/status.js"
import { watchHandle } from "../../src/watch.js"
import { startWorld, type World } from "../support/fleet-world.js"

let world: World | undefined
afterEach(async () => {
  await world?.dispose()
  world = undefined
})

test("a failed refresh during status's queued reads: stale, or counted toward unreachable?", async () => {
  world = await startWorld({ latencyMs: [300, 300] })
  const w = world
  const n = 40
  const seed = await w.work("seed")
  await w.bulk(Array.from({ length: n }, (_, i) => ({ workId: `b-${i}`, session: { rootId: `ses_b_${i}` } })))
  const root = (w.counter.fake.read() as unknown as { root: string }).root
  for (let i = 0; i < n; i++) cpSync(`${root}/${seed.machineId}`, `${root}/vm_bulk_b-${i}`, { recursive: true })
  await w.record("seed", (r) => ({ ...r, state: "closed" }))
  const handle = watchHandle(w.services.watch)!
  const tally = () => {
    const t: Record<string, number> = {}
    for (let i = 0; i < n; i++) {
      const o = handle.observed(`b-${i}`)
      const k = `${o?.phase ?? "?"}/${o?.code ?? "-"}/f${o?.failures ?? 0}`
      t[k] = (t[k] ?? 0) + 1
    }
    return t
  }
  for (let round = 1; round <= 2; round++) {
    // The listing fails once, about a second into the call: that is the refresh the queued reads join.
    setTimeout(() => { for (let k = 0; k < 3; k++) w.counter.fake.fault("machine list", { stderr: "error: network unreachable", code: 1 }) }, 1000)
    const answer = await fleetStatus(w.services, statusInput({ view: "all", limit: 300 }), { tag: { callId: `s${round}`, source: "boxd_status" }, guestReads: true })
    expect(answer.works!.filter((work) => work.phase === "unreachable")).toEqual([])
    // Every busy work was read, or kept its last phase marked stale.
    expect(answer.works!.filter((work) => work.workId.startsWith("b-") && !work.stale && handle.observed(work.workId)?.readAt === undefined)).toEqual([])
    w.clock.now = new Date(w.clock.now.getTime() + 61_000)
    await new Promise((r) => setTimeout(r, 2100))
  }
  const unreachable = Object.entries(tally()).filter(([k]) => k.startsWith("unreachable")).reduce((s, [, v]) => s + v, 0)
  expect(unreachable).toBe(0)
  // No guest read counted a listing failure as a failure.
  expect(Object.keys(tally()).filter((key) => !key.endsWith("/f0"))).toEqual([])
}, 180_000)
