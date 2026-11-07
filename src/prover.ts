import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BoxdError } from "./errors.js"
import type { Prover } from "./ports.js"
import type { Transfer } from "./transfer.js"
import { run } from "./run.js"

/** Proves an export by importing it into the laptop OpenCode. Does not run on the guest. */
export function cliProver(bin = "opencode"): Prover {
  return {
    async importTransfer(transfer: Transfer, directory: string) {
      const dir = await mkdtemp(join(tmpdir(), "opencode-boxd-"))
      const file = join(dir, "export.json")
      await writeFile(file, JSON.stringify(transfer))
      const result = await run(bin, ["session", "import", file, "--directory", directory], { timeoutMs: 30_000 })
      const text = `${result.stdout}\n${result.stderr}`
      const existing = /Session already exists: (ses[A-Za-z0-9_-]+)/.exec(text)
      if (result.code !== 0 && existing) return { id: existing[1]! }
      if (result.code !== 0) {
        throw new BoxdError("NOT_PROVEN", "The laptop refused the import.", text.slice(0, 400))
      }
      const id = /ses[A-Za-z0-9_-]+/.exec(text)?.[0]
      if (!id) {
        throw new BoxdError(
          "NOT_PROVEN",
          "Import exited 0 but did not print a session id.",
          "The export is on disk. Do not destroy the machine until a session id is recorded.",
        )
      }
      return { id }
    },
  }
}
