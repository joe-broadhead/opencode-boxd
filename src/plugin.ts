import { Plugin } from "@opencode/plugin"
import { registerCleanupCommand } from "./cleanup.js"
import { PLUGIN_ID } from "./constants.js"
import { registerCostHooks } from "./hooks.js"
import { checkHost } from "./host-version.js"
import { parseOptions } from "./options.js"
import { defaultRules, registerDefaultRules } from "./permissions.js"
import { loadSkills, registerSkills } from "./skills.js"
import { readStatus, registerStatusCommand, registerStatusRpc } from "./status.js"
import { ownedMethods, toolTransform, type ToolDeps } from "./tools.js"
import { registerToolsRpc } from "./host/tools-rpc.js"

/**
 * Internal seam: the host tests point the plugin at a fake boxd CLI, their own ledger root and their own skills. The
 * runtime (package A) wires `boxdBin` into the runner and the CLI port, and the ledger (package B) its root.
 */
interface BoxdSeam {
  readonly boxdBin?: string
  readonly ledger?: string
  readonly skillsDir?: string
}

export function createBoxdPlugin(seam: BoxdSeam = {}) {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      const options = parseOptions(ctx.options)
      const host = checkHost(ctx.app.version, options.allowUntestedHost)
      const { skills, problems: skillProblems } = await loadSkills(seam.skillsDir)
      // Transforms replay on every rebuild, so each one overwrites its own entry rather than appending.
      const problems = new Map<string, string>(skillProblems.map((problem, index) => [`skill:${index}`, problem]))
      const report = (area: string) => (problem: string | undefined) => void (problem ? problems.set(area, problem) : problems.delete(area))
      const deps: ToolDeps = { options, hostVersion: host.version, projectDirectory: ctx.location.directory }
      const read = () =>
        readStatus(ctx, {
          access: options.access,
          host,
          // The image a new work in the default size boots from: <prefix>-<this laptop's OpenCode>-<size>.
          snapshot: `${options.goldenPrefix}-${host.version ?? "unknown"}-${options.size}`,
          guestVersion: host.version,
          problems: [...problems.values()],
          // The v1 ledger (package B) and the fleet view (package D) are not built on this branch yet.
          ledger: () => Promise.reject(new Error("The v1 ledger is not built yet on this branch.")),
        })

      // Every agent gets the block for the access option after its base allow: all allowed, ask on a change, or reads only.
      const stops = [
        await registerDefaultRules(ctx.agent, defaultRules(options.access), report("rules"), options.access).then((registration) => registration.dispose),
        await registerSkills(ctx.skill, skills).then((registration) => registration.dispose),
        await registerStatusCommand(ctx, read).then((registration) => registration.dispose),
        await registerStatusRpc(ctx.rpc, read).then((registration) => registration.dispose),
        // Every tool as a method with its class: a script calls them with no model, and the rules decide what runs.
        await registerToolsRpc(ctx, { methods: ownedMethods(deps, ctx.permission.assert) }),
        await ctx.tool.transform(toolTransform(deps, ctx.permission.assert)).then((registration) => registration.dispose),
        // Cost and cleanup (design §C): the session hooks and events, and the person's /boxd-cleanup.
        ...(await registerCostHooks(ctx, deps, report("hooks"))),
        await registerCleanupCommand(ctx, deps).then((registration) => registration.dispose),
      ]
      return async () => {
        for (const stop of stops.reverse()) await stop()
      }
    },
  })
}
