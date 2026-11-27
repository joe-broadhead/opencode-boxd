// The completion tool the guest helper writes: OpenCode 2.4.1 loads the file from the guest's global plugins folder and
// lists boxd_done. A valid call answers its one-line confirmation; an empty or malformed call is refused.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Plugin } from "@opencode/plugin"
import { startFakeGuest } from "./fake-guest.js"
import { attempt, cleanup, session, startHost } from "./harness.js"

setDefaultTimeout(120_000)
afterAll(cleanup)

/** Runs the guest helper's own setup on a stand-in disk, then answers the plugin file it wrote and the disk. */
async function writtenPlugin(): Promise<{ disk: string; file: string }> {
  const server = startFakeGuest({ version: "2.4.1" })
  const disk = mkdtempSync("/tmp/boxd-guest-done-")
  const home = join(disk, "home", "boxd")
  mkdirSync(join(home, ".boxd-plugin"), { recursive: true })
  // A version-only stand-in for the guest's OpenCode: setup starts nothing here, and must not.
  const bin = join(disk, "bin")
  mkdirSync(bin)
  writeFileSync(join(bin, "opencode"), '#!/bin/sh\n[ "$1" = "--version" ] && echo 2.4.1\nexit 0\n')
  chmodSync(join(bin, "opencode"), 0o755)
  // The server stands in for one this helper started with no declared variables: setup must not restart it.
  writeFileSync(join(home, ".boxd-plugin", "env.json"), "[]")
  const helper = fileURLToPath(new URL("../../guest/guest.py", import.meta.url))
  const request = {
    action: "setup",
    helper: createHash("sha256").update(readFileSync(helper)).digest("hex"),
    directory: "/home/boxd/work/host-done",
    base: server.url,
  }
  const run = Bun.spawnSync(["python3", helper], {
    env: { ...process.env, BOXD_FAKE_ROOT: disk, PATH: `${bin}:${process.env.PATH ?? ""}` },
    stdin: Buffer.from(JSON.stringify(request)),
    cwd: home,
    stdout: "pipe",
    stderr: "pipe",
  })
  await server.close()
  const answer = JSON.parse(run.stdout.toString().trim() || "{}") as { ok?: boolean; error?: string }
  if (answer.ok !== true) throw new Error(`the guest helper's setup failed: ${answer.error ?? run.stderr.toString()}`)
  // The plugin file imports @opencode/plugin, which the guest's OpenCode provides; here the package is this repository's.
  symlinkSync(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(disk, "node_modules"), "dir")
  return { disk, file: join(home, ".config", "opencode", "plugins", "boxd-done.js") }
}

describe("the guest's completion tool", () => {
  test("OpenCode 2.4.1 loads it, lists boxd_done, confirms a valid call and refuses an invalid one", async () => {
    const written = await writtenPlugin()
    try {
      const loaded = (await import(pathToFileURL(written.file).href)) as { default: Plugin.Plugin }
      const host = await startHost({ plugins: [loaded.default] })
      try {
        const listed = (await host.probe().tool.list()).find((tool) => tool.id === "boxd_done")
        expect(listed?.description).toContain("as your last act")
        const sessionID = await session(host, "build")
        const confirmed = await attempt(host, sessionID, "build", "boxd_done", "reject", {
          summary: "Added the completion tool to the guest's OpenCode.",
          prs: ["https://github.com/we-the-rebel-alliance/boxd-plugin/pull/101", "we-the-rebel-alliance/boxd-plugin#102"],
        })
        expect(confirmed.ok).toBe(true)
        expect(confirmed.content).toBe("Done recorded: 2 pull requests.")
        const withoutPrs = await attempt(host, sessionID, "build", "boxd_done", "reject", { summary: "Only the summary." })
        expect(withoutPrs.content).toBe("Done recorded.")
        const empty = await attempt(host, sessionID, "build", "boxd_done", "reject", { summary: "   " })
        expect(empty.ok).toBe(false)
        expect(empty.error).toContain("boxd_done refused: summary must be a non-empty string")
        const badPr = await attempt(host, sessionID, "build", "boxd_done", "reject", { summary: "Summary.", prs: ["not a pull request"] })
        expect(badPr.ok).toBe(false)
        expect(badPr.error).toContain("is not a pull request URL or owner/repo#n")
        const tooMany = await attempt(host, sessionID, "build", "boxd_done", "reject", {
          summary: "Summary.",
          prs: Array.from({ length: 21 }, (_, index) => `owner/repo#${index + 1}`),
        })
        expect(tooMany.ok).toBe(false)
        expect(tooMany.error).toContain("prs must list at most 20 pull requests")
      } finally {
        await host.close()
      }
    } finally {
      rmSync(written.disk, { recursive: true, force: true })
    }
  })
})
