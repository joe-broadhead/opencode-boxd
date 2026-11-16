/**
 * The laptop's own OpenCode, which a harvest imports into (design §3.6 step 4, F1). On every tested release
 * `opencode session import` of an id that already exists exits 0 with "Session already exists" and changes nothing, so
 * a second harvest would leave the first transcript in place. The prover therefore replaces: `session delete <id>`
 * first (which also removes the session's children), then `session import`, parents first, and checks the import named
 * the transcript's own id.
 *
 * The prover reads the ledger's stored export and never writes it, so a failed import leaves the last good export in
 * place for the next harvest to retry. Every process goes through the runner's import pool (cap 2).
 */
import { boxdError } from "./errors.js"
import { TIMEOUTS, type LaptopPort, type OpContext, type SpawnRequest, type SpawnResult } from "./ports.js"
import { shortReason } from "./redact.js"

export type Spawn = (request: SpawnRequest) => Promise<SpawnResult>

/** A transcript to put on the laptop: the stored export and the session id it holds. */
export interface StoredTranscript {
  readonly id: string
  readonly file: string
}

export interface Prover extends LaptopPort {
  /**
   * Replaces each session with its stored export, in the order given (parents first): delete, then import, then check.
   * Stops at the first failure with `IMPORT_FAILED`; the stored files are never changed.
   */
  replace(transcripts: readonly StoredTranscript[], directory: string, context: OpContext): Promise<readonly string[]>
}

const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,80}$/
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
/** The words every tested release prints for `session delete` of an id it does not have, with exit 1. */
const NOT_FOUND = /Session not found/i
/** The words every tested release prints, with exit 0, for an import of an id it already has. */
const EXISTS = /Session already exists/i

const text = (result: SpawnResult) => `${result.stdout}\n${result.stderr}`.replace(ANSI, "")
const reason = (result: SpawnResult) => shortReason(text(result)) ?? `exit ${result.code}`

export function laptopProver(spawn: Spawn, bin = "opencode"): Prover {
  const run = (args: readonly string[], context: OpContext) =>
    spawn({ ...context, pool: "import", bin, args, timeoutMs: TIMEOUTS.laptopImport })

  const deleteSession: Prover["deleteSession"] = async (id, context) => {
    if (!SESSION_ID.test(id)) throw boxdError("NAME_INVALID", `Session id "${id}" is not an OpenCode session id.`)
    // --standalone: the CLI writes the same store whatever else runs, and never waits on a background service.
    const result = await run(["session", "delete", id, "--standalone"], context)
    if (result.code === 0) return "deleted"
    if (result.code === 1 && NOT_FOUND.test(text(result))) return "absent"
    throw boxdError("IMPORT_FAILED", `This laptop's opencode session delete ${id} failed (${reason(result)}).`)
  }

  const importSession: Prover["importSession"] = async (file, directory, context) => {
    const result = await run(["session", "import", file, "--directory", directory, "--standalone"], context)
    const output = text(result)
    if (result.code !== 0) throw boxdError("IMPORT_FAILED", `This laptop's opencode session import failed (${reason(result)}).`)
    // After a delete this means the old copy is still there: the replace did not happen (F1).
    if (EXISTS.test(output)) throw boxdError("IMPORT_FAILED", "This laptop's OpenCode still held the session after the delete, so the import changed nothing.")
    const id = /Imported session:\s*(ses_[A-Za-z0-9_-]+)/.exec(output)?.[1]
    if (!id) throw boxdError("IMPORT_FAILED", "This laptop's opencode session import printed no session id.")
    return { id }
  }

  return {
    deleteSession,
    importSession,
    async replace(transcripts, directory, context) {
      const ids: string[] = []
      for (const transcript of transcripts) {
        await deleteSession(transcript.id, context)
        const { id } = await importSession(transcript.file, directory, context)
        if (id !== transcript.id) throw boxdError("IMPORT_FAILED", `This laptop's import filed ${transcript.id} as ${id}, not under its own id.`)
        ids.push(id)
      }
      return ids
    },
  }
}
