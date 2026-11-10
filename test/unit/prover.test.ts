// The prover against real stock OpenCode binaries: `session import` keeps the transcript's id on every 2.2.x release, so
// a second import of the same transcript is "Session already exists" (exit 0, no id) and the prover answers with the
// transcript's own id instead of failing. This is the laptop-side fix, and the evidence for the host decision.
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { arch, platform } from "node:os"
import { join } from "node:path"
import { TESTED_HOSTS } from "../../src/constants.js"
import { cliProver } from "../../src/prover.js"

/**
 * A stock binary: the one named by OPENCODE_BIN_<version>, or else the npm release installed under OPENCODE_STOCK_ROOT,
 * in a folder per version. With neither set, the describe blocks that need a stock binary are skipped.
 */
const binary = (version: string): string | undefined => {
  const given = process.env[`OPENCODE_BIN_${version.replaceAll(".", "_")}`]
  if (given) return given
  const root = process.env.OPENCODE_STOCK_ROOT
  if (!root) return undefined
  const installed = join(root, version, "node_modules", `@opencode/cli-${platform()}-${arch()}`, "bin", "opencode")
  return existsSync(installed) ? installed : undefined
}

/** A transcript in OpenCode's own export shape; messages may be empty, which the importer accepts. */
const transcript = (id: string, directory: string) => ({
  info: {
    id,
    projectID: "proj_prover_test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
    title: "prover test",
    location: { directory },
  },
  messages: [],
})

for (const version of TESTED_HOSTS) {
  const run = binary(version)
  describe.skipIf(run === undefined)(`the prover on stock OpenCode ${version}`, () => {
    test("imports a transcript, keeps its id, and a second import proves the same id", async () => {
      const root = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "boxd-prover-")))
      const home = join(root, "home")
      const work = join(root, "work")
      mkdirSync(home, { recursive: true })
      mkdirSync(work, { recursive: true })
      const previous = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }
      // The CLI resolves every global path from HOME, so each import is isolated from the owner's own OpenCode.
      process.env.HOME = home
      process.env.TMPDIR = join(root, "tmp")
      mkdirSync(process.env.TMPDIR, { recursive: true })
      try {
        const id = `ses_prover${version.replaceAll(".", "")}`
        const prover = cliProver(run!)
        expect(await prover.importTransfer(transcript(id, work), work)).toEqual({ id })
        // The second import is a conflict, not a new session: the prover must report the same id, not NOT_PROVEN.
        expect(await prover.importTransfer(transcript(id, work), work)).toEqual({ id })
        writeFileSync(join(root, "marker"), "proven")
      } finally {
        if (previous.HOME === undefined) delete process.env.HOME
        else process.env.HOME = previous.HOME
        if (previous.TMPDIR === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = previous.TMPDIR
        rmSync(root, { recursive: true, force: true })
      }
    }, 300_000)
  })
}
