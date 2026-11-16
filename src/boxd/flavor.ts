/**
 * The CLI flavour check (F9): the boxd CLI that runs inside a boxd machine acts in its own machine's region only and
 * takes other arguments, so the plugin refuses it up front, from `boxd --help`, rather than failing command by command.
 * It runs once per binary, as one flight through the runner, and changes nothing.
 */
import { BoxdError, boxdError } from "../errors.js"
import type { PluginRunner } from "../exec/runner.js"
import type { OpContext } from "../ports.js"

/** `--help` reads no state, so a CLI that answers at all answers this fast. */
const HELP_MS = 10_000

/**
 * How the in-VM boxd CLI describes itself: its help says both that "boxd inside a machine" acts in its own machine's
 * region only and that `local` works "from inside the VM". Both phrases are required, so one phrase in the laptop
 * CLI's own wording never blocks every tool. A CLI that does not say both is taken to be the laptop's.
 */
const IN_VM = (text: string) => /boxd inside a machine/i.test(text) && /from inside the VM/i.test(text)

/** The binaries whose help has been read and found to be the laptop's, per runner. */
const checked = new WeakMap<PluginRunner, Set<string>>()

export async function assertLaptopCli(bin: string, runner: PluginRunner, context: OpContext): Promise<void> {
  const seen = checked.get(runner) ?? new Set<string>()
  checked.set(runner, seen)
  if (seen.has(bin)) return
  await runner.join(`boxd:flavor:${bin}`, context, async (flight) => {
    if (seen.has(bin)) return
    const help = await runner.spawn({ ...flight, bin, args: ["--help"], timeoutMs: HELP_MS }).catch((error: unknown) => {
      // A binary that cannot be run is BOXD_MISSING; a stopped call is the call's own answer. A CLI that hangs on
      // --help is left to its next command, which reports its own failure.
      if (error instanceof BoxdError && (error.code === "BOXD_MISSING" || error.code === "CANCELLED")) throw error
      return undefined
    })
    if (!help || help.code !== 0) return
    if (IN_VM(help.stdout)) {
      throw boxdError(
        "BOXD_MISSING",
        "The boxd CLI on the PATH is the one that runs inside a boxd machine. This plugin drives machines in every region from the laptop's boxd CLI, and the in-VM CLI is not supported.",
      )
    }
    seen.add(bin)
  })
}
