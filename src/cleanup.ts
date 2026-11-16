/**
 * `/boxd-cleanup` (design §C.5): the person's command. Package E owns this file.
 *
 * - It posts a report with `ctx.session.synthetic` (`resume: false`): counts, costs, ids and phases only, nothing the
 *   model could use to approve anything.
 * - Then, for each cleanup action (sleep `finished`, harvest `unsaved-finished`, drop `saved-finished`), it confirms with
 *   `ctx.permission.assert` **without a `source`**, so the host's own permission prompt asks the person, and the prompt
 *   is never a session message. At `access: "ask-changes"` it asserts the tool's own action, whose default rule asks; at
 *   `"all"` it asserts `CLEANUP_ACTION` (`boxd_cleanup`), which the default rules set to ask; at `"read-only"` it only
 *   reports and asserts nothing. The resources are exactly the work ids the action will touch.
 * - **A declined prompt is caught per action** (review note N-2): `assert` rejects with an error that would end the
 *   current step, so each action's assert is caught on its own, logged as "declined", and the command moves on to the
 *   next action. A "no" or a deny changes nothing, and the session stays usable.
 * - The matches come from `services.actions.match`, and a "yes" runs that one action in the plugin's process through
 *   `services.actions` (C2's code: drop's whole guard per work), against the ids that were in the prompt, never through
 *   the tools RPC. Its children are tagged `cleanup-command`.
 */
import type { Plugin } from "@opencode/plugin"
import { COMMAND_STEM } from "./constants.js"
import { internalsOf } from "./cost/index.js"
import { figures, shown, sign, workPerHour } from "./cost/fleet.js"
import { isRunning } from "./cost/rates.js"
import { CLEANUP_ACTION } from "./permissions.js"
import type { WorkSnapshot } from "./ports.js"
import type { ListResult } from "./results.js"
import type { ActionContext, CostServices, SelectorValues } from "./services.js"

export const CLEANUP_COMMAND = `${COMMAND_STEM}-cleanup`
/** The report lists at most this many running works, costliest first. */
export const REPORT_MAX_WORKS = 30

type CleanupContext = {
  readonly command: Pick<Plugin.Context["command"], "transform">
  readonly session: Pick<Plugin.Context["session"], "synthetic">
  readonly permission: Pick<Plugin.Context["permission"], "assert">
}

type Step = {
  readonly [K in keyof SelectorValues]: { readonly tool: K; readonly select: SelectorValues[K]; readonly verb: string; readonly run: "sleep" | "harvest" | "drop" }
}[keyof SelectorValues]

/** The actions the command offers, in order: sleep what is finished, save what is unsaved, drop what is saved. */
export const CLEANUP_STEPS: readonly Step[] = [
  { tool: "boxd_sleep", select: "finished", verb: "Sleep finished works", run: "sleep" },
  { tool: "boxd_harvest", select: "unsaved-finished", verb: "Harvest unsaved finished works", run: "harvest" },
  { tool: "boxd_drop", select: "saved-finished", verb: "Drop saved finished works", run: "drop" },
]

const minutesSince = (at: string | undefined, now: Date) => (at ? Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 60_000)) : null)

/** The report: what costs money now and the suggested actions. Plugin fields only. */
export async function cleanupReport(services: CostServices, call: ActionContext["call"]): Promise<string> {
  const rates = internalsOf(services.cost).rates()
  const works = services.watch.snapshot().works.filter((work) => work.phase !== "closed" && work.phase !== "gone")
  const fleet = figures(works, rates)
  const now = services.clock.now()
  const running = works
    .filter((work) => isRunning(work.phase))
    .map((work) => ({ work, hour: workPerHour(work, rates) }))
    .sort((a, b) => b.hour - a.hour || a.work.workId.localeCompare(b.work.workId))
  const line = ({ work, hour }: { work: WorkSnapshot; hour: number }) => {
    const idle = minutesSince(work.idleSince, now)
    return `- ${work.workId}: ${work.phase}${work.needsInput ? " (waits on a person)" : ""}, ~${sign(rates.currency)}${hour.toFixed(4)}/h${idle !== null && work.phase !== "busy" ? `, idle ${idle} min` : ""}, saved ${work.saved}`
  }
  const lines = [
    `boxd cleanup: ${fleet.running} running, ${fleet.asleep} asleep; ~${shown(rates.currency, fleet.perHour)}/h (an estimate, ${rates.source} rates).`,
  ]
  try {
    const today = (await services.cost.block({ works: false, limit: 0 }, call)).today
    lines.push(today.machines === null ? `Machine cost today: not available (${today.unavailable ?? "boxd's usage is for owners and admins"}).` : `Machine cost today: ${shown(rates.currency, today.machines)}${today.complete ? "" : " (incomplete; boxd lags up to 25 minutes)"}.`)
  } catch {
    lines.push("Machine cost today: not available.")
  }
  if (running.length) {
    lines.push("Running works, costliest first:", ...running.slice(0, REPORT_MAX_WORKS).map(line))
    if (running.length > REPORT_MAX_WORKS) lines.push(`- and ${running.length - REPORT_MAX_WORKS} more`)
  }
  const actions = await services.cost.cleanup(call)
  if (actions.length) {
    lines.push("Suggested:")
    for (const action of actions) {
      const saving = action.savesPerHour !== undefined ? `, saves ~${shown(rates.currency, action.savesPerHour)}/h` : action.savesPerDay !== undefined ? `, saves ~${shown(rates.currency, action.savesPerDay)}/day` : ""
      lines.push(`- ${action.action} ${action.select}: ${action.works} ${action.works === 1 ? "work" : "works"}${saving}`)
    }
  } else lines.push("Nothing to clean up.")
  if (services.options.access === "read-only") lines.push("access is read-only, so this command only reports.")
  else if (actions.length) lines.push("Each action asks you in OpenCode's permission prompt; a no skips only that action.")
  return lines.join("\n")
}

const counted = (result: ListResult<{ state: string }>) =>
  Object.entries(result.counts)
    .map(([state, count]) => `${count} ${state}`)
    .join(", ")

/** One run of the command: the report, then each action behind its own permission prompt. */
export async function runCleanup(ctx: Omit<CleanupContext, "command">, services: CostServices, sessionID: string, callId: string): Promise<{ readonly report: string; readonly outcomes: readonly string[] }> {
  const call = { callId, source: "cleanup-command" } as const
  const context: ActionContext = { by: "cleanup-command", call }
  const report = await cleanupReport(services, call)
  await ctx.session.synthetic({ sessionID, text: report, description: "boxd cleanup", resume: false })
  const outcomes: string[] = []
  if (services.options.access === "read-only") return { report, outcomes }
  for (const step of CLEANUP_STEPS) {
    let ids: readonly string[]
    try {
      ids = await (services.actions.match as (tool: string, select: string, context: ActionContext) => Promise<readonly string[]>)(step.tool, step.select, context)
    } catch (error) {
      outcomes.push(`${step.verb}: could not match (${error instanceof Error ? error.message.split("\n")[0]!.slice(0, 160) : String(error)}).`)
      continue
    }
    if (!ids.length) {
      outcomes.push(`${step.verb}: nothing to do.`)
      continue
    }
    const rates = internalsOf(services.cost).rates()
    const matched = services.watch.snapshot().works.filter((work) => ids.includes(work.workId))
    const saving = Math.round(matched.reduce((sum, work) => sum + workPerHour(work, rates) - (step.run === "sleep" ? workPerHour({ ...work, phase: "asleep" }, rates) : 0), 0) * 10_000) / 10_000
    try {
      await ctx.permission.assert({
        sessionID,
        action: services.options.access === "ask-changes" ? step.tool : CLEANUP_ACTION,
        resources: [...ids],
        metadata: { command: CLEANUP_COMMAND, tool: step.tool, select: step.select, works: ids.length, savesPerHour: saving, currency: rates.currency },
      })
    } catch {
      // A "no", a deny rule, or a prompt that could not be shown: this action changes nothing, the next one is asked.
      outcomes.push(`${step.verb}: declined; nothing changed.`)
      continue
    }
    try {
      const result = await services.actions[step.run](ids, context)
      outcomes.push(`${step.verb}: ${counted(result as ListResult<{ state: string }>)}.`)
    } catch (error) {
      outcomes.push(`${step.verb}: failed (${error instanceof Error ? error.message.split("\n")[0]!.slice(0, 160) : String(error)}).`)
    }
  }
  if (outcomes.length) await ctx.session.synthetic({ sessionID, text: `boxd cleanup, done:\n${outcomes.map((outcome) => `- ${outcome}`).join("\n")}`, description: "boxd cleanup", resume: false })
  return { report, outcomes }
}

export function registerCleanupCommand(ctx: CleanupContext, services: CostServices) {
  let runs = 0
  return ctx.command.transform((editor) =>
    editor.add({
      name: CLEANUP_COMMAND,
      description: "Show what boxd machines cost now, and confirm each cleanup action",
      execute: async ({ sessionID }) => {
        await runCleanup(ctx, services, sessionID, `cleanup-${++runs}`)
      },
    }),
  )
}
