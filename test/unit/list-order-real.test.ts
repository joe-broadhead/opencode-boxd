// boxd.works.list through the REAL fleetStatus: the works and their activity times are the only stubbed data (the
// watcher's observation cache), and everything else is the plugin's own code, including fleetStatus's sort. More than 50
// works, the newest named last by id, so this fails on the code that asked status for `{ view: "all", limit: 50 }` and
// fails when fleetStatus's activity sort is removed.
import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import { ownedMethods, type CallContext } from "../../src/tools.js"
import { localIdentity } from "../../src/sources.js"
import { viewRuns } from "../../src/fleet/view.js"
import { watchHandle } from "../../src/watch.js"
import { startWorld, type World } from "../support/fleet-world.js"

setDefaultTimeout(60_000)

let world: World
beforeEach(async () => {
  world = await startWorld()
})
afterEach(async () => {
  await world.dispose()
})

const call = () => ({ sessionID: "ses_list", agent: "build", messageID: "msg_list", id: "call_list", signal: new AbortController().signal } as CallContext)
const at = (minute: number) => new Date(Date.UTC(2026, 10, 16, 10, minute)).toISOString()

describe("boxd.works.list through the real fleetStatus", () => {
  test("the newest work survives 59 older ones named before it, whichever layer truncates", async () => {
    // More works than the status read's own bound (300): a-000…a-299, each newer than the last, and z-recent, the newest
    // and last by id. Only a status that sorts by activity before its bound keeps z-recent.
    const works = Array.from({ length: 300 }, (_, index) => `a-${String(index).padStart(3, "0")}`)
    await world.bulk([...works, "z-recent"].map((workId) => ({ workId, run: { outcome: "completed" as const, at: at(0) } })))
    // The only stubbed data: each work's observed activity, as a guest read would have recorded it.
    const handle = watchHandle(world.services.watch)
    expect(handle).toBeDefined()
    const now = world.clock.now.getTime()
    for (const [index, workId] of works.entries()) {
      handle!.remember(workId, { phase: "idle", outcome: "completed", readAt: now, since: at(0), lastActivityAt: at(index), waiting: { steer: 0, queue: 0 }, guestVersion: null, failures: 0, absent: 0 })
    }
    handle!.remember("z-recent", { phase: "idle", outcome: "completed", readAt: now, since: at(0), lastActivityAt: at(301), waiting: { steer: 0, queue: 0 }, guestVersion: null, failures: 0, absent: 0 })
    const method = ownedMethods({ runs: viewRuns(world.services) as never, selectors: {} as never }, async () => {}).find((entry) => entry.name === "boxd_status")!
    const answer = (await method.run({ list: "works", account: localIdentity().account }, call() as never)) as { data: { items: { id: string }[] } }
    expect(answer.data.items[0]?.id).toBe("z-recent")
    expect(answer.data.items).toHaveLength(50)
    // The oldest work, a-000, is the one the caps drop: the newest 50 are kept.
    expect(answer.data.items.map((item) => item.id)).not.toContain("a-000")
  })
})
