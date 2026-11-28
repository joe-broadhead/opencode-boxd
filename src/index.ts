/**
 * The plugin's one setup: `Plugin.define` → `assertHost` → `contract.register`.
 *
 * Everything a caller can reach is one method in the manifest, written once in `src/handlers/` and wired through the
 * contract's doors (agent tool, Code Mode, RPC). The plugin holds no account or credential: the boxd CLI's sign-in is
 * external, and probe/status report the local machine identity. The provider client lives in `src/provider/`.
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { rulesFor } from "@we-the-rebel-alliance/plugin-contract/access"
import { assertHost, register } from "@we-the-rebel-alliance/plugin-contract/register"
import { machineIdentity } from "./accounts.js"
import { startAutomation } from "./automation.js"
import { PLUGIN_ID } from "./constants.js"
import { createCost, internalsOf } from "./cost/index.js"
import { PUBLIC_RATES } from "./cost/rates.js"
import { fleetStatus } from "./fleet/status.js"
import { createHandlers } from "./handlers/index.js"
import { createRuns } from "./handlers/runs.js"
import { CHANGED_CAPABILITY } from "./handlers/run.js"
import type { SourceDeps } from "./handlers/events.js"
import type { StatusDeps } from "./handlers/status.js"
import { checkHost } from "./host-version.js"
import { createLedger } from "./ledger/index.js"
import { manifest, VERSION } from "./manifest.js"
import { parseOptions } from "./options.js"
import { createProvider, type ProviderOptions } from "./provider/index.js"
import { stopAll, type CoreServices, type CostServices, type Dispose, type FleetServices, type HostServices } from "./services.js"
import { readSkills, registerSkills } from "./skills.js"
import { readReport, registerStatusCommand } from "./status.js"
import { createWatch } from "./watch.js"

/** Internal seam: the host tests point the plugin at a fake boxd CLI, their own ledger root and their own skills. */
export interface BoxdSeam extends ProviderOptions {
  readonly ledger?: string
  readonly skillsDir?: string
}

/** Where the ledger lives, unless the seam says otherwise. */
const ledgerRoot = () => join(homedir(), ".local", "share", "boxd-plugin")

/** How many methods are not reads, for the report's access sentence. */
const CHANGES = Object.values(manifest.methods).filter((method) => method.class !== "read").length

export function createBoxdPlugin(seam: BoxdSeam = {}) {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      const options = parseOptions(ctx.options)
      assertHost(ctx, manifest)
      const host = checkHost(ctx.app.version, options.allowUntestedHost)
      let skills: ReturnType<typeof readSkills> = []
      let skillProblem: string | undefined
      try {
        skills = readSkills(seam.skillsDir)
      } catch (error) {
        skillProblem = error instanceof Error ? error.message : String(error)
      }
      // Transforms replay on every rebuild, so each one overwrites its own entry rather than appending.
      const problems = new Map<string, string>(skillProblem === undefined ? [] : [["skill", skillProblem]])
      const report = (area: string, problem: string | undefined) => { problem ? problems.set(area, problem) : problems.delete(area) }

      // The services, in order: each stage sees only what the stages before it built (src/services.ts).
      const hostServices: HostServices = {
        options,
        hostVersion: host.version,
        projectDirectory: ctx.location.directory,
        ledgerRoot: seam.ledger ?? ledgerRoot(),
        clock: { now: () => new Date() },
        sessions: ctx.session,
        report,
      }
      const provider = createProvider({ boxdBin: seam.boxdBin, opencodeBin: seam.opencodeBin, helperPath: seam.helperPath })
      // Every phase change prices its interval at the rates current then: the cost service answers once it is built.
      let currentRates = () => PUBLIC_RATES.EUR
      const core: CoreServices = { ...hostServices, ...provider, ledger: createLedger({ ...hostServices, ...provider, rates: () => currentRates() }) }
      // The watcher starts before the one registration exists, so its nudge is wired to the bus just after it.
      let nudge: (() => Promise<void>) | undefined
      const watcher = createWatch(core, { changed: () => nudge?.() })
      const costService = createCost({ ...core, watch: watcher.watch })
      currentRates = internalsOf(costService).rates
      const fleet: FleetServices = { ...core, watch: watcher.watch, cost: costService }
      const source: SourceDeps = { ledger: core.ledger, identity: machineIdentity, now: () => hostServices.clock.now() }
      const { runs, selectors, actions } = createRuns(fleet)
      const cost: CostServices = { ...fleet, actions }

      let reads = 0
      const fleetRead = () =>
        fleetStatus(fleet, { view: "attention", limit: 10, include: [], order: "activity" }, { tag: { callId: `status-${++reads}`, source: "status-command" }, guestReads: false })
      const worksRead = () =>
        fleetStatus(fleet, { view: "all", limit: 300, include: [], order: "activity" }, { tag: { callId: `list-${++reads}`, source: "status-command" }, guestReads: false })
      const status: StatusDeps = {
        hostVersion: host.version ?? ctx.app.version,
        problems: () => [...problems.values()],
        fleet: fleetRead,
        works: worksRead,
      }

      const stops: Dispose[] = [
        () => provider.dispose(),
        () => core.ledger.dispose(),
        await registerSkills(ctx, skills).then((registration) => registration.dispose),
        watcher.dispose,
      ]
      const registration = await register(ctx, manifest, createHandlers({ runs, selectors, source, status }))
      // A tick or sweep that appends or tails a work event tells every subscriber that the works source changed.
      nudge = async () => {
        await registration.bus.emit("changed", { capability: CHANGED_CAPABILITY, account: "default", reason: "phase" })
      }
      stops.push(registration.dispose)
      stops.push(
        ...(await registerStatusCommand(ctx, () =>
          readReport({
            version: VERSION,
            hostVersion: host.version,
            access: options.access,
            options,
            problems: () => [...problems.values()],
            fleet: fleetRead,
            rules: rulesFor(manifest, options.access),
            agents: async () => (await ctx.agent.list()).data,
            changes: CHANGES,
          }),
        ).then((value) => [value.dispose])),
      )
      stops.push(startAutomation(cost))
      return () => stopAll([...stops].reverse(), (problem) => report("dispose", problem))
    },
  })
}

export default createBoxdPlugin()
