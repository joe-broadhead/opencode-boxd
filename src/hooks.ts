/**
 * The session hooks and events of cost and cleanup (design §C.3, §C.4). Package E owns this file.
 *
 * - **`experimental.idle`**: speaks only when money burns and automation will not act; one note at most per 30 minutes
 *   per session, tagged `metadata: { boxd: "idle-check", id }`, silent while its fingerprint is unchanged and when the
 *   session's newest input is its own note. Experimental in OpenCode: if it fails to register, status says so and the
 *   notices still carry every change.
 * - **Events** `session.deleted` and `session.archived`: passed to the watcher's `sessionGone`, the fast path that marks
 *   the works that session drove `orphaned`; then automation is woken. The watcher's `ctx.session.get` check stays the
 *   ground truth. OpenCode has no separate "session ended" event.
 *
 * There is no `context` or `compaction` hook: a per-request hook that adds text is outside the fixed-context budget
 * (standard §0.2 rule 4). Cost is read in `boxd_status`, and a change reaches the session as a synthetic notice.
 *
 * No hook makes a CLI call or a guest read: each reads the watcher's snapshot and the last usage read, in memory. Every
 * callback catches its own errors, so a hook never fails a request.
 */
import { randomBytes } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { internalsOf } from "./cost/index.js"
import { burning } from "./cost/lines.js"
import { sharedOf } from "./cost/shared.js"
import type { WorkSnapshot } from "./ports.js"
import type { CostServices, Dispose } from "./services.js"

/** The session hooks cost and cleanup registers. */
export const COST_HOOKS = ["experimental.idle"] as const
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

const open = (work: WorkSnapshot) => work.phase !== "closed" && work.phase !== "gone"

export interface CostHooks {
  readonly idle: (input: { readonly sessionID: string }) => Promise<void>
  readonly sessionGone: (sessionID: string, why: "deleted" | "archived") => void
}

/** The hook callbacks, apart from their registration, so the unit tests drive them directly. */
export function costHooks(services: CostServices): CostHooks {
  const shared = sharedOf(services.cost)
  const internals = internalsOf(services.cost)
  const spoken = new Map<string, { readonly fingerprint: string; readonly at: number; readonly id: string }>()
  let owners: { readonly from: ReadonlyArray<WorkSnapshot>; readonly set: ReadonlySet<string> } | undefined

  /** The open works, and the sessions that own them; the set is rebuilt only when the watcher's snapshot changed. */
  function fleet() {
    const works = services.watch.snapshot().works
    if (owners?.from !== works) owners = { from: works, set: new Set(works.filter(open).flatMap((work) => (work.notify ? [work.notify] : []))) }
    return { works: works.filter(open), owners: owners.set }
  }

  return {
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
      spoken.delete(sessionID)
      shared.poke()
    },
  }
}

/**
 * Registers the idle hook and the session-events subscription. Never throws: a hook a host refuses is reported once
 * for status and the rest still registers. Returns the disposers, newest last.
 */
export async function registerCostHooks(ctx: HookContext, services: CostServices): Promise<Dispose[]> {
  const hooks = costHooks(services)
  const stops: Dispose[] = []
  const failed: string[] = []
  const callbacks = {
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
  services.report("hooks", failed.length ? `The session hook ${failed.join(", ")} could not be registered on this OpenCode, so the idle check is off; the notices and automation still run.` : undefined)
  return stops
}
