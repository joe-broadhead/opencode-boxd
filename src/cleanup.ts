/**
 * `/boxd-cleanup` (design §C.5): the person's command. Package E owns this file and fills it; Day 0 registers the
 * command so its name and its place are settled, and it says it is not built yet.
 *
 * The contract E keeps:
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
 * - The report's matches come from `services.actions.match`, and a "yes" runs that one action in the plugin's process
 *   through `services.actions` (C2's code: drop's whole guard per work), against the ids that were in the prompt, never
 *   through the tools RPC. Its children are tagged `cleanup-command`.
 */
import type { Plugin } from "@opencode/plugin"
import { CLEANUP_COMMAND, type CleanupView, type CleanupViewProvider, type CostServices } from "./services.js"

export { CLEANUP_COMMAND }

type CleanupContext = {
  readonly command: Pick<Plugin.Context["command"], "transform">
  readonly session: Pick<Plugin.Context["session"], "synthetic">
  readonly permission: Pick<Plugin.Context["permission"], "assert">
}

export function registerCleanupCommand(ctx: CleanupContext, _services: CostServices) {
  return ctx.command.transform((editor) =>
    editor.add({
      name: CLEANUP_COMMAND,
      description: "Show what boxd machines cost now, and confirm each cleanup action",
      execute: async ({ sessionID }) => {
        await ctx.session.synthetic({ sessionID, text: "boxd cleanup: not built yet on this branch. Nothing was changed.", description: "boxd cleanup", resume: false })
      },
    }),
  )
}

/** The view `/boxd-cleanup`'s TUI renders (`CleanupViewRpc`). Package E fills it from `services.cost` and the watcher. */
export function cleanupView(services: CostServices): CleanupViewProvider {
  const confirm: CleanupView["confirm"] = services.options.access === "all" ? "cleanup-action" : services.options.access === "ask-changes" ? "tool-action" : "report-only"
  return {
    view: async () => ({
      state: "unavailable",
      currency: null,
      perHour: null,
      works: [],
      actions: [],
      automation: "off",
      confirm,
      command: `/${CLEANUP_COMMAND}`,
      note: "The cleanup view is not built yet on this branch.",
    }),
  }
}
