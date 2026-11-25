// The real OpenCode 2.4.1 host must register every skills/<name>/SKILL.md after the plugin loads. The project is an
// empty temp directory: OpenCode discovers <project>/skills/ itself, so the repository root would let this test pass
// without the plugin's registration.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import { cleanup, startHost, until } from "./harness.js"

setDefaultTimeout(120_000)
afterAll(cleanup)

const ROOT = join(import.meta.dir, "..", "..")
const SKILLS = join(ROOT, "skills")
const MARKERS = [">", "|", ">-", "|-", ">+", "|+"]

test("the real host registers every skills/<name>/SKILL.md with the YAML description after load", async () => {
  const ids = readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  expect(ids.length).toBeGreaterThan(0)

  const host = await startHost()
  try {
    // Empty temp project: the host's own skills/ discovery cannot supply the plugin's skill.
    expect(host.location.directory.startsWith(SKILLS)).toBe(false)
    expect(existsSync(join(host.location.directory, "skills"))).toBe(false)

    const listed = await until("every skill file is registered", async () => {
      const { data } = await host.client.skill.list({ location: host.location })
      return ids.every((id) => data.some((skill) => String(skill.id) === id)) ? data : false
    })
    for (const id of ids) {
      const skill = listed.find((candidate) => String(candidate.id) === id)
      expect(skill).toBeDefined()
      expect(String(skill!.name)).toBe(id)
      expect(String(skill!.path)).toBe(join(SKILLS, id, "SKILL.md"))
      expect(String(skill!.content).trim().length).toBeGreaterThan(0)

      const text = readFileSync(skill!.path, "utf8")
      const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
      expect(front).not.toBeNull()
      const parsed = parseYaml(front![1] ?? "") as { readonly description?: unknown }
      expect(typeof parsed.description).toBe("string")
      const expected = parsed.description as string
      expect(expected.trim()).not.toBe("")
      for (const marker of MARKERS) expect(expected.trim()).not.toBe(marker)
      expect(String(skill!.description)).toBe(expected)
    }

    // A registered skill under the plugin's skills/ tree must have its file; a file that is not registered already
    // failed the `until` above.
    const fileIds = new Set(ids)
    const ours = listed.filter((skill) => fileIds.has(String(skill.id)) || String(skill.path).startsWith(`${SKILLS}/`))
    for (const skill of ours) expect(existsSync(String(skill.path))).toBe(true)
    expect(ours.filter((skill) => fileIds.has(String(skill.id))).map((skill) => String(skill.id)).sort()).toEqual(ids)
  } finally {
    await host.close()
  }
})
