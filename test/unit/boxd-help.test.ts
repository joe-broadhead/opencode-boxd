// The external boxd CLI's own `--help`, recorded from the laptop CLI (provenance in the fixture): every flag and
// positional form the argv builders emit is proven against the real surface, and an invented flag or a missing
// positional fails. The fixture is verbatim CLI output.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  copyFromArgs,
  copyToArgs,
  createBuilderArgs,
  createWorkArgs,
  envListArgs,
  execArgs,
  getArgs,
  hibernateArgs,
  labelSetArgs,
  leaseArgs,
  listArgs,
  machineLimitArgs,
  rebootArgs,
  removeArgs,
  removeSnapshotArgs,
  renameArgs,
  resizeArgs,
  saveSnapshotArgs,
  snapshotsArgs,
  usageArgs,
  wakeArgs,
} from "../../src/provider/boxd/argv.js"
import type { ChangeTarget, CreateBuilder, CreateWork } from "../../src/ports.js"

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/boxd-cli-help.json", import.meta.url)), "utf8")) as {
  provenance: { binary: string; surface: string; version: string; recordedAt: string; installUrl: string; sha256: string }
  verbs: Record<string, string>
}
const HELP = fixture.verbs

const target = { region: "fra", machineId: "vm_0042" } as unknown as ChangeTarget
const work: CreateWork = { kind: "work", region: "fra", name: "oc-review-api", workId: "review-api", image: "oc-golden-2.4.1-2x8", ledger: "0a1b2c3d4e", autoSuspendSeconds: 0, autoHibernateSeconds: 7200 }
const builder: CreateBuilder = { kind: "builder", region: "fra", name: "oc-gb-fra-4x16-ab12", size: "4x16", base: "stock", deleteAfter: "2h" }

/** Every builder's argv, and the recorded verb it must belong to. */
const CASES: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ["list", "machine list", listArgs()],
  ["get", "machine get", getArgs("fra", "oc-review-api")],
  ["new work", "machine new", createWorkArgs(work)],
  ["new work with a lease", "machine new", createWorkArgs({ ...work, leaseDays: 3 })],
  ["new builder from stock", "machine new", createBuilderArgs(builder)],
  ["new builder from a snapshot", "machine new", createBuilderArgs({ ...builder, base: { snapshot: "my-base" } })],
  ["wake", "machine wake", wakeArgs(target)],
  ["hibernate", "machine hibernate", hibernateArgs(target)],
  ["remove", "machine remove", removeArgs(target)],
  ["reboot", "machine reboot", rebootArgs(target)],
  ["resize", "machine resize", resizeArgs(target, "8x32")],
  ["rename", "machine rename", renameArgs(target, "oc-renamed")],
  ["label set", "machine label set", labelSetArgs(target, "team", "data")],
  ["lease", "machine config set", leaseArgs(target, 2)],
  ["exec", "machine exec", execArgs("fra", "oc-review-api", "git status --short", 60, true)],
  ["exec without json", "machine exec", execArgs("fra", "oc-review-api", "echo hi", 30, false)],
  ["copy to", "machine cp", copyToArgs("fra", "oc-review-api", "guest.py", "/home/boxd/.boxd-plugin-upload.py")],
  ["copy from", "machine cp", copyFromArgs("fra", "oc-review-api", "/home/boxd/.boxd-plugin/exports/ses_a.json", "x.tmp")],
  ["machine limit", "manage machine-limit", machineLimitArgs()],
  ["usage", "manage usage", usageArgs("24h")],
  ["snapshots", "snapshots list", snapshotsArgs()],
  ["snapshot save", "snapshots save", saveSnapshotArgs(target, "oc-golden-2.4.1-2x8")],
  ["snapshot remove", "snapshots rm", removeSnapshotArgs("fra", "oc-golden-2.4.1-2x8")],
  ["env list", "env list", envListArgs()],
]

/** The options a help page lists, from its option lines (`--json`, `--region`, `-y, --yes`, `--idle-ignore-outbound[=…]`). */
function optionsOf(help: string): Set<string> {
  const names = new Set<string>()
  for (const match of help.matchAll(/^\s{2,}(?:-(\w),\s+)?(--[A-Za-z0-9-]+)/gm)) {
    if (match[1]) names.add(`-${match[1]}`)
    if (match[2]) names.add(match[2])
  }
  return names
}

/** The positional forms in a usage line, without `[OPTIONS]` and the optional `[COMMAND]` a verb may take. */
function positionalsOf(help: string): number {
  const usage = help.split("\n").find((line) => line.startsWith("Usage:")) ?? ""
  return [...usage.matchAll(/\[[^\]]*\]|<[^>]*>/g)].map((match) => match[0]).filter((form) => !["[OPTIONS]", "[COMMAND]"].includes(form)).length
}

const VALUE_FLAGS = new Set(["--region", "--from-snapshot", "--label", "--auto-suspend-timeout", "--auto-hibernate-timeout", "--delete-after", "--vcpu", "--timeout", "--since"])

/** What an argv says, after the recorded verb: its flags, and how many positionals it passes (a command after `--` is one). */
function parse(tokens: readonly string[]) {
  const verbs = Object.keys(HELP).sort((a, b) => b.split(" ").length - a.split(" ").length)
  const verb = verbs.find((candidate) => candidate.split(" ").every((part, index) => tokens[index] === part))
  if (!verb) return { verb: undefined, flags: [], positionals: 0 }
  const flags: string[] = []
  let positionals = 0
  for (let index = verb.split(" ").length; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token === "--") continue
    if (token.startsWith("--") && token.includes("=")) {
      flags.push(token.split("=")[0]!)
      continue
    }
    if (token.startsWith("-")) {
      flags.push(token)
      if (VALUE_FLAGS.has(token)) index++
      continue
    }
    positionals++
  }
  return { verb, flags, positionals }
}

/** A concrete argv against its recorded help: the verb, every flag and the exact positional count. */
function problems(tokens: readonly string[]): string[] {
  const { verb, flags, positionals } = parse(tokens)
  if (!verb) return [`no recorded help for ${tokens.slice(0, 3).join(" ")}`]
  const help = HELP[verb]!
  const options = optionsOf(help)
  const found = flags.filter((flag) => !options.has(flag)).map((flag) => `${verb}: ${flag} is not an option the CLI records`)
  const expected = positionalsOf(help)
  if (positionals !== expected) found.push(`${verb}: ${positionals} positional form(s), the recorded usage has ${expected}`)
  return found
}

describe("the external boxd CLI's recorded help", () => {
  test("the provenance is the laptop CLI's, and the argv builder names the same version", () => {
    expect(fixture.provenance).toMatchObject({
      binary: "boxd",
      version: "0.3.8",
      recordedAt: "2026-11-24",
      installUrl: "https://boxd.sh/downloads/install.sh",
    })
    expect(fixture.provenance.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(fixture.provenance.surface).toContain("not the in-VM CLI")
    expect(Object.keys(HELP)).toHaveLength(19)
    const source = readFileSync(fileURLToPath(new URL("../../src/provider/boxd/argv.ts", import.meta.url)), "utf8")
    expect(source).toContain("laptop boxd CLI (0.3.8)")
  })

  test.each(CASES)("%s: %s accepts every flag and positional form", (_name, verb, tokens) => {
    expect(problems(tokens)).toEqual([])
    expect(parse(tokens).verb).toBe(verb)
  })

  test("an invented flag and a missing positional both fail, so the check is not vacuous", () => {
    expect(problems([...listArgs(), "--bogus"])).toEqual(["machine list: --bogus is not an option the CLI records"])
    expect(problems(["machine", "rename", "vm_0042", "oc-renamed"]).length).toBe(0)
    expect(problems(["machine", "rename", "vm_0042"])).toContain("machine rename: 1 positional form(s), the recorded usage has 2")
  })
})
