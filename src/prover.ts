/**
 * The replace a harvest makes on the laptop's own OpenCode (design §3.6 step 4, F1), through the laptop port
 * (`src/exec/laptop.ts`): an import of an id that already exists changes nothing, so each session is deleted first
 * (which also removes its children), then imported, parents first, and the import must name the transcript's own id.
 *
 * It reads the ledger's stored export and never writes it, so a failed import leaves the last good export in place for
 * the next harvest to retry.
 */
import { boxdError } from "./errors.js"
import type { LaptopPort, OpContext } from "./ports.js"

/** A transcript to put on the laptop: the stored export and the session id it holds. */
export interface StoredTranscript {
  readonly id: string
  readonly file: string
}

/**
 * Replaces each session with its stored export, in the order given (parents first): delete, then import, then check.
 * Stops at the first failure with `IMPORT_FAILED`; the stored files are never changed.
 */
export async function replaceOnLaptop(laptop: LaptopPort, transcripts: readonly StoredTranscript[], directory: string, context: OpContext): Promise<readonly string[]> {
  const ids: string[] = []
  for (const transcript of transcripts) {
    await laptop.deleteSession(transcript.id, context)
    const { id } = await laptop.importSession(transcript.file, directory, context)
    if (id !== transcript.id) throw boxdError("IMPORT_FAILED", `The import here filed ${transcript.id} as ${id}, not under its own id.`)
    ids.push(id)
  }
  return ids
}
