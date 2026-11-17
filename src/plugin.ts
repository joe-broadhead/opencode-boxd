/**
 * The plugin's one wiring point: it builds every service once, in the order `src/services.ts` gives, from one entry
 * module per package, and registers the tools, rules, skill, status, hooks and commands. Packages fill their entry
 * modules; this file stays as it is.
 */
import { accessSync, constants } from "node:fs"
import { homedir } from "node:os"
import { delimiter, isAbsolute, join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { startAutomation } from "./automation.js"
import { cleanupView, registerCleanupCommand } from "./cleanup.js"
import { PLUGIN_ID } from "./constants.js"
import { createCost } from "./cost/index.js"
import { createRuntime } from "./exec/runtime.js"
import { machineRuns } from "./fleet/machines.js"
import { sessionRuns } from "./fleet/sessions.js"
import { viewRuns } from "./fleet/view.js"
import { registerCostHooks } from "./hooks.js"
import { checkHost } from "./host-version.js"
import { createImportV0 } from "./import-v0.js"
import { createLedger } from "./ledger/index.js"
import { parseOptions } from "./options.js"
import { defaultRules, registerDefaultRules } from "./permissions.js"
import { registerCleanupView, stopAll, type CoreServices, type CostServices, type Dispose, type FleetServices, type HostServices } from "./services.js"
import { loadSkills, registerSkills } from "./skills.js"
import { registerStatusCommand, registerStatusRpc, statusReader } from "./status.js"
import { ownedMethods, toolTransform, type RegistryDeps } from "./tools.js"
import { createWatch } from "./watch.js"
import { registerToolsRpc } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { localIdentity, sourceMethods } from "./sources.js"
import { PLUGIN } from "./tools-rpc.js"

/** Internal seam: the host tests point the plugin at a fake boxd CLI, their own ledger root and their own skills. */
interface BoxdSeam {
  readonly boxdBin?: string
  readonly opencodeBin?: string
  readonly ledger?: string
  readonly skillsDir?: string
}

/** A binary's absolute path on the server's PATH, found once at start; the bare name when PATH has none. */
function resolveBin(name: string): string {
  if (isAbsolute(name)) return name
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here; try the next folder.
    }
  }
  return name
}

/** Where the ledger lives, unless the seam says otherwise. */
const ledgerRoot = () => join(homedir(), ".local", "share", "opencode-boxd")

export function createBoxdPlugin(seam: BoxdSeam = {}) {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      const options = parseOptions(ctx.options)
      const host = checkHost(ctx.app.version, options.allowUntestedHost)
      const { skills, problems: skillProblems } = await loadSkills(seam.skillsDir)
      // Transforms replay on every rebuild, so each one overwrites its own entry rather than appending.
      const problems = new Map<string, string>(skillProblems.map((problem, index) => [`skill:${index}`, problem]))
      const report = (area: string, problem: string | undefined) => void (problem ? problems.set(area, problem) : problems.delete(area))

      // The services, in order: each stage sees only what the stages before it built (src/services.ts).
      const hostServices: HostServices = {
        options,
        hostVersion: host.version,
        projectDirectory: ctx.location.directory,
        ledgerRoot: seam.ledger ?? ledgerRoot(),
        boxdBin: seam.boxdBin ?? "boxd",
        opencodeBin: seam.opencodeBin ?? resolveBin("opencode"),
        clock: { now: () => new Date() },
        sessions: ctx.session,
        report,
      }
      const runtime = createRuntime(hostServices)
      const importV0 = createImportV0({ ...hostServices, ...runtime })
      const core: CoreServices = { ...hostServices, ...runtime, importV0, ledger: createLedger({ ...hostServices, ...runtime, importV0 }) }
      const watcher = createWatch(core)
      const fleet: FleetServices = { ...core, watch: watcher.watch, cost: createCost({ ...core, watch: watcher.watch }) }
      const sessions = sessionRuns(fleet)
      const registry: RegistryDeps = { runs: { ...viewRuns(fleet), ...machineRuns(fleet), ...sessions.runs }, selectors: sessions.selectors }
      const costServices: CostServices = { ...fleet, actions: sessions.actions }
      const read = statusReader(ctx, { services: fleet, host, problems: () => [...problems.values()] })

      // Every agent gets the block for the access option after its base allow: all allowed, ask on a change, or reads only.
      // Stops run in reverse: registrations and E's loops first, then the watcher, then the ledger and the import
      // (locks and heartbeats), and the runtime last (every in-flight child aborted).
      const stops: Dispose[] = [
        () => runtime.dispose(),
        () => importV0.dispose(),
        () => core.ledger.dispose(),
        await registerDefaultRules(ctx.agent, defaultRules(options.access), (problem) => report("rules", problem), options.access).then((registration) => registration.dispose),
        await registerSkills(ctx.skill, skills).then((registration) => registration.dispose),
        await registerStatusCommand(ctx, read).then((registration) => registration.dispose),
        await registerStatusRpc(ctx.rpc, read).then((registration) => registration.dispose),
        // Every tool as a method with its class: a script calls them with no model, and the rules decide what runs. The
        // boxd.works source's events_list and probe are methods only: they read the local ledger, never a machine.
        await registerToolsRpc(ctx as never, {
          plugin: PLUGIN,
          methods: [
            ...ownedMethods(registry, ctx.permission.assert),
            ...sourceMethods({ ledger: core.ledger, importV0, identity: localIdentity, now: () => hostServices.clock.now() }, ctx.permission.assert),
          ],
        }),
        await ctx.tool.transform(toolTransform(registry, ctx.permission.assert)).then((registration) => registration.dispose),
        watcher.dispose,
        // Cost and cleanup (design §C): the session hooks and events, the person's /boxd-cleanup, and automation.
        ...(await registerCostHooks(ctx, costServices)),
        await registerCleanupCommand(ctx, costServices).then((registration) => registration.dispose),
        // The view D's TUI renders for /boxd-cleanup, built by E.
        await registerCleanupView(ctx.rpc, cleanupView(costServices)).then((registration) => registration.dispose),
        startAutomation(costServices),
      ]
      return () => stopAll(stops.reverse(), (problem) => report("dispose", problem))
    },
  })
}
