// Review of #23, round 2: status's own re-list failing once answers from the cached phases instead of throwing.
import { afterEach, expect, test } from "bun:test"
import { fleetStatus, statusInput } from "../../src/fleet/status.js"
import { startWorld, type World } from "../support/fleet-world.js"

let world: World | undefined
afterEach(async () => {
  await world?.dispose()
  world = undefined
})

test("a busy work, a shared listing 2-10 s old, and a listing that fails once: status answers (stale), not throws", async () => {
  world = await startWorld()
  const w = world
  await w.work("busy-one", { busy: true })
  // Warm the shared listing, then let it age past 2 s but not 10 s.
  await w.services.boxd.list({ maxAgeMs: 0 }, w.context("warm"))
  await new Promise((r) => setTimeout(r, 2200))
  w.counter.fake.fault("machine list", { stderr: "error: network unreachable", code: 1 })
  const answer = await fleetStatus(w.services, statusInput({ view: "all" }), { tag: { callId: "s", source: "boxd_status" }, guestReads: true }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: String(error) }),
  )
  expect(answer.ok).toBe(true)
  if (!answer.ok) return
  expect(answer.value.works).toMatchObject([{ workId: "busy-one", phase: "busy", stale: true }])
  expect(answer.value.health.watcher).toContain("The machine listing failed")
  expect(answer.value.health.watcher).toContain("Next: boxd_status again in a later turn")
}, 60_000)
