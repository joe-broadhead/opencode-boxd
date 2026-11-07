import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { boxdError } from "./errors.js"
import { run } from "./run.js"

/** What the prover needs from a transfer: the id its transcript is filed under. */
type Transcript = { readonly info: { readonly id: string } }

/**
 * The laptop's own `opencode session import`, which keeps the transcript's id on every 2.2.x release: a second import
 * of the same transcript is a conflict, not a second session.
 */
export function cliProver(bin = "opencode") {
  return {
    async importTransfer(transfer: Transcript, directory: string): Promise<{ id: string }> {
      const dir = await mkdtemp(join(tmpdir(), "opencode-boxd-"))
      try {
        const file = join(dir, "export.json")
        await writeFile(file, JSON.stringify(transfer))
        // --standalone: the import writes the same store whatever else is running, and never waits on a service.
        const result = await run(bin, ["session", "import", file, "--directory", directory, "--standalone"], { timeoutMs: 120_000 })
        const text = `${result.stdout}\n${result.stderr}`
        // Stock 2.2.x prints this on stderr and exits 0, with no id in the message, because the id already exists.
        if (result.code === 0 && /Session already exists/i.test(text)) return { id: transfer.info.id }
        if (result.code !== 0) throw boxdError("NOT_PROVEN", `The laptop's import failed: ${firstLine(text)}.`)
        // Session ids are `ses_...`; a bare `/ses[a-z]+/` would also match the word "session" in the CLI's own message.
        const id = /ses_[A-Za-z0-9_-]+/.exec(text)?.[0]
        if (!id) throw boxdError("NOT_PROVEN", "The laptop's import printed no session id.")
        return { id }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}

/** The CLI's own words, one line, for the error's "what happened". */
function firstLine(text: string): string {
  const line = text.split("\n").map((item) => item.trim()).filter(Boolean)[0] ?? "no output"
  return line.slice(0, 200)
}
