/**
 * The provider: the one runner every child process goes through, the boxd CLI port on it, the guest helper on that, and
 * this machine's own `opencode` binary for a harvest's session import.
 *
 * This file is the only place a binary is named (`boxd`, `opencode`); a test swaps them through `ProviderOptions`.
 * `dispose()`, which the plugin calls last, drops every queued child and kills every running one, a long `boxd_exec`
 * included; the ports hold no timer of their own.
 */
import { accessSync, constants } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"
import type { Provider } from "../services.js"
import { createBoxdCli } from "./boxd/cli.js"
import { createGuestPort } from "./guest/port.js"
import { createLaptopPort } from "./laptop.js"
import { createRunner, type Launch, type PluginRunner } from "./runner.js"

/** The boxd CLI on the server's PATH: the one provider endpoint string. */
export const BOXD_BIN = "boxd"
/** This machine's OpenCode binary, resolved from the server's PATH at start. */
export const OPENCODE_BIN = "opencode"

/** What a test may swap: the binaries, the process launcher and the helper to upload. */
export interface ProviderOptions {
  readonly boxdBin?: string
  readonly opencodeBin?: string
  readonly launch?: Launch
  readonly helperPath?: string
}

export interface PluginProvider extends Provider {
  readonly runner: PluginRunner
}

/** A binary's absolute path on the server's PATH, found once at start; the bare name when PATH has none. */
export function resolveBin(name: string): string {
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

export function createProvider(options: ProviderOptions = {}): PluginProvider {
  const runner = createRunner(options.launch ? { launch: options.launch } : {})
  const boxd = createBoxdCli({ runner, bin: options.boxdBin ?? BOXD_BIN })
  const guest = createGuestPort({ boxd, runner, ...(options.helperPath ? { helperPath: options.helperPath } : {}) })
  const laptop = createLaptopPort({ runner, bin: options.opencodeBin ?? resolveBin(OPENCODE_BIN) })
  return { runner, boxd, guest, laptop, dispose: () => runner.dispose() }
}
