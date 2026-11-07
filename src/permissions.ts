import type { Plugin } from "@opencode/plugin"
import { errorText } from "./constants.js"
import { boxdError } from "./errors.js"
import { CHANGING_TOOLS, READ_TOOLS, TOOLS } from "./tools.js"
import { reasonOf } from "./redact.js"

export interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "ask" | "deny"
}

const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect })

/**
 * Broad first, narrow last, because the last matching rule wins: every `boxd_*` action asks, including a tool this
 * plugin adds later, then the reads run, then each changing tool asks by its exact name so a prompt names the work.
 */
export const defaultRules = (): Rule[] => [
  rule("boxd_*", "ask"),
  ...READ_TOOLS.map((tool) => rule(tool, "allow")),
  ...CHANGING_TOOLS.map((tool) => rule(tool, "ask")),
]

const same = (a: Rule, b: Rule) => a.action === b.action && a.resource === b.resource && a.effect === b.effect
const BASE_ALLOW: Rule = { action: "*", resource: "*", effect: "allow" }

/**
 * True when the default rules appear as one contiguous block anywhere after the agent's first base allow, inserted by
 * the plugin or pasted by the user. Other plugins insert their blocks at the same place, so the block need not come
 * first. False without a base allow.
 */
export function hasDefaultRules(permissions: readonly Rule[]) {
  const base = permissions.findIndex((item) => same(item, BASE_ALLOW))
  if (base === -1) return false
  const rules = defaultRules()
  return permissions.some((_, start) => start > base && rules.every((item, offset) => permissions[start + offset] !== undefined && same(permissions[start + offset]!, item)))
}

/**
 * Splices `rules` in right after the agent's base `* * allow`, by index. Everything later still wins: the agent's own
 * stricter rules (Plan, Explore), the user's `permissions`, and saved approvals. Agents without a base allow, or that
 * already carry the rules, are left alone: there the block's ask would loosen a default deny. Returns whether it
 * inserted.
 */
export function insertRules(permissions: Rule[], rules: readonly Rule[]) {
  if (hasDefaultRules(permissions)) return false
  const base = permissions.findIndex((item) => same(item, BASE_ALLOW))
  if (base === -1) return false
  permissions.splice(base + 1, 0, ...rules.map((item) => ({ ...item })))
  return true
}

/** Registers the default rules for every agent. Synchronous and never throws; a failure is kept for status. */
export function registerDefaultRules(
  agent: Pick<Plugin.Context["agent"], "transform">,
  rules: readonly Rule[],
  report: (problem: string | undefined) => void,
) {
  return agent.transform((editor) => {
    try {
      for (const { id } of editor.list()) editor.update(id, (info) => void insertRules(info.permissions, rules))
      report(undefined)
    } catch (error) {
      report(errorText("RULES_NOT_ADDED", `boxd's default permission rules could not be added (${reasonOf(error)}), so a machine change may run without asking.`, "Restart OpenCode."))
    }
  })
}

const wildcard = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`)

/** The host's evaluation for one of these actions (resource `*`): the last matching rule wins, and no match asks. */
export function evaluate(permissions: readonly Rule[], action: string): Rule["effect"] {
  return permissions.findLast((item) => wildcard(item.action).test(action) && wildcard(item.resource).test("*"))?.effect ?? "ask"
}

/**
 * Agents where a new boxd tool would run without asking: a base allow, no default rules after it, and nothing else in
 * the agent's own rules that asks or denies for it. An agent whose rules already stop every boxd tool needs no fix, and
 * one without a base allow gets no rules.
 */
export const unguardedAgents = (agents: readonly { readonly id: string; readonly permissions: readonly Rule[] }[]) =>
  agents
    .filter((agent) => agent.permissions.some((item) => same(item, BASE_ALLOW)) && !hasDefaultRules(agent.permissions) && evaluate(agent.permissions, "boxd_new_tool") === "allow")
    .map((agent) => agent.id)

/** The tool lists status derives its Access row from, so the sentence cannot go stale. */
export const POSTURE = {
  reads: READ_TOOLS,
  changing: TOOLS.filter((tool) => tool.class !== "read").map((tool) => `${tool.id} (${tool.class})`),
} as const

/** A tool spec's own error, raised while the table is built, so a bad table fails at startup rather than at a call. */
export function assertClassification(): void {
  for (const tool of TOOLS) {
    if (tool.id !== `boxd_${tool.name}`) throw boxdError("OPTIONS_INVALID", `Tool ${tool.name} is not named boxd_${tool.name}.`)
  }
}
