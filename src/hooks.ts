/**
 * The session hooks and events of cost and cleanup (design §C.3, §C.4). Package E owns this file and fills each
 * callback; Day 0 registers every hook with an empty callback, so the registration is proven on every tested host
 * before any behaviour lands, and a hook that fails to register is a status problem, never a failed plugin.
 *
 * Each callback's contract, which E keeps:
 *
 * - **`context`**: one fleet line, only for a session that owns works (`session.notify` of an open work), only on the
 *   first request after the coarse fleet fingerprint changes, at most 240 characters, plugin fields only (no guest
 *   text). `system` is never touched: it stays byte-identical, so the provider's prompt cache holds. The line is
 *   inserted as a **new** trailing `user` message holding only the line; an existing message, and its part array, is
 *   never changed (review note N-1). The edit applies to this request only and is never stored.
 * - **`compaction`**: for an owner session, one new trailing `user` message asking the summary to keep the open works
 *   (at most 30 ids with their phase); `system` untouched; the fingerprint is reset afterwards.
 * - **`experimental.idle`**: speaks only when money burns and automation will not act; one note at most per 30 minutes
 *   per session, tagged `metadata: { boxd: "idle-check", id }`, silent while its fingerprint is unchanged and when the
 *   session's newest input is its own note. Experimental in OpenCode: if it fails to register, status says so and
 *   layers 1 and 2 still hold.
 * - **Events** `session.deleted` and `session.archived`: a fast path to orphan the works that session drove. The
 *   watcher's `ctx.session.get` check stays the ground truth. OpenCode has no separate "session ended" event.
 */
import type { Plugin } from "@opencode/plugin"
import type { CostServices, Dispose } from "./services.js"

/** The session hooks cost and cleanup registers. */
export const COST_HOOKS = ["context", "compaction", "experimental.idle"] as const
/** The session events that orphan a coordinator's works. */
export const SESSION_GONE_EVENTS = ["session.deleted", "session.archived"] as const

type HookContext = {
  readonly session: Pick<Plugin.Context["session"], "hook">
  readonly event: Pick<Plugin.Context["event"], "subscribe">
}

/**
 * Registers the three hooks and the session-events subscription. Never throws: a hook a host refuses is reported once
 * for status and the rest still register. Returns the disposers, newest last. Harvest and sleep go through
 * `services.actions` (C2's code), never through C2's modules.
 */
export async function registerCostHooks(ctx: HookContext, services: CostServices): Promise<Dispose[]> {
  const stops: Dispose[] = []
  const failed: string[] = []
  for (const name of COST_HOOKS) {
    try {
      const registration = await ctx.session.hook(name, () => {})
      stops.push(registration.dispose)
    } catch {
      failed.push(name)
    }
  }
  const events = new AbortController()
  const listening = (async () => {
    try {
      for await (const _event of ctx.event.subscribe({ types: [...SESSION_GONE_EVENTS], signal: events.signal })) {
        // Package E: orphan the works whose session.notify this session is.
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
