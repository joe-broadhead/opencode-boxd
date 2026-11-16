/**
 * The session hooks and events of cost and cleanup (design §C.3, §C.4). Package E owns this file.
 *
 * - **`context`**: one fleet line, only for a session that owns works (`session.notify` of an open work), at most 240
 *   characters, plugin fields only (no guest text), and only on a request that **starts a turn** (its tail is a `user`
 *   message: the person's prompt, or a notice that woke the session) after the coarse fleet fingerprint changed. A change
 *   seen mid tool loop waits for the next turn; the notices and the idle check cover it meanwhile. Why: providers that
 *   cache by breakpoint put the tail breakpoint on the last message, so a line on a mid-loop request makes the next step
 *   miss that entry and write the step's tool output again. At the start of a turn the only extra is the line itself
 *   (about 50 tokens) and the person's prompt written to the cache once more. `system` is never touched: it stays
 *   byte-identical, so the provider's prompt cache holds. The line is inserted as a **new** trailing `user` message; an
 *   existing message, and its part array, is never changed (review note N-1). The edit applies to this request only
 *   and is never stored.
 * - **`compaction`**: for an owner session, one new trailing `user` message asking the summary to keep the open works
 *   (at most 30 ids with their phase); `system` untouched. A summariser may drop it (an overflow compaction always
 *   does), so the first request after a compaction carries the line and the same ids once, whatever its tail: the
 *   compaction has replaced the cached history anyway.
 * - **`experimental.idle`**: speaks only when money burns and automation will not act; one note at most per 30 minutes
 *   per session, tagged `metadata: { boxd: "idle-check", id }`, silent while its fingerprint is unchanged and when the
 *   session's newest input is its own note. Experimental in OpenCode: if it fails to register, status says so and
 *   layers 1 and 2 still hold.
 * - **Events** `session.deleted` and `session.archived`: passed to the watcher's `sessionGone`, the fast path that marks
 *   the works that session drove `orphaned`; then automation is woken. The watcher's `ctx.session.get` check stays the
 *   ground truth. OpenCode has no separate "session ended" event.
 *
 * No hook makes a CLI call or a guest read: each reads the watcher's snapshot and the last usage read, in memory. Every
 * callback catches its own errors, so a hook never fails a request.
 */
import { randomBytes } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { internalsOf } from "./cost/index.js"
import { burning, compactionText, fleetLine, openWorks } from "./cost/lines.js"
import { sharedOf } from "./cost/shared.js"
import type { WorkSnapshot } from "./ports.js"
import type { CostServices, Dispose } from "./services.js"

/** The session hooks cost and cleanup registers. */
export const COST_HOOKS = ["context", "compaction", "experimental.idle"] as const
/** The session events that orphan a coordinator's works. */
export const SESSION_GONE_EVENTS = ["session.deleted", "session.archived"] as const
/** The idle check speaks at most this often per session. */
export const IDLE_NOTE_GAP_MS = 30 * 60_000
/** The metadata tag on the idle check's own notes. */
export const IDLE_TAG = "idle-check"

type HookContext = {
  readonly session: Pick<Plugin.Context["session"], "hook">
  readonly event: Pick<Plugin.Context["event"], "subscribe">
}

/** The request shape the context and compaction hooks get: only `messages` is touched. */
interface RequestLike {
  readonly sessionID: string
  readonly system: unknown
  messages: unknown[]
}

/**
 * A new `user` message holding only `text`. Made with the class of the request's own messages, so it is the same kind
 * of value OpenCode built (the plugin imports no AI package of its own); a plain object when they are plain.
 */
export function userMessage(messages: readonly unknown[], text: string): unknown {
  const init = { role: "user", content: [{ type: "text", text }] }
  const sample = messages.find((message) => typeof message === "object" && message !== null && "role" in message)
  const make = (sample as { constructor?: unknown } | undefined)?.constructor
  if (typeof make === "function" && make !== Object) {
    try {
      return new (make as new (value: typeof init) => unknown)(init)
    } catch {
      // Not constructible from this input: the plain shape below.
    }
  }
  return init
}

const open = (work: WorkSnapshot) => work.phase !== "closed" && work.phase !== "gone"

export interface CostHooks {
  readonly context: (input: RequestLike) => void
  readonly compaction: (input: RequestLike) => void
  readonly idle: (input: { readonly sessionID: string }) => Promise<void>
  readonly sessionGone: (sessionID: string, why: "deleted" | "archived") => void
}

/** Whether a request starts a turn: its tail is a `user` message, not a tool result or an assistant step. */
const startsTurn = (messages: readonly unknown[]) => (messages.at(-1) as { role?: unknown } | undefined)?.role === "user"

/** The hook callbacks, apart from their registration, so the unit tests drive them directly. */
export function costHooks(services: CostServices): CostHooks {
  const shared = sharedOf(services.cost)
  const internals = internalsOf(services.cost)
  const lines = new Map<string, string>()
  /** Sessions whose next request follows a compaction: it carries the open ids once. */
  const compacted = new Set<string>()
  const spoken = new Map<string, { readonly fingerprint: string; readonly at: number; readonly id: string }>()
  let owners: { readonly from: ReadonlyArray<WorkSnapshot>; readonly set: ReadonlySet<string> } | undefined

  /** The open works, and the sessions that own them; the set is rebuilt only when the watcher's snapshot changed. */
  function fleet() {
    const works = services.watch.snapshot().works
    if (owners?.from !== works) owners = { from: works, set: new Set(works.filter(open).flatMap((work) => (work.notify ? [work.notify] : []))) }
    return { works: works.filter(open), owners: owners.set }
  }

  const guard = (area: string, run: () => void) => {
    try {
      run()
    } catch (error) {
      services.report(area, `The ${area} hook failed: ${error instanceof Error ? error.message.split("\n")[0]!.slice(0, 160) : String(error)}`)
    }
  }

  return {
    context: (input) =>
      guard("hooks:context", () => {
        if (!services.options.costContext) return
        const { works, owners: set } = fleet()
        if (!set.has(input.sessionID)) return
        const line = fleetLine({ works, rates: internals.rates(), automation: services.cost.automation(), budget: internals.cachedBudget() })
        if (compacted.delete(input.sessionID)) {
          lines.set(input.sessionID, line.fingerprint)
          input.messages.push(userMessage(input.messages, `${line.text}\n${openWorks(works)}; boxd_status lists all.`))
          return
        }
        if (lines.get(input.sessionID) === line.fingerprint || !startsTurn(input.messages)) return
        lines.set(input.sessionID, line.fingerprint)
        input.messages.push(userMessage(input.messages, line.text))
      }),
    compaction: (input) =>
      guard("hooks:compaction", () => {
        if (!services.options.costContext) return
        const { works, owners: set } = fleet()
        if (!set.has(input.sessionID)) return
        input.messages.push(userMessage(input.messages, compactionText(works)))
        // After a compaction the line and the ids go in again on the next request.
        compacted.add(input.sessionID)
      }),
    async idle(input) {
      try {
        if (!services.options.idleCheck) return
        const { works, owners: set } = fleet()
        if (!set.has(input.sessionID)) return
        const now = services.clock.now()
        const burn = burning({ works, rates: internals.rates(), automation: services.cost.automation(), budget: internals.cachedBudget(), now, failed: new Set(shared.failed.keys()) })
        if (!burn) {
          // Nothing burns now: the same set burning again later is news, but the 30-minute gap still counts from the
          // last note, so burning, not burning and burning again cannot speak twice within it.
          const last = spoken.get(input.sessionID)
          if (last) spoken.set(input.sessionID, { ...last, fingerprint: "" })
          return
        }
        const last = spoken.get(input.sessionID)
        if (last && (last.fingerprint === burn.fingerprint || now.getTime() - last.at < IDLE_NOTE_GAP_MS)) return
        // Never in the execution its own note started: the newest input is that note, with nothing after it.
        const context = await services.sessions.context({ sessionID: input.sessionID })
        const newest = [...context].reverse().find((message) => message.type === "user" || message.type === "synthetic")
        if (newest?.type === "synthetic" && newest.metadata?.boxd === IDLE_TAG) return
        const id = `boxd-idle-${randomBytes(6).toString("hex")}`
        spoken.set(input.sessionID, { fingerprint: burn.fingerprint, at: now.getTime(), id })
        await services.sessions.synthetic({ sessionID: input.sessionID, text: burn.text, description: "boxd cost check", metadata: { boxd: IDLE_TAG, id } })
      } catch (error) {
        services.report("hooks:idle", `The idle check failed: ${error instanceof Error ? error.message.split("\n")[0]!.slice(0, 160) : String(error)}`)
      }
    },
    sessionGone(sessionID, why) {
      services.watch.sessionGone(sessionID, why)
      lines.delete(sessionID)
      compacted.delete(sessionID)
      spoken.delete(sessionID)
      shared.poke()
    },
  }
}

/**
 * Registers the three hooks and the session-events subscription. Never throws: a hook a host refuses is reported once
 * for status and the rest still register. Returns the disposers, newest last. Harvest and sleep go through
 * `services.actions` (C2's code), never through C2's modules.
 */
export async function registerCostHooks(ctx: HookContext, services: CostServices): Promise<Dispose[]> {
  const hooks = costHooks(services)
  const stops: Dispose[] = []
  const failed: string[] = []
  const callbacks = {
    context: (input: unknown) => hooks.context(input as RequestLike),
    compaction: (input: unknown) => hooks.compaction(input as RequestLike),
    "experimental.idle": (input: unknown) => hooks.idle(input as { sessionID: string }),
  } as const
  for (const name of COST_HOOKS) {
    try {
      const registration = await ctx.session.hook(name, callbacks[name] as never)
      stops.push(registration.dispose)
    } catch {
      failed.push(name)
    }
  }
  const events = new AbortController()
  const listening = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ types: [...SESSION_GONE_EVENTS], signal: events.signal })) {
        const { type, data } = event as { type?: unknown; data?: { sessionID?: unknown } }
        if (typeof data?.sessionID === "string") hooks.sessionGone(data.sessionID, type === "session.archived" ? "archived" : "deleted")
      }
    } catch {
      // A stream that ends with the plugin is not a problem; the watcher's sweep is the ground truth.
    }
  })()
  stops.push(async () => {
    events.abort()
    await listening
  })
  services.report("hooks", failed.length ? `The session hooks ${failed.join(", ")} could not be registered on this OpenCode, so the cost line, compaction note or idle check is off; automation still runs.` : undefined)
  return stops
}
