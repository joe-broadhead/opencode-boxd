import { boxdError, BoxdError } from "./errors.js"
import { run } from "./run.js"

/** `--help` reads no state, so a CLI that answers at all answers this fast. */
const HELP_MS = 10_000
/**
 * How the in-VM boxd CLI describes itself: its top-level help says both that "boxd inside a machine" acts in its own
 * machine's region only and that `local` works "from inside the VM". Both phrases are required: the laptop CLI's help
 * has not been read, and one phrase alone could be its own wording, which would block every tool. A CLI that does not
 * say both is taken to be the laptop's.
 */
const IN_VM = (text: string) => /boxd inside a machine/i.test(text) && /from inside the VM/i.test(text)

/** The binaries whose flavour has been read and found to be the laptop's. */
const checked = new Set<string>()

/**
 * Refuses the boxd CLI that runs inside a boxd machine. It takes `--vm <name>` where the laptop CLI takes the machine
 * as an argument, so the plugin's commands would fail on it one by one, and the awake bound would end as
 * `AWAKE_UNBOUND`. The check reads `boxd --help` and changes nothing. A CLI that cannot answer it is not refused
 * here: the command that follows reports its own failure. Only a clear answer is remembered.
 */
export async function assertLaptopCli(bin: string): Promise<void> {
  if (checked.has(bin)) return
  const help = await run(bin, ["--help"], { timeoutMs: HELP_MS }).catch((error: unknown) => {
    // A binary that cannot be run is BOXD_MISSING already; a CLI that hangs on --help is left to its next command.
    if (error instanceof BoxdError && error.code === "BOXD_MISSING") throw error
    return undefined
  })
  if (!help || help.code !== 0) return
  if (IN_VM(help.stdout)) {
    throw boxdError(
      "BOXD_MISSING",
      "The boxd CLI on the PATH is the one that runs inside a boxd machine. This plugin drives remote machines from the laptop's boxd CLI, and the in-VM CLI is not supported.",
    )
  }
  checked.add(bin)
}
