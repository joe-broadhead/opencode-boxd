import type { Plugin } from "@opencode/plugin"
import { CHANGING_TOOLS, READ_TOOLS } from "./tools.js"
import { reasonOf } from "./redact.js"

export interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "ask" | "deny"
}

/** How much the plugin's own tools may do without asking. A user's later rules always win. */
export type Access = "all" | "ask-changes" | "read-only"

export const ACCESS_VALUES: readonly Access[] = ["all", "ask-changes", "read-only"]

const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect })

/** The effect a changing tool gets under one access value. A read always allows. */
const changingEffect = (access: Access): Rule["effect"] => (access === "all" ? "allow" : access === "ask-changes" ? "ask" : "deny")

/**
 * The block the plugin inserts after each agent's base allow, generated from the tool table and the `access`
 * option. Every tool this plugin registers is allowed by default. The namespace pattern's effect follows the value,
 * so a tool a later release adds runs at once under `all`, asks under `ask-changes` and is denied under `read-only`;
 * the known reads are allowed after it. The order is a safety net, not a decision point: the last matching rule wins,
 * and the exact-name rule comes after the pattern.
 */
export const defaultRules = (access: Access = "all"): Rule[] => {
  const changing = changingEffect(access)
  return [
    rule("boxd_*", changing),
    ...READ_TOOLS.map((tool) => rule(tool, "allow")),
    ...CHANGING_TOOLS.map((tool) => rule(tool, changing)),
  ]
}

const same = (a: Rule, b: Rule) => a.action === b.action && a.resource === b.resource && a.effect === b.effect
const BASE_ALLOW: Rule = { action: "*", resource: "*", effect: "allow" }

/**
 * True when a block for this access value appears as one contiguous run anywhere after the agent's first base
 * allow, inserted by the plugin or pasted by the user. Other plugins insert their blocks at the same place, so the
 * block need not come first. False without a base allow.
 */
export function hasDefaultRules(permissions: readonly Rule[], access: Access = "all") {
  const base = permissions.findIndex((item) => same(item, BASE_ALLOW))
  if (base === -1) return false
  const rules = defaultRules(access)
  return permissions.some((_, start) => start > base && rules.every((item, offset) => permissions[start + offset] !== undefined && same(permissions[start + offset]!, item)))
}

/**
 * Splices `rules` in right after the agent's base `* * allow`, by index. Everything later still wins: the agent's own
 * stricter rules (Plan, Explore), the user's `permissions`, and saved approvals. Agents without a base allow, or that
 * already carry the block for this access value, are left alone. Returns whether it inserted.
 */
export function insertRules(permissions: Rule[], rules: readonly Rule[], access: Access = "all") {
  if (hasDefaultRules(permissions, access)) return false
  const base = permissions.findIndex((item) => same(item, BASE_ALLOW))
  if (base === -1) return false
  // A block for another access value is replaced, so switching the option does not stack two blocks.
  for (const value of ACCESS_VALUES) {
    if (value === access) continue
    const stale = defaultRules(value)
    for (let start = 0; start + stale.length <= permissions.length; start += 1) {
      if (stale.every((item, offset) => same(permissions[start + offset]!, item))) {
        permissions.splice(start, stale.length)
        return insertRules(permissions, rules, access)
      }
    }
  }
  permissions.splice(base + 1, 0, ...rules.map((item) => ({ ...item })))
  return true
}

/** Registers the default rules for every agent. Synchronous in the transform and never throws; a failure is kept for status. */
export function registerDefaultRules(
  agent: Pick<Plugin.Context["agent"], "transform">,
  rules: readonly Rule[],
  report: (problem: string | undefined) => void,
  access: Access = "all",
) {
  return agent.transform((editor) => {
    try {
      for (const { id } of editor.list()) editor.update(id, (info) => void insertRules(info.permissions, rules, access))
      report(undefined)
    } catch (error) {
      report(`RULES_NOT_ADDED: boxd's default permission rules could not be added (${reasonOf(error)}), so a tool may run without asking. Next step: Restart OpenCode.`)
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
 * Agents with a base allow where this plugin's block is missing and a tool the plugin adds later would run without
 * asking. With the default `all`, the plugin's own block is what grants that, so the row names the agents to paste it
 * into.
 */
export const unguardedAgents = (agents: readonly { readonly id: string; readonly permissions: readonly Rule[] }[], access: Access = "all") =>
  agents
    .filter((agent) => agent.permissions.some((item) => same(item, BASE_ALLOW)) && !hasDefaultRules(agent.permissions, access) && evaluate(agent.permissions, "boxd_new_tool") === "allow")
    .map((agent) => agent.id)
