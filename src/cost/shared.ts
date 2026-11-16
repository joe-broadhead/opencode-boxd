/**
 * What cost, automation and the hooks share inside one plugin instance (design §C.3, §C.4): whether this process is the
 * automation owner, and the works whose automatic harvest or sleep failed. (A coordinator that was deleted or archived
 * is the watcher's `WorkSnapshot.orphaned`.) Kept beside the `CostPort` it belongs to, so the contract in `src/services.ts` stays as it is. Package E
 * owns this file.
 */
import type { Options } from "../options.js"
import type { AutomationState } from "../results.js"

export interface CostShared {
  /** `unknown` until the automation loop first tried `automation.lock`. */
  owner: "unknown" | "owner" | "not-owner"
  /** Works whose automatic harvest or sleep failed, with the step and its code, for status and the idle check. */
  readonly failed: Map<string, { readonly step: "harvest" | "sleep" | "read"; readonly code: string; readonly at: number }>
  /** Wakes the automation loop early, after an event; set by the loop, a no-op before it starts. */
  poke: () => void
}

const registry = new WeakMap<object, CostShared>()

/** The shared state of the instance `key` (the `CostPort`) belongs to; made on first use. */
export function sharedOf(key: object): CostShared {
  let shared = registry.get(key)
  if (!shared) {
    shared = { owner: "unknown", failed: new Map(), poke: () => {} }
    registry.set(key, shared)
  }
  return shared
}

/**
 * Whether automation may act here (§C.3, round 4 M-2): on by default only at `access: "all"`; at the other levels only
 * with the person's `automation: "on"`, which is their consent; never with `"off"`.
 */
export function consent(options: Pick<Options, "access" | "automation">): "on" | "on (consent)" | "off" | "off (access)" {
  if (options.automation === "off") return "off"
  if (options.automation === "on") return options.access === "all" ? "on" : "on (consent)"
  return options.access === "all" ? "on" : "off (access)"
}

export const allowed = (options: Pick<Options, "access" | "automation">) => consent(options).startsWith("on")

/** The `automation` value status shows: the consent, or `not-owner` when another OpenCode process holds the lock. */
export function automationState(options: Pick<Options, "access" | "automation">, shared: Pick<CostShared, "owner">): AutomationState {
  const state = consent(options)
  return state.startsWith("on") && shared.owner === "not-owner" ? "not-owner" : state
}
