/**
 * Package A's entry (design §4.1, §9.1): the one runner, the boxd CLI port on it, the guest port on that, and the
 * laptop port. Package A owns this file, `src/exec/*`, `src/boxd/*`, `src/guest/*` and `guest/guest.py`;
 * `src/plugin.ts` calls `createRuntime` once. Every child process the plugin starts goes through this runner, so its
 * caps hold across every tool call, the watcher and the automation at once. `dispose()`, which the plugin calls last
 * on disposal or reload, drops every queued child and kills every running one, a long `boxd_exec` included; the ports
 * hold no timer of their own.
 */
import type { HostServices, Runtime } from "../services.js"
import { createBoxdCli } from "../boxd/cli.js"
import { createGuestPort } from "../guest/port.js"
import { createLaptopPort } from "./laptop.js"
import { createRunner, type Launch, type PluginRunner } from "./runner.js"

/** What a test may swap: the process launcher and the helper to upload. */
export interface RuntimeSeam {
  readonly launch?: Launch
  readonly helperPath?: string
}

export interface PluginRuntime extends Runtime {
  readonly runner: PluginRunner
}

export function createRuntime(host: Pick<HostServices, "boxdBin" | "opencodeBin">, seam: RuntimeSeam = {}): PluginRuntime {
  const runner = createRunner(seam.launch ? { launch: seam.launch } : {})
  const boxd = createBoxdCli({ runner, bin: host.boxdBin })
  const guest = createGuestPort({ boxd, runner, ...(seam.helperPath ? { helperPath: seam.helperPath } : {}) })
  const laptop = createLaptopPort({ runner, bin: host.opencodeBin })
  return { runner, boxd, guest, laptop, dispose: () => runner.dispose() }
}
