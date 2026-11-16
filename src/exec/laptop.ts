/**
 * The laptop port (design §3.6 step 4, F1): this laptop's own `opencode session delete` and `session import`, in the
 * runner's import pool (cap 2). A harvest deletes a session and then imports its new export, so the laptop's copy is
 * replaced rather than kept: a second import of an existing id changes nothing on every tested release.
 *
 * `--standalone` makes each command write the store directly, whatever else is running, and never wait on a service.
 */
import { BoxdError, boxdError } from "../errors.js"
import { TIMEOUTS, type LaptopPort, type Runner } from "../ports.js"
import { shortReason } from "../redact.js"

export interface LaptopPortOptions {
  readonly runner: Runner
  /** The laptop's `opencode`; the one on the server's PATH by default. */
  readonly bin?: string
}

const SESSION = /^ses_[A-Za-z0-9_-]{1,80}$/
/** What `opencode session delete` prints, with exit 1, for an id this laptop does not have (2.2.3 to 2.3.0). */
const NOT_FOUND = /^(?:Error: )?Session not found: (ses_[A-Za-z0-9_-]+)\s*$/m
/** What `session import` prints when the id is already there: a delete that did not happen, so nothing was replaced. */
const ALREADY = /Session already exists/i

export function createLaptopPort(options: LaptopPortOptions): LaptopPort {
  const bin = options.bin ?? "opencode"
  const { runner } = options

  async function run(args: readonly string[], context: Parameters<LaptopPort["deleteSession"]>[1]) {
    try {
      return await runner.spawn({ ...context, pool: "import", bin, args, timeoutMs: TIMEOUTS.laptopImport })
    } catch (error) {
      if (error instanceof BoxdError && error.code === "BOXD_MISSING") throw boxdError("IMPORT_FAILED", `This laptop's opencode could not be run (${error.what}).`)
      throw error
    }
  }

  const said = (stdout: string, stderr: string) => shortReason(`${stderr}\n${stdout}`.split("\n").find((line) => line.trim() !== "") ?? "") ?? "no output"

  return {
    async deleteSession(id, context) {
      if (!SESSION.test(id)) throw boxdError("NAME_INVALID", `"${id}" is not an OpenCode session id.`)
      const result = await run(["session", "delete", id, "--standalone"], context)
      if (result.code === 0) return "deleted"
      const absent = NOT_FOUND.exec(`${result.stderr}\n${result.stdout}`)
      if (result.code === 1 && absent?.[1] === id) return "absent"
      throw boxdError("IMPORT_FAILED", `This laptop's opencode session delete ${id} failed (${said(result.stdout, result.stderr)}).`)
    },

    async importSession(file, directory, context) {
      const result = await run(["session", "import", file, "--directory", directory, "--standalone"], context)
      const text = `${result.stdout}\n${result.stderr}`
      if (result.code !== 0) throw boxdError("IMPORT_FAILED", `This laptop's opencode session import failed (${said(result.stdout, result.stderr)}).`)
      if (ALREADY.test(text)) throw boxdError("IMPORT_FAILED", "This laptop already had the session, so its copy was not replaced; delete it first.")
      // Session ids are `ses_…`; a bare /ses[a-z]+/ would also match the word "session" in the CLI's own message.
      const id = /\bses_[A-Za-z0-9_-]{1,80}\b/.exec(text)?.[0]
      if (!id) throw boxdError("IMPORT_FAILED", "This laptop's opencode session import printed no session id.")
      return { id }
    },
  }
}
