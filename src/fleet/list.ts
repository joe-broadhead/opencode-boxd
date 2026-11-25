/**
 * The shared list-form runner (design §4.2), owned by package C1 and used by every tool that takes `works: [...]`.
 * Its API is stable: `runList`, `runOne`, `Poller`, `ItemContext` and `ListOptions`.
 *
 * - **Work, not waiting, holds a slot.** An item runs its active steps (validate, create, setup, prompt, export…) in one
 *   of `LIST_ITEM_CONCURRENCY` item slots. When it has to wait (a starting machine, a guest server coming up, a golden
 *   build in flight) it calls `context.waiting(fn)` or `context.poll(check)`, which give its item slot back for the
 *   wait, so 300 waiting items never keep a new active item from starting.
 * - **One shared poll loop.** Every waiting item of a call joins one `Poller`, which runs each item's check every
 *   `POLL_INTERVAL_MS`. A check is one short process (a listing or a `serve` read) through the runner's ordinary slots,
 *   and a tick runs at most `CAPS.shared` checks at once, so 300 waiting items never queue 300 reads in the runner.
 * - **The bound `B`** (`CALL_BOUND_MS`). Every wait stops at `context.deadline`, and the item answers its real state
 *   (`creating`, `starting`). Before each active step an item asks `context.room(stepBoundMs)`: when the step's own
 *   bound would run past the deadline, or the item got no slot back after a wait, it answers its state now instead of
 *   starting the step. An item that never started when the bound passed answers `cancelled` with `started: false`. Every item still pending (the `pendingStates`, and the ones never started) gets the same `next`:
 *   the list call for exactly those ids, so calling it again only waits and converges.
 * - **Stop.** The call's signal reaches every item. Items not started answer `CANCELLED` with `started: false`; an
 *   item stopped mid-write answers the `CANCELLED` its port raised, with `uncertain: true`.
 * - **Results** come back in input order, as `{ state, counts, results }` (`ListResult`). A coded error becomes that
 *   item's refusal; any other error is a bug and is thrown once every item has settled.
 */
import { BoxdError } from "../errors.js"
import { CALL_BOUND_MS, CAPS, LIST_ITEM_CONCURRENCY, POLL_INTERVAL_MS, type MachineName } from "../ports.js"
import type { ListResult, Refusal } from "../results.js"
import { refusalResult } from "../call.js"

/** What an item's run gets beside its input. */
export interface ItemContext {
  /** The call's Stop, for every port call the item makes. */
  readonly signal: AbortSignal
  /** `Date.now()` value at which the call stops waiting: `B`. */
  readonly deadline: number
  /**
   * Whether an active step bounded by `stepBoundMs` may start now: the item holds its slot, and the step's bound ends
   * before the deadline. When it answers false, the item answers its real state with its `next` instead.
   */
  room(stepBoundMs: number): boolean
  /**
   * Runs `fn` without holding an item slot: for a wait on something another flight does (a golden build). The slot is
   * taken back afterwards, but never past the deadline: `room` then answers false.
   */
  waiting<T>(fn: () => Promise<T>): Promise<T>
  /**
   * Waits in the call's shared poll loop, holding no item slot, until `check` answers a value, the deadline passes
   * (undefined), or the call is stopped (`CANCELLED`). A check that throws ends the wait with its error.
   */
  poll<T>(check: () => Promise<T | undefined>, until?: number): Promise<T | undefined>
}

export interface ListOptions<I, T extends { readonly state: string }> {
  readonly signal: AbortSignal
  /** The work id of an item, for its refusal and for the `next` of the items still pending. */
  readonly workId: (item: I) => string
  /** Which successful answers count as done; every answer by default. */
  readonly success?: (result: T) => boolean
  /** The states of an item that made progress but is not done: it is retried by the pending `next`. */
  readonly pendingStates?: readonly string[]
  /** The call to make again for the items still pending, such as `boxd_ensure({ works: [...] })`. */
  readonly again: (workIds: readonly string[]) => string
  /** `B`, in milliseconds; `CALL_BOUND_MS` by default. */
  readonly boundMs?: number
  readonly concurrency?: number
  readonly intervalMs?: number
  readonly now?: () => number
}

/**
 * One shared poll loop: each tick runs every waiter's check once, at most `perTick` at a time (the runner's shared
 * slots by default), and ends the waits that have an answer.
 */
export class Poller {
  readonly #waiters = new Set<Waiter>()
  readonly #intervalMs: number
  readonly #perTick: number
  readonly #now: () => number
  #timer: ReturnType<typeof setTimeout> | undefined
  #ticking = false

  constructor(options: { readonly intervalMs?: number; readonly perTick?: number; readonly now?: () => number } = {}) {
    this.#intervalMs = options.intervalMs ?? POLL_INTERVAL_MS
    this.#perTick = options.perTick ?? CAPS.shared
    this.#now = options.now ?? Date.now
  }

  /** How many waits are in the loop now. */
  get size(): number {
    return this.#waiters.size
  }

  wait<T>(check: () => Promise<T | undefined>, until: number, signal: AbortSignal): Promise<T | undefined> {
    if (signal.aborted) return Promise.reject(stopped())
    if (this.#now() >= until) return Promise.resolve(undefined)
    return new Promise<T | undefined>((resolve, reject) => {
      const waiter: Waiter = {
        check: check as () => Promise<unknown>,
        until,
        settle: (outcome) => {
          if (!this.#waiters.delete(waiter)) return
          signal.removeEventListener("abort", onAbort)
          clearTimeout(expiry)
          if (outcome.error !== undefined) reject(outcome.error)
          else resolve(outcome.value as T | undefined)
          if (this.#waiters.size === 0) this.#stop()
        },
      }
      const onAbort = () => waiter.settle({ error: stopped() })
      // A wait ends at its deadline even between ticks.
      const expiry = setTimeout(() => waiter.settle({ value: undefined }), Math.max(0, until - this.#now()))
      expiry.unref?.()
      signal.addEventListener("abort", onAbort, { once: true })
      this.#waiters.add(waiter)
      this.#schedule()
    })
  }

  #schedule(): void {
    if (this.#timer || this.#ticking) return
    this.#timer = setTimeout(() => void this.#tick(), this.#intervalMs)
    this.#timer.unref?.()
  }

  #stop(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
  }

  async #tick(): Promise<void> {
    this.#timer = undefined
    this.#ticking = true
    try {
      const queue = [...this.#waiters]
      const worker = async () => {
        for (let waiter = queue.shift(); waiter; waiter = queue.shift()) {
          // A wait that ended meanwhile (its deadline, a Stop) is not checked again.
          if (!this.#waiters.has(waiter)) continue
          try {
            const value = await waiter.check()
            if (value !== undefined) waiter.settle({ value })
            else if (this.#now() >= waiter.until) waiter.settle({ value: undefined })
          } catch (error) {
            waiter.settle({ error })
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(this.#perTick, queue.length) }, worker))
    } finally {
      this.#ticking = false
    }
    if (this.#waiters.size > 0) this.#schedule()
  }
}

interface Waiter {
  readonly check: () => Promise<unknown>
  readonly until: number
  readonly settle: (outcome: { readonly value?: unknown; readonly error?: unknown }) => void
}

const stopped = () => new BoxdError("CANCELLED", "The call was stopped while it waited.", { uncertain: false })

/** Item slots, handed out first in, first out; a waiter leaves the queue on Stop or at the deadline. */
class Slots {
  #free: number
  readonly #queue: Array<() => void> = []

  constructor(count: number) {
    this.#free = count
  }

  /** True once a slot is held; false when the call was stopped or the deadline passed first. */
  acquire(signal: AbortSignal, until: number, now: () => number): Promise<boolean> {
    if (signal.aborted || now() >= until) return Promise.resolve(false)
    if (this.#free > 0) {
      this.#free -= 1
      return Promise.resolve(true)
    }
    return new Promise<boolean>((resolve) => {
      const done = (held: boolean) => {
        const index = this.#queue.indexOf(grant)
        if (index !== -1) this.#queue.splice(index, 1)
        signal.removeEventListener("abort", onAbort)
        clearTimeout(expiry)
        resolve(held)
      }
      const grant = () => done(true)
      const onAbort = () => done(false)
      const expiry = setTimeout(() => done(false), Math.max(0, until - now()))
      expiry.unref?.()
      signal.addEventListener("abort", onAbort, { once: true })
      this.#queue.push(grant)
    })
  }

  release(): void {
    const next = this.#queue.shift()
    if (next) next()
    else this.#free += 1
  }
}

type Settled<T> = { readonly kind: "result"; readonly value: T } | { readonly kind: "refusal"; readonly value: Refusal } | { readonly kind: "bug"; readonly error: unknown }

/**
 * Runs every item, at most `concurrency` active at once, waits holding no slot, and answers the list envelope in input
 * order. Validation belongs to the caller and runs before this, so a bad item fails before anything bills.
 */
export async function runList<I, T extends { readonly state: string }>(
  items: readonly I[],
  options: ListOptions<I, T>,
  run: (item: I, context: ItemContext) => Promise<T>,
): Promise<ListResult<T>> {
  const now = options.now ?? Date.now
  const deadline = now() + (options.boundMs ?? CALL_BOUND_MS)
  const slots = new Slots(options.concurrency ?? LIST_ITEM_CONCURRENCY)
  const poller = new Poller({ ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}), now })
  const { signal } = options

  const one = async (item: I): Promise<Settled<T>> => {
    const workId = options.workId(item)
    if (!(await slots.acquire(signal, deadline, now))) return { kind: "refusal", value: notStarted(workId, signal.aborted, options.again([workId])) }
    let held = true
    const context: ItemContext = {
      signal,
      deadline,
      room: (stepBoundMs) => held && !signal.aborted && deadline - now() >= stepBoundMs,
      async waiting(fn) {
        if (held) {
          held = false
          slots.release()
        }
        try {
          return await fn()
        } finally {
          // Back to active work: a slot again, or none once the deadline passed (the item answers its state).
          held = await slots.acquire(signal, deadline, now)
        }
      },
      poll(check, until = deadline) {
        return context.waiting(() => poller.wait(check, Math.min(until, deadline), signal))
      },
    }
    try {
      return { kind: "result", value: await run(item, context) }
    } catch (error) {
      if (error instanceof BoxdError) return { kind: "refusal", value: refusalResult(error, { workId }) }
      return { kind: "bug", error }
    } finally {
      if (held) slots.release()
    }
  }

  const settled = await Promise.all(items.map(one))
  const bug = settled.find((entry): entry is Extract<Settled<T>, { kind: "bug" }> => entry.kind === "bug")
  if (bug) throw bug.error

  const pending = new Set(options.pendingStates ?? [])
  const results = settled.map((entry) => (entry as Exclude<Settled<T>, { kind: "bug" }>).value)
  const retry = results.filter((result) => pending.has(result.state) || isNotStarted(result)).map((result, index) => (result as { workId?: string }).workId ?? String(index))
  const again = retry.length > 0 ? options.again(retry) : undefined
  const final = results.map((result) => (again !== undefined && (pending.has(result.state) || isNotStarted(result)) ? { ...result, next: again } : result))

  const counts: Record<string, number> = {}
  for (const result of final) counts[result.state] = (counts[result.state] ?? 0) + 1
  const success = options.success ?? (() => true)
  const done = settled.filter((entry) => entry.kind === "result" && success(entry.value)).length
  const state = signal.aborted ? "cancelled" : done === items.length ? "done" : done === 0 ? "failed" : "partial"
  return { state, counts, results: final as ListResult<T>["results"] }
}

/** A single-form call through the same machinery: the bound, the poll loop, and Stop. A refusal is thrown. */
export async function runOne<T extends { readonly state: string }>(
  options: Pick<ListOptions<never, T>, "signal" | "boundMs" | "intervalMs" | "now">,
  run: (context: ItemContext) => Promise<T>,
): Promise<T> {
  const now = options.now ?? Date.now
  const deadline = now() + (options.boundMs ?? CALL_BOUND_MS)
  const poller = new Poller({ ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}), now })
  const context: ItemContext = {
    signal: options.signal,
    deadline,
    room: (stepBoundMs) => !options.signal.aborted && deadline - now() >= stepBoundMs,
    waiting: (fn) => fn(),
    poll: (check, until = deadline) => poller.wait(check, Math.min(until, deadline), options.signal),
  }
  return run(context)
}

function notStarted(workId: string, aborted: boolean, next: string): Refusal {
  return {
    state: "cancelled",
    workId,
    machine: `oc-${workId}` as MachineName,
    error: "CANCELLED",
    message: aborted ? "The call was stopped before this work started; nothing was changed for it." : "The call reached its time bound before this work started; nothing was changed for it.",
    next,
    started: false,
    uncertain: false,
  }
}

const isNotStarted = (result: { readonly state: string }) => result.state === "cancelled" && (result as Refusal).started === false

/** A list call's `next`: the tool with exactly these ids, in the item form its schema takes. */
export function listCall(tool: string, workIds: readonly string[], form: "objects" | "ids" = "objects"): string {
  const items = workIds.map((id) => (form === "objects" ? `{ workId: "${id}" }` : `"${id}"`)).join(", ")
  return `${tool}({ works: [${items}] })`
}
