// Import crash safety (design §6.1, H1, §7.1): a child process runs the import and is killed with SIGKILL at each step
// (after N records for several N, and around the publish). The next start discards what the dead run left, imports
// again, and publishes the same ledger an uninterrupted run publishes; the v0 tree is never changed.
import { afterAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { LedgerGate } from "../../src/import-v0.js"
import { contentOf, fakeImportBoxd, publishedContent, readTree, removeRoot, v0Root } from "../support/ledger-fakes.js"

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) removeRoot(root)
})
const fixtureRoot = () => {
  const root = v0Root("boxd-crash-")
  roots.push(root)
  return root
}

/** Runs the import in a child that kills itself at `step` (the Nth record for `record`); resolves with its signal. */
const crashAt = (root: string, step: string, count = 0) =>
  new Promise<string | null>((resolve) => {
    const proc = spawn("bun", [join(import.meta.dir, "..", "support", "ledger-child.ts"), "import", root, step, String(count)], { stdio: ["ignore", "pipe", "pipe"] })
    proc.on("close", (_code, signal) => resolve(signal))
  })

const v0Content = (root: string) => contentOf(readTree(join(root, "works"), (path) => path.startsWith("README-MOVED-TO-v1")))

describe("the import survives a kill at every step", () => {
  const reference = fixtureRoot()
  const points: Array<[string, number]> = [
    ["locked", 0],
    ["staging", 0],
    ["listed", 0],
    ["ids", 0],
    ["record", 1],
    ["record", 4],
    ["record", 8],
    ["record", 11],
    ["report", 0],
    ["marker", 0],
    ["publish", 0],
    ["published", 0],
    ["note", 0],
  ]

  test("the uninterrupted run", async () => {
    expect((await new LedgerGate({ root: reference, boxd: fakeImportBoxd() }).start()).state).toBe("ready")
  })

  for (const [step, count] of points) {
    test(`killed at ${step}${count ? ` after ${count} records` : ""}: the next start publishes the same ledger`, async () => {
      const root = fixtureRoot()
      const v0Before = v0Content(root)
      expect(await crashAt(root, step, count)).toBe("SIGKILL")
      // Before the publish nothing is published, so every tool still answers LEDGER_IMPORTING.
      const published = existsSync(join(root, "v1"))
      expect(published).toBe(["published", "note"].includes(step))
      if (!published) expect(existsSync(join(root, "v1", "complete"))).toBe(false)

      const boxd = fakeImportBoxd()
      const gate = new LedgerGate({ root, boxd })
      expect(await gate.start()).toMatchObject({ state: "ready", works: 9, errors: 2 })
      // The dead run's lock was its pid's on this host, so it is taken over at once, and its staging folder is gone.
      expect(readdirSync(root).filter((name) => name.startsWith("v1.importing-") || name.startsWith("import.lock"))).toEqual([])
      expect(publishedContent(root)).toEqual(publishedContent(reference))
      expect(v0Content(root)).toEqual(v0Before)
      expect(existsSync(join(root, "works", "README-MOVED-TO-v1", "README.md"))).toBe(true)
      // One listing either way: the import's own, or, after a run that died once it had published, the try of the two
      // blocked ids that every later start makes.
      expect(boxd.lists).toBe(1)
    }, 30_000)
  }
})
