// The prover against real stock OpenCode binaries (design §3.6 step 4, F1, §7.2). On every tested release a second
// `session import` of an id that exists exits 0 with "Session already exists" and changes nothing, so the prover deletes
// first: the second harvest's transcript must replace the first on the laptop. `delete` of an absent id exits 1 with
// "Session not found", which is read as absent. The stored export is only read, so a failed import leaves it as it was.
import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { arch, platform } from "node:os"
import { join } from "node:path"
import { TESTED_HOSTS } from "../../src/constants.js"
import { laptopProver } from "../../src/prover.js"
import type { OpContext } from "../../src/ports.js"
import { directSpawn, removeRoot, tempRoot } from "../support/ledger-fakes.js"
import { stockGate } from "../support/stock-gate.js"

/**
 * A stock binary: the one named by OPENCODE_BIN_<version>, or else the npm release installed under OPENCODE_STOCK_ROOT,
 * in a folder per version. With neither set, the describe blocks that need a stock binary are skipped (CI fails).
 */
const binary = (version: string): string | undefined => {
  const given = process.env[`OPENCODE_BIN_${version.replaceAll(".", "_")}`]
  if (given) return given
  const root = process.env.OPENCODE_STOCK_ROOT
  if (!root) return undefined
  const installed = join(root, version, "node_modules", `@opencode/cli-${platform()}-${arch()}`, "bin", "opencode")
  return existsSync(installed) ? installed : undefined
}

const context: OpContext = { call: { callId: "prover-test", source: "boxd_harvest" } }

/** A transcript in the shape `opencode session export` writes on 2.2 and 2.3: flat messages with `id` and `type`. */
const transcript = (id: string, directory: string, title: string, messages: number, parentID?: string) => ({
  info: {
    id,
    projectID: "proj_prover_test",
    ...(parentID ? { parentID } : {}),
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 + messages },
    title,
    location: { directory },
  },
  messages: Array.from({ length: messages }, (_, index) => ({ id: `msg_${id.slice(4)}${index}`, type: "user", sessionID: id, time: { created: 1_700_000_000_000 + index }, text: `message ${index}` })),
})

/** Runs `fn` with HOME and TMPDIR in a fresh folder, so the CLI's store is isolated from the owner's own OpenCode. */
async function isolated<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = tempRoot("boxd-prover-")
  const previous = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }
  mkdirSync(join(root, "home"))
  mkdirSync(join(root, "tmp"))
  mkdirSync(join(root, "work"))
  process.env.HOME = join(root, "home")
  process.env.TMPDIR = join(root, "tmp")
  try {
    return await fn(root)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    removeRoot(root)
  }
}

for (const version of TESTED_HOSTS) {
  const bin = binary(version)
  const gate = stockGate(version, bin ?? `OPENCODE_BIN_${version.replaceAll(".", "_")}`, bin !== undefined)
  describe.skipIf(gate === "skip")(`the prover on stock OpenCode ${version}`, () => {
    test("a second harvest replaces the laptop's copy (F1), parents first, and an absent id reads as absent", async () => {
      await isolated(async (root) => {
        const work = join(root, "work")
        const prover = laptopProver(directSpawn, bin!)
        const read = async (id: string) => {
          const result = await directSpawn({ ...context, bin: bin!, args: ["session", "export", id, "--standalone"], timeoutMs: 120_000 })
          expect(result.code).toBe(0)
          const body = JSON.parse(result.stdout) as { info: { title: string }; messages: unknown[] }
          return { title: body.info.title, messages: body.messages.length }
        }
        const store = (name: string, body: unknown) => {
          const file = join(root, name)
          writeFileSync(file, JSON.stringify(body))
          return file
        }
        const root1 = `ses_root${version.replaceAll(".", "")}`
        const child1 = `ses_child${version.replaceAll(".", "")}`
        expect(await prover.deleteSession(root1, context)).toBe("absent")

        // The first harvest.
        const first = [
          { id: root1, file: store("root-1.json", transcript(root1, work, "first title", 1)) },
          { id: child1, file: store("child-1.json", transcript(child1, work, "first child", 1, root1)) },
        ]
        expect(await prover.replace(first, work, context)).toEqual([root1, child1])
        expect(await read(root1)).toEqual({ title: "first title", messages: 1 })

        // The stock behaviour the prover guards against: an import over an existing id changes nothing.
        await expect(prover.importSession(store("root-plain.json", transcript(root1, work, "plain import", 3)), work, context)).rejects.toThrow(/IMPORT_FAILED: .*still held the session/)
        expect(await read(root1)).toEqual({ title: "first title", messages: 1 })

        // The second harvest replaces both sessions.
        const second = [
          { id: root1, file: store("root-2.json", transcript(root1, work, "second title", 3)) },
          { id: child1, file: store("child-2.json", transcript(child1, work, "second child", 2, root1)) },
        ]
        const stored = second.map((item) => readFileSync(item.file))
        expect(await prover.replace(second, work, context)).toEqual([root1, child1])
        expect(await read(root1)).toEqual({ title: "second title", messages: 3 })
        expect(await read(child1)).toEqual({ title: "second child", messages: 2 })
        // The prover only reads the stored exports.
        expect(second.map((item) => readFileSync(item.file))).toEqual(stored)
        expect(await prover.deleteSession(root1, context)).toBe("deleted")
        // Deleting the root removed its child too.
        expect(await prover.deleteSession(child1, context)).toBe("absent")
      })
    }, 300_000)

    test("a failed import answers IMPORT_FAILED and leaves the stored export byte for byte", async () => {
      await isolated(async (root) => {
        const prover = laptopProver(directSpawn, bin!)
        const file = join(root, "broken.json")
        writeFileSync(file, '{"info": {"id": "ses_broken"}')
        const before = readFileSync(file)
        await expect(prover.replace([{ id: "ses_broken", file }], join(root, "work"), context)).rejects.toThrow(/^IMPORT_FAILED/)
        expect(readFileSync(file)).toEqual(before)
      })
    }, 300_000)
  })
}

describe("the prover's reading of the CLI's words", () => {
  /** A fake `opencode` that answers as the stock releases do, from a script of its own. */
  const fake = (root: string, body: string) => {
    const path = join(root, "opencode")
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }

  test("delete: 0 is deleted, 1 with not-found words is absent, anything else is IMPORT_FAILED", async () => {
    const root = tempRoot("boxd-prover-fake-")
    try {
      expect(await laptopProver(directSpawn, fake(root, 'echo "Session ses_a deleted"')).deleteSession("ses_a", context)).toBe("deleted")
      expect(await laptopProver(directSpawn, fake(root, 'echo "\\033[31mSession not found: ses_a\\033[0m" >&2; exit 1')).deleteSession("ses_a", context)).toBe("absent")
      await expect(laptopProver(directSpawn, fake(root, 'echo "database is locked" >&2; exit 1')).deleteSession("ses_a", context)).rejects.toThrow(/^IMPORT_FAILED: .*database is locked/)
      await expect(laptopProver(directSpawn, fake(root, "exit 0")).deleteSession("not-a-session", context)).rejects.toThrow(/^NAME_INVALID/)
    } finally {
      removeRoot(root)
    }
  })

  test("import: the printed id is checked against the transcript's own", async () => {
    const root = tempRoot("boxd-prover-fake-")
    try {
      const prover = laptopProver(directSpawn, fake(root, 'case "$2" in delete) exit 0;; import) echo "Imported session: ses_other";; esac'))
      await expect(prover.replace([{ id: "ses_mine", file: "x.json" }], root, context)).rejects.toThrow(/IMPORT_FAILED: .*filed ses_mine as ses_other/)
      const silent = laptopProver(directSpawn, fake(root, 'case "$2" in delete) exit 0;; import) echo "done";; esac'))
      await expect(silent.replace([{ id: "ses_mine", file: "x.json" }], root, context)).rejects.toThrow(/IMPORT_FAILED: .*printed no session id/)
      const calls = join(root, "calls")
      const logged = laptopProver(directSpawn, fake(root, `echo "$*" >> ${calls}; case "$2" in delete) echo "Session not found: $3" >&2; exit 1;; import) echo "Imported session: ses_mine";; esac`))
      expect(await logged.replace([{ id: "ses_mine", file: "x.json" }], "/work/projects/api", context)).toEqual(["ses_mine"])
      expect(readFileSync(calls, "utf8")).toBe("session delete ses_mine --standalone\nsession import x.json --directory /work/projects/api --standalone\n")
    } finally {
      removeRoot(root)
    }
  })
})
