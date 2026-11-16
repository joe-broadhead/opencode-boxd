// The shared list-form runner (design §4.2): results in input order with one envelope, waits that hold no item slot,
// one shared poll loop, the honest bound B (items that progressed answer their real state, items never started answer
// cancelled with started: false, both with the same next), and Stop.
import { describe, expect, test } from "bun:test"
import { boxdError } from "../../src/errors.js"
import { listCall, Poller, runList, runOne, type ItemContext } from "../../src/fleet/list.js"
import type { Refusal } from "../../src/results.js"

type Item = { readonly workId: string }
type Answer = { readonly state: "ready" | "starting"; readonly workId: string; readonly next: string }

const items = (count: number, prefix = "w"): Item[] => Array.from({ length: count }, (_, index) => ({ workId: `${prefix}${index}` }))
const options = (signal = new AbortController().signal) => ({
  signal,
  workId: (item: Item) => item.workId,
  success: (answer: Answer) => answer.state === "ready",
  pendingStates: ["starting"],
  again: (ids: readonly string[]) => listCall("boxd_ensure", ids),
  intervalMs: 10,
})
const ready = (item: Item): Answer => ({ state: "ready", workId: item.workId, next: "done" })

describe("results and the envelope", () => {
  test("results come back in input order, counted by state; done, partial and failed say how many succeeded", async () => {
    const delays = [30, 5, 20, 1]
    const all = await runList(items(4), options(), async (item) => {
      await Bun.sleep(delays[Number(item.workId.slice(1))]!)
      return ready(item)
    })
    expect(all.results.map((result) => (result as Answer).workId)).toEqual(["w0", "w1", "w2", "w3"])
    expect(all).toMatchObject({ state: "done", counts: { ready: 4 } })

    const mixed = await runList(items(3), options(), async (item) => {
      if (item.workId === "w1") throw boxdError("NOT_OURS", "Someone else's machine.")
      return ready(item)
    })
    expect(mixed.state).toBe("partial")
    expect(mixed.counts).toEqual({ ready: 2, refused: 1 })
    expect(mixed.results[1]).toMatchObject({ state: "refused", workId: "w1", machine: "oc-w1", error: "NOT_OURS" })

    const none = await runList(items(2), options(), async () => {
      throw boxdError("MACHINE_LIMIT", "Full.")
    })
    expect(none.state).toBe("failed")
  })

  test("an error that is not a coded refusal is a bug, and is thrown once every item settled", async () => {
    let finished = 0
    await expect(
      runList(items(3), options(), async (item) => {
        if (item.workId === "w0") throw new TypeError("a bug")
        await Bun.sleep(20)
        finished += 1
        return ready(item)
      }),
    ).rejects.toThrow("a bug")
    expect(finished).toBe(2)
  })

  test("listCall spells the items as the tool's schema takes them", () => {
    expect(listCall("boxd_ensure", ["a", "b"])).toBe('boxd_ensure({ works: [{ workId: "a" }, { workId: "b" }] })')
    expect(listCall("boxd_resume", ["a"], "ids")).toBe('boxd_resume({ works: ["a"] })')
  })
})

describe("work, not waiting, holds a slot (M5)", () => {
  test("300 waiting items with 8 slots still let a new active item start at once, and share one poll loop", async () => {
    let active = 0
    let peak = 0
    let released = false
    const started: number[] = []
    const t0 = Date.now()
    const list = runList([...items(300), { workId: "late" }], { ...options(), concurrency: 8, intervalMs: 20 }, async (item, context: ItemContext) => {
      active += 1
      peak = Math.max(peak, active)
      if (item.workId === "late") {
        started.push(Date.now() - t0)
        active -= 1
        return ready(item)
      }
      active -= 1
      // Waiting: no item slot is held, so the next item can start.
      await context.poll(async () => (released ? true : undefined))
      return ready(item)
    })
    await Bun.sleep(200)
    // The late item got a slot while the 300 waited.
    expect(started).toHaveLength(1)
    expect(peak).toBeLessThanOrEqual(8)
    released = true
    const result = await list
    expect(result).toMatchObject({ state: "done", counts: { ready: 301 } })
  })

  test("a tick runs at most the runner's shared slots of checks at once (review 5b)", async () => {
    const poller = new Poller({ intervalMs: 10 })
    const signal = new AbortController().signal
    let running = 0
    let peak = 0
    let open = false
    const waits = Array.from({ length: 60 }, () =>
      poller.wait(async () => {
        running += 1
        peak = Math.max(peak, running)
        await Bun.sleep(5)
        running -= 1
        return open ? true : undefined
      }, Date.now() + 5_000, signal),
    )
    await Bun.sleep(80)
    open = true
    await Promise.all(waits)
    expect(peak).toBe(12)
  })

  test("after a wait past the deadline, the item gets no slot back and room() says no", async () => {
    const result = await runList(items(1), { ...options(), boundMs: 100 }, async (item, context) => {
      expect(context.room(10)).toBe(true)
      await context.waiting(() => Bun.sleep(150))
      return { state: context.room(1) ? ("ready" as const) : ("starting" as const), workId: item.workId, next: "unused" }
    })
    expect(result.results[0]).toMatchObject({ state: "starting" })
  })

  test("one shared loop runs each waiter's check once per tick", async () => {
    const poller = new Poller({ intervalMs: 15 })
    const signal = new AbortController().signal
    let checks = 0
    let open = false
    const waits = Array.from({ length: 50 }, () =>
      poller.wait(async () => {
        checks += 1
        return open ? "up" : undefined
      }, Date.now() + 5_000, signal),
    )
    expect(poller.size).toBe(50)
    await Bun.sleep(40)
    // Two or three ticks of 50 checks each: one check per waiter per tick, never more.
    expect(checks % 50).toBe(0)
    expect(checks).toBeGreaterThanOrEqual(50)
    open = true
    expect(await Promise.all(waits)).toEqual(Array(50).fill("up"))
    expect(poller.size).toBe(0)
  })
})

describe("the bound B (L-e)", () => {
  test("at the bound, items that progressed answer their real state and items never started answer cancelled; both get the same next", async () => {
    const result = await runList(items(4), { ...options(), concurrency: 1, boundMs: 150 }, async (item, context) => {
      if (item.workId === "w0") {
        // Active work past the bound holds the only slot: w2 and w3 never start.
        await Bun.sleep(200)
        return ready(item)
      }
      // w1 starts once w0 is done, after the bound: it never starts.
      const up = await context.poll(async () => undefined)
      return { state: up ? ("ready" as const) : ("starting" as const), workId: item.workId, next: "unused" }
    })
    const [w0, w1, w2, w3] = result.results as Array<Answer | Refusal>
    expect(w0).toMatchObject({ state: "ready" })
    for (const refusal of [w1, w2, w3]) expect(refusal).toMatchObject({ state: "cancelled", error: "CANCELLED", started: false, uncertain: false })
    expect((w1 as Refusal).next).toBe('boxd_ensure({ works: [{ workId: "w1" }, { workId: "w2" }, { workId: "w3" }] })')
    expect(result).toMatchObject({ state: "partial", counts: { ready: 1, cancelled: 3 } })
  })

  test("an item that waits past the bound answers its progress state, with the list's next for the pending ids", async () => {
    const result = await runList(items(3), { ...options(), boundMs: 120 }, async (item, context) => {
      if (item.workId === "w1") return ready(item)
      const up = await context.poll(async () => undefined)
      return { state: up ? ("ready" as const) : ("starting" as const), workId: item.workId, next: "unused" }
    })
    expect(result.results.map((entry) => entry.state)).toEqual(["starting", "ready", "starting"])
    expect((result.results[0] as Answer).next).toBe('boxd_ensure({ works: [{ workId: "w0" }, { workId: "w2" }] })')
    expect((result.results[1] as Answer).next).toBe("done")
    expect(result.state).toBe("partial")
  })

  test("runOne: a single call stops waiting at the bound too", async () => {
    const t0 = Date.now()
    const answer = await runOne({ signal: new AbortController().signal, boundMs: 100, intervalMs: 10 }, async (context) => ({ state: (await context.poll(async () => undefined)) ? "ready" : "starting" }))
    expect(answer.state).toBe("starting")
    expect(Date.now() - t0).toBeLessThan(1_000)
  })
})

describe("Stop", () => {
  test("items not started answer cancelled with started: false; an item stopped mid-write keeps its uncertain refusal", async () => {
    const stop = new AbortController()
    // Two active items hold both slots (a create in flight, a setup in flight), so w2 and w3 never start.
    const list = runList(items(4), { ...options(stop.signal), concurrency: 2 }, async (item, context): Promise<Answer> => {
      const write = item.workId === "w0"
      return new Promise((_, reject) => context.signal.addEventListener("abort", () => reject(boxdError("CANCELLED", "Stopped while boxd machine new ran.", { uncertain: write }))))
    })
    await Bun.sleep(50)
    stop.abort()
    const result = await list
    expect(result.state).toBe("cancelled")
    expect(result.results[0]).toMatchObject({ state: "cancelled", uncertain: true })
    expect(result.results[1]).toMatchObject({ state: "cancelled", error: "CANCELLED" })
    for (const index of [2, 3]) expect(result.results[index]).toMatchObject({ state: "cancelled", started: false })
  })
})
