// A work's own secrets (boxd-plugin#146): the mint command here feeds `machine cp` on standard input, the guest's
// OpenCode starts with the value, the ledger keeps only the name, and drop runs the revoke command with the work id.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { sessionRuns } from "../../src/fleet/sessions.js"
import type { EnsureResult, ResumeResult } from "../../src/results.js"
import { startKit, type Kit } from "../support/machines-kit.js"
import { tempRoot } from "../support/temp.js"

setDefaultTimeout(60_000)

const kits: Kit[] = []
afterEach(async () => {
  for (const kit of kits.splice(0)) await kit.dispose()
})

async function kit(options: Record<string, unknown> = {}) {
  const made = await startKit({ options })
  kits.push(made)
  return made
}

const errorOf = async (promise: Promise<unknown>): Promise<{ code?: string; what?: string; details?: Record<string, unknown> }> =>
  promise.then(
    (value) => {
      throw new Error(`expected a refusal, got ${JSON.stringify(value)}`)
    },
    (error: { code?: string; what?: string; details?: Record<string, unknown> }) => error,
  )

/**
 * One command for both mint and revoke: `$1` is the verb and `$2` the work id. Every call is appended to the log, so a
 * test can see exactly when a value was minted or revoked. A mint prints the value the server must receive.
 */
function command(folder: string, value = "minted-value", failure?: number) {
  const log = join(folder, "work-secrets.log")
  const script = join(folder, "work-secret.sh")
  writeFileSync(
    script,
    `#!/bin/sh\nprintf '%s %s\\n' "$1" "$2" >> ${JSON.stringify(log)}\n${failure ? `if [ "$1" = "mint" ]; then exit ${failure}; fi\n` : ""}${failure ? "" : `if [ "$1" = "mint" ]; then printf '%s' ${JSON.stringify(value)}; fi\n`}`,
  )
  chmodSync(script, 0o755)
  return { log, script }
}

const lines = (path: string): string[] => (readFileSync(path, "utf8").split("\n").filter(Boolean) as string[])

describe("a new work's own secrets", () => {
  test("mint prints the value straight into machine cp on standard input, and the ledger keeps only the name", async () => {
    const folder = tempRoot("boxd-secret-")
    const secret = command(folder)
    const k = await kit({ workSecrets: [{ name: "MODELS_API_KEY", mint: [secret.script, "mint"], revoke: [secret.script, "revoke"] }] })
    try {
      await k.golden("fra")
      const result = (await k.runs.boxd_ensure({ workId: "secret-work", region: "fra" }, k.call())) as EnsureResult
      expect(result).toMatchObject({ state: "ready", created: true })
      if (!result.machineId) throw new Error("the work has no machine id")
      const file = join(k.counter.fake.disk(result.machineId), "home/boxd/.boxd-plugin/secrets/MODELS_API_KEY")
      expect(readFileSync(file, "utf8")).toBe("minted-value")
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(k.calls()).toContain("machine cp - oc-secret-work:/home/boxd/.boxd-plugin/secrets/MODELS_API_KEY --mode 600 --region fra")
      expect(k.calls().join("\n")).not.toContain("minted-value")
      const record = await k.record("secret-work")
      expect(record?.secrets).toEqual(["MODELS_API_KEY"])
      expect(JSON.stringify(record)).not.toContain("minted-value")
      expect(JSON.stringify(await k.services.ledger.eventsSince(0, { call: { callId: "events", source: "boxd_ensure" } }))).not.toContain("minted-value")
      expect(lines(secret.log)).toEqual(["mint secret-work"])
      // A second ensure finds the secret recorded and mints nothing again.
      await k.runs.boxd_ensure({ workId: "secret-work", region: "fra" }, k.call())
      expect(lines(secret.log)).toEqual(["mint secret-work"])
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test("a rebuilt machine revokes the old value and mints the secret again", async () => {
    const folder = tempRoot("boxd-secret-")
    const secret = command(folder)
    const k = await kit({ workSecrets: [{ name: "MODELS_API_KEY", mint: [secret.script, "mint"], revoke: [secret.script, "revoke"] }] })
    try {
      await k.golden("fra")
      const first = (await k.runs.boxd_ensure({ workId: "secret-rebuild", region: "fra" }, k.call())) as EnsureResult
      if (!first.machineId) throw new Error("the work has no machine id")
      k.counter.fake.update((state) => {
        const machine = state.machines.find((entry) => entry.id === first.machineId)
        if (machine) machine.status = "destroyed"
      })
      await k.services.boxd.list({ maxAgeMs: 0 }, { call: { callId: "fresh", source: "boxd_resume" } })
      const resumed = (await k.runs.boxd_resume({ workId: "secret-rebuild" }, k.call())) as ResumeResult
      expect(resumed).toMatchObject({ state: "ready", rebuilt: true })
      const rebuilt = await k.record("secret-rebuild")
      if (!rebuilt?.machineId) throw new Error("the rebuilt work has no machine id")
      const file = join(k.counter.fake.disk(rebuilt.machineId), "home/boxd/.boxd-plugin/secrets/MODELS_API_KEY")
      expect(readFileSync(file, "utf8")).toBe("minted-value")
      expect(lines(secret.log)).toEqual(["mint secret-rebuild", "revoke secret-rebuild", "mint secret-rebuild"])
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test("a failed mint refuses the work before any session starts, and a later ensure mints once the command works", async () => {
    const folder = tempRoot("boxd-secret-")
    const secret = command(folder, "minted-value", 7)
    const k = await kit({ workSecrets: [{ name: "MODELS_API_KEY", mint: [secret.script, "mint"] }] })
    try {
      await k.golden("fra")
      const error = await errorOf(k.runs.boxd_ensure({ workId: "failed-secret", region: "fra" }, k.call()))
      expect(error.code).toBe("SECRET_FAILED")
      expect(error.what).toContain("MODELS_API_KEY")
      expect(error.what).not.toContain("minted-value")
      expect(k.guest.prompts).toEqual([])
      expect((await k.record("failed-secret"))?.secrets).toBeUndefined()
      // The same work, once its command answers: the machine is adopted and the value is minted, never a session.
      writeFileSync(secret.script, `#!/bin/sh\nprintf '%s %s\\n' "$1" "$2" >> ${JSON.stringify(secret.log)}\nif [ "$1" = "mint" ]; then printf '%s' 'minted-value'; fi\n`)
      chmodSync(secret.script, 0o755)
      const retried = (await k.runs.boxd_ensure({ workId: "failed-secret", region: "fra" }, k.call())) as EnsureResult
      expect(retried).toMatchObject({ state: "ready", created: false })
      expect(k.guest.prompts).toEqual([])
      expect((await k.record("failed-secret"))?.secrets).toEqual(["MODELS_API_KEY"])
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test("drop runs revoke with the work id, after the guard and before the machine is removed", async () => {
    const folder = tempRoot("boxd-secret-")
    const secret = command(folder)
    const k = await kit({ workSecrets: [{ name: "MODELS_API_KEY", mint: [secret.script, "mint"], revoke: [secret.script, "revoke"] }] })
    try {
      await k.golden("fra")
      const result = (await k.runs.boxd_ensure({ workId: "secret-drop", region: "fra" }, k.call())) as EnsureResult
      if (!result.machineId) throw new Error("the work has no machine id")
      const work = join(k.counter.fake.disk(result.machineId), "home/boxd/work/secret-drop")
      mkdirSync(work, { recursive: true })
      const git = (...args: string[]) => {
        const answer = Bun.spawnSync(["git", "-C", work, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args])
        if (answer.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${answer.stderr.toString()}`)
      }
      git("init", "--quiet")
      writeFileSync(join(work, "README.md"), "# work\n")
      git("add", "README.md")
      git("commit", "--quiet", "-m", "init")
      const origin = join(dirname(work), "secret-drop-origin.git")
      Bun.spawnSync(["git", "init", "--bare", "--quiet", origin])
      git("remote", "add", "origin", origin)
      git("push", "--quiet", "-u", "origin", "HEAD")
      const at = new Date().toISOString()
      const opened = await k.record("secret-drop")
      if (!opened) throw new Error("the work has no record")
      await k.write({ ...opened, lastSubmit: { at, delivery: "steer" }, saved: { at, complete: true, guestVersion: "2.4.1", sessions: [] } })
      const { runs } = sessionRuns(k.services)
      expect(await runs.boxd_drop({ workId: "secret-drop" }, k.call())).toMatchObject({ state: "dropped", workId: "secret-drop" })
      expect(lines(secret.log)).toEqual(["mint secret-drop", "revoke secret-drop"])
      expect((await k.record("secret-drop"))?.state).toBe("closed")
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
