import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { cliBoxd } from "./cli-boxd.js"
import { cliGuest } from "./cli-guest.js"
import { PLUGIN_ID } from "./constants.js"
import { createFleet } from "./fleet.js"
import { checkHost } from "./host-version.js"
import { Ledger } from "./ledger.js"
import { parseOptions } from "./options.js"
import { defaultRules, registerDefaultRules } from "./permissions.js"
import { cliProver } from "./prover.js"
import { loadSkills, registerSkills } from "./skills.js"
import { readStatus, registerStatusCommand, registerStatusRpc } from "./status.js"
import { ownedMethods, toolTransform, TOOLS } from "./tools.js"
import type { BoxdPort, GuestPort, Prover } from "./ports.js"
import { registerToolsRpc } from "./host/tools-rpc.js"

/** Internal seam: the host tests point the plugin at a fake CLI, a fake guest, a fake prover and their own ledger and skills. */
export interface BoxdSeam {
  readonly boxdBin?: string
  readonly boxd?: BoxdPort
  readonly guest?: GuestPort
  readonly prover?: Prover
  readonly ledger?: string
  readonly skillsDir?: string
}

/** Where the ledger lives, unless the seam says otherwise. */
export const ledgerRoot = () => join(homedir(), ".local", "share", "opencode-boxd")

export function createBoxdPlugin(seam: BoxdSeam = {}) {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      const options = parseOptions(ctx.options)
      const host = checkHost(ctx.app.version, options.allowUntestedHost)
      const bin = seam.boxdBin ?? "boxd"
      const fleet = createFleet({
        boxd: seam.boxd ?? cliBoxd(bin),
        guest: seam.guest ?? cliGuest(bin),
        prover: seam.prover ?? cliProver(),
        ledger: new Ledger(seam.ledger ?? ledgerRoot()),
        now: () => new Date().toISOString(),
        snapshot: options.snapshot,
        hostVersion: host.version,
      })
      const { skills, problems: skillProblems } = await loadSkills(seam.skillsDir)
      // Transforms replay on every rebuild, so each one overwrites its own entry rather than appending.
      const problems = new Map<string, string>(skillProblems.map((problem, index) => [`skill:${index}`, problem]))
      const report = (area: string) => (problem: string | undefined) => void (problem ? problems.set(area, problem) : problems.delete(area))
      const read = () =>
        readStatus(ctx, {
          host,
          snapshot: options.snapshot,
          guestVersion: host.version,
          problems: [...problems.values()],
          ledger: () => fleet.status(),
        })

      // Every agent gets the default rules after its base allow: the reads run and every machine change asks.
      const stops = [
        await registerDefaultRules(ctx.agent, defaultRules(), report("rules")).then((registration) => registration.dispose),
        await registerSkills(ctx.skill, skills).then((registration) => registration.dispose),
        await registerStatusCommand(ctx, read).then((registration) => registration.dispose),
        await registerStatusRpc(ctx.rpc, read).then((registration) => registration.dispose),
        // Every tool as a method with its class: a script calls them with no model, and the rules decide what runs.
        await registerToolsRpc(ctx, { methods: ownedMethods(fleet, ctx.permission.assert) }),
        await ctx.tool.transform(toolTransform(fleet, ctx.permission.assert)).then((registration) => registration.dispose),
      ]
      return async () => {
        for (const stop of stops.reverse()) await stop()
      }
    },
  })
}

/** The tool count the status row and the pack test read: one table, no second list. */
export const TOOL_COUNT = TOOLS.length
