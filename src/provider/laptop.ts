/**
 * The laptop port (design §3.6 step 4, F1): this laptop's own `opencode session delete` and `session import`, in the
 * runner's import pool (cap 2), with the `opencode` binary the plugin resolved once (`HostServices.opencodeBin`). It is
 * the one place the plugin drives the laptop's OpenCode; a harvest replaces sessions through it (`src/prover.ts`).
 *
 * On the tested release (2.4.1) a second `session import` of an id that already exists exits 0 with
 * "Session already exists" and changes nothing, so an import that prints those words fails: the replace did not happen.
 * `delete` of an id the laptop does not have exits 1 with "Session not found: <id>", which is "absent".
 *
 * `--standalone` makes each command write the store directly, whatever else is running, and never wait on a service.
 */
import { BoxdError, boxdError } from "../errors.js"
import { TIMEOUTS, type LaptopPort, type OpContext, type Runner, type SpawnResult } from "../ports.js"
import { shortReason } from "../redact.js"

export interface LaptopPortOptions {
  readonly runner: Pick<Runner, "spawn">
  /** The laptop's `opencode`: `HostServices.opencodeBin`, resolved once when the plugin starts. */
  readonly bin: string
}

const SESSION = /^ses_[A-Za-z0-9_-]{1,80}$/
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g")
/** What `opencode session delete` prints, with exit 1, for an id this laptop does not have. */
const NOT_FOUND = /^(?:Error: )?Session not found: (ses_[A-Za-z0-9_-]+)\s*$/m
/** What `session import` prints, with exit 0, when the id is already there: nothing was replaced. */
const ALREADY = /Session already exists/i
/** What `session import` prints for the session it filed. */
const IMPORTED = /Imported session:\s*(ses_[A-Za-z0-9_-]{1,80})\b/

const text = (result: SpawnResult) => `${result.stdout}\n${result.stderr}`.replace(ANSI, "")
const said = (result: SpawnResult) => shortReason(text(result).split("\n").find((line) => line.trim() !== "") ?? "") ?? `exit ${result.code}`

export function createLaptopPort(options: LaptopPortOptions): LaptopPort {
  const { runner, bin } = options

  async function run(args: readonly string[], context: OpContext) {
    try {
      return await runner.spawn({ ...context, pool: "import", bin, args, timeoutMs: TIMEOUTS.laptopImport })
    } catch (error) {
      if (error instanceof BoxdError && error.code === "BOXD_MISSING") throw boxdError("IMPORT_FAILED", `The OpenCode here could not be run (${error.what}).`)
      throw error
    }
  }

  return {
    async deleteSession(id, context) {
      if (!SESSION.test(id)) throw boxdError("NAME_INVALID", `"${id}" is not an OpenCode session id.`)
      const result = await run(["session", "delete", id, "--standalone"], context)
      if (result.code === 0) return "deleted"
      if (result.code === 1 && NOT_FOUND.exec(text(result))?.[1] === id) return "absent"
      throw boxdError("IMPORT_FAILED", `The OpenCode here could not delete session ${id} (${said(result)}).`)
    },

    async importSession(file, directory, context) {
      const result = await run(["session", "import", file, "--directory", directory, "--standalone"], context)
      const output = text(result)
      if (result.code !== 0) throw boxdError("IMPORT_FAILED", `The OpenCode here could not import the session (${said(result)}).`)
      if (ALREADY.test(output)) throw boxdError("IMPORT_FAILED", "The OpenCode here still held the session, so the import changed nothing; delete it first, or harvest again.")
      const id = IMPORTED.exec(output)?.[1]
      if (!id) throw boxdError("IMPORT_FAILED", "The OpenCode here printed no session id for the import.")
      return { id }
    },
  }
}
