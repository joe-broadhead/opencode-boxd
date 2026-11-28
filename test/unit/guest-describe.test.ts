// The guest's describe action, read on a machine with no record: its work checkouts, its root sessions and its
// installed OpenCode. The real guest/guest.py runs against a folder that stands in for the machine's disk, with a
// session store on that disk and a loopback fake of the guest's OpenCode server already running. It starts no server
// of its own and writes nothing.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readDescribe } from "../../src/provider/guest/answers.js"
import { startFakeGuest, type FakeGuest } from "../host/fake-guest.js"

setDefaultTimeout(60_000)

const guest = join(import.meta.dir, "../../guest/guest.py")
const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "boxd-guest-describe-")))
const home = join(root, "home/boxd")
const work = join(home, "work")
const bin = join(root, "bin")
const unpushedDirectory = join(work, "unpushed-work")
const pushedDirectory = join(work, "pushed-work")
const unpushedGuest = "/home/boxd/work/unpushed-work"
const pushedGuest = "/home/boxd/work/pushed-work"
let server: FakeGuest
let answer: Record<string, unknown>

/** git with an invented identity; a failure stops the fixture. */
function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args])
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

const head = (directory: string) => git("-C", directory, "rev-parse", "HEAD").trim()

/** One describe as the plugin sends it, against a server that may be up or down, as the helper answered it. */
async function describeAnswer(base: string): Promise<Record<string, unknown>> {
  const child = Bun.spawn(["python3", guest], {
    stdin: new Blob([JSON.stringify({ action: "describe", base })]),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: `${bin}:${process.env.PATH}`, BOXD_FAKE_ROOT: root, HOME: home, LANG: "C.UTF-8" },
  })
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const line = out.trim().split("\n").at(-1) ?? ""
  const parsed = JSON.parse(line) as Record<string, unknown>
  if (!parsed || typeof parsed !== "object") throw new Error(`describe printed no answer: ${line}${err ? `\n${err}` : ""}`)
  return parsed
}

/** The same, for a read that must succeed. */
async function describeWith(base: string): Promise<Record<string, unknown>> {
  const parsed = await describeAnswer(base)
  if (parsed.ok !== true) throw new Error(`describe failed: ${JSON.stringify(parsed)}`)
  return parsed
}

beforeAll(async () => {
  mkdirSync(bin, { recursive: true })
  mkdirSync(work, { recursive: true })
  writeFileSync(join(bin, "opencode"), '#!/bin/sh\ncase "$1" in\n  --version) echo 2.4.1 ;;\nesac\n')
  chmodSync(join(bin, "opencode"), 0o755)

  const origin = join(root, "origin.git")
  git("init", "--bare", "--quiet", origin)
  const seed = join(root, "seed")
  git("init", "--quiet", seed)
  writeFileSync(join(seed, "README.md"), "one\n")
  git("-C", seed, "add", ".")
  git("-C", seed, "commit", "--quiet", "-m", "init")
  git("-C", seed, "remote", "add", "origin", origin)
  git("-C", seed, "push", "--quiet", "origin", "HEAD:refs/heads/main")
  git("--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main")

  git("clone", "--quiet", origin, pushedDirectory)
  git("clone", "--quiet", origin, unpushedDirectory)
  // A work folder that is not a checkout is not a work.
  mkdirSync(join(work, "not-a-checkout"))
  // One checkout clean and pushed, one with a commit no remote ref holds, a tracked change and an untracked file.
  writeFileSync(join(unpushedDirectory, "README.md"), "two\n")
  git("-C", unpushedDirectory, "add", "README.md")
  git("-C", unpushedDirectory, "commit", "--quiet", "-m", "local change")
  writeFileSync(join(unpushedDirectory, "README.md"), "three\n")
  writeFileSync(join(unpushedDirectory, "notes.txt"), "notes\n")

  // The session store: one root running, and a child that describe never lists as a root.
  const data = join(home, ".local/share/opencode")
  mkdirSync(data, { recursive: true })
  const db = new Database(join(data, "opencode.db"))
  db.run("create table session_v2 (id text primary key, parent_id text, directory text not null, time_busy integer, time_idle integer, time_updated integer not null)")
  db.run("insert into session_v2 values (?, ?, ?, ?, ?, ?)", ["ses_busy_root", null, unpushedGuest, 2, 1, 2])
  db.run("insert into session_v2 values (?, ?, ?, ?, ?, ?)", ["ses_child", "ses_busy_root", unpushedGuest, 2, 1, 2])
  db.close()

  // The server already running knows the same root: it is active and waits on a permission.
  server = startFakeGuest({ version: "2.4.1" })
  server.sessions.set("ses_busy_root", { id: "ses_busy_root", busy: true, directory: unpushedGuest, messages: [], inbox: [], updated: 2 })
  server.pending.set("ses_busy_root", "permission")

  answer = await describeWith(server.url)
})

afterAll(async () => {
  await server?.close()
  rmSync(root, { recursive: true, force: true })
})

describe("describe on a machine with no record", () => {
  test("the works, the root session and the installed OpenCode, every field read", () => {
    expect(answer).toMatchObject({ protocol: 1, opencode: "2.4.1" })
    expect(answer.works).toEqual([
      {
        directory: pushedGuest,
        remote: join(root, "origin.git"),
        branch: "main",
        head: head(pushedDirectory),
        dirty: false,
        untracked: 0,
        unpushed: 0,
        unpushedKnown: true,
      },
      {
        directory: unpushedGuest,
        remote: join(root, "origin.git"),
        branch: "main",
        head: head(unpushedDirectory),
        dirty: true,
        untracked: 1,
        unpushed: 1,
        unpushedKnown: true,
      },
    ])
    expect(answer.sessions).toEqual([{ id: "ses_busy_root", directory: unpushedGuest, busy: true, needsInput: "permission" }])
    // The port reads the same answer: the parser keeps every field and no child session.
    expect(readDescribe(answer) as unknown).toEqual({ opencode: "2.4.1", works: answer.works, sessions: answer.sessions })
  })

  test("the port refuses an answer whose shape it does not know", () => {
    const works = answer.works as Array<Record<string, unknown>>
    const sessions = answer.sessions as Array<Record<string, unknown>>
    const firstWork = works[0] ?? {}
    const firstSession = sessions[0] ?? {}
    const refused: Array<Record<string, unknown>> = [
      { ...answer, works: "two" },
      { ...answer, works: [{ ...firstWork, untracked: -1 }] },
      { ...answer, works: [{ ...firstWork, unpushedKnown: false, unpushed: 0 }] },
      { ...answer, sessions: [{ ...firstSession, id: "not-a-session" }] },
      { ...answer, sessions: [{ ...firstSession, needsInput: "waiting" }] },
    ]
    for (const bad of refused) {
      let caught: unknown
      try {
        readDescribe(bad)
      } catch (error) {
        caught = error
      }
      expect((caught as { code?: string } | undefined)?.code).toBe("GUEST_FAILED")
    }
  })

  test("a checkout whose name is not a work id fails the read instead of disappearing", async () => {
    const directory = join(work, "My_Repo")
    git("clone", "--quiet", join(root, "origin.git"), directory)
    try {
      const refused = await describeAnswer(server.url)
      expect(refused).toMatchObject({ ok: false, protocol: 1, error: "GIT_UNKNOWN" })
      expect(refused.detail).toBe("My_Repo is a git checkout that is not a work folder")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("a server that is down is left down: the store's own stamps answer", async () => {
    const down = await describeWith("http://127.0.0.1:1")
    expect(down.sessions).toEqual([{ id: "ses_busy_root", directory: unpushedGuest, busy: true, needsInput: null }])
    expect(down.works).toEqual(answer.works)
    expect(existsSync(join(home, ".boxd-plugin"))).toBe(false)
  })
})
