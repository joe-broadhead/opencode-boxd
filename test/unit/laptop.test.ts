// The laptop port (F1): this laptop's own `opencode session delete` then `session import`, in the import pool. A
// delete of an id the laptop does not have exits 1 with "Session not found: <id>" (measured on 2.2.6), which is
// "absent"; any other failure is IMPORT_FAILED; an import that finds the id already there replaced nothing, so it fails.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { BoxdError } from "../../src/errors.js"
import { createLaptopPort } from "../../src/exec/laptop.js"
import { createRunner } from "../../src/exec/runner.js"
import { CAPS, type LaptopPort, type OpContext } from "../../src/ports.js"
import { startFakeCli, type FakeCli } from "../host/fake-cli.js"
import { peakOf } from "../host/spawn-counter.js"
import { verbOf } from "../support/spawn-count.js"

let fake: FakeCli
let runner: ReturnType<typeof createRunner>
let laptop: LaptopPort
const context: OpContext = { call: { callId: "call_harvest", source: "boxd_harvest" } }
const fail = <T>(promise: Promise<T>) => promise.then(() => undefined, (error: unknown) => error as BoxdError)

beforeEach(() => {
  fake = startFakeCli()
  runner = createRunner()
  laptop = createLaptopPort({ runner, bin: fake.opencodeBin })
})
afterEach(async () => {
  await runner.dispose()
  fake.dispose()
})

const exportFile = (id: string, parentID?: string) => {
  const file = join(fake.dir, `${id}.json`)
  writeFileSync(file, JSON.stringify({ info: { id, ...(parentID ? { parentID } : {}), title: id }, messages: [{ id: "msg_0" }] }))
  return file
}

describe("the laptop port", () => {
  test("delete then import replaces the laptop's copy; an absent id deletes as absent", async () => {
    const file = exportFile("ses_root")
    expect(await laptop.deleteSession("ses_root", context)).toBe("absent")
    expect(await laptop.importSession(file, "/project", context)).toEqual({ id: "ses_root" })
    expect(await laptop.deleteSession("ses_root", context)).toBe("deleted")
    expect(await laptop.importSession(file, "/project", context)).toEqual({ id: "ses_root" })
    expect(fake.spawns().map((spawn) => verbOf(spawn.bin, spawn.argv))).toEqual(["opencode session delete", "opencode session import", "opencode session delete", "opencode session import"])
    expect(fake.spawns()[1]!.argv).toEqual(["session", "import", file, "--directory", "/project", "--standalone"])
  })

  test("an import that finds the id already there replaced nothing, so it fails", async () => {
    const file = exportFile("ses_twice")
    await laptop.importSession(file, "/project", context)
    const error = await fail(laptop.importSession(file, "/project", context))
    expect([error?.code, error?.what]).toEqual(["IMPORT_FAILED", "This laptop's OpenCode still held the session, so the import changed nothing; delete it first, or harvest again."])
  })

  test("a delete that fails for another reason is IMPORT_FAILED, never absent", async () => {
    const failing = createLaptopPort({ runner, bin: join(fake.dir, "guest-bin", "opencode") })
    // The guest's fake opencode answers `session delete` with nothing and exit 0; a broken binary here exits 126.
    writeFileSync(join(fake.dir, "broken"), "#!/bin/sh\necho 'database is locked' >&2\nexit 1\n", { mode: 0o755 })
    const broken = createLaptopPort({ runner, bin: join(fake.dir, "broken") })
    expect((await fail(broken.deleteSession("ses_a", context)))?.code).toBe("IMPORT_FAILED")
    expect(await failing.deleteSession("ses_a", context)).toBe("deleted")
    expect((await fail(laptop.deleteSession("not-a-session", context)))?.code).toBe("NAME_INVALID")
  })

  test("a laptop without opencode is IMPORT_FAILED", async () => {
    const missing = createLaptopPort({ runner, bin: join(fake.dir, "no-such-opencode") })
    expect((await fail(missing.deleteSession("ses_a", context)))?.code).toBe("IMPORT_FAILED")
  })

  test("imports run in their own pool: at most two at once, whatever the call's pool", async () => {
    const files = Array.from({ length: 8 }, (_, index) => exportFile(`ses_${index}`))
    await Promise.all(files.map((file) => laptop.importSession(file, "/project", { ...context, pool: "foreground" })))
    const spawns = fake.spawns().map((spawn) => ({ ...spawn, verb: verbOf(spawn.bin, spawn.argv) }))
    expect(peakOf(spawns)).toBeLessThanOrEqual(CAPS.import)
  })
})
