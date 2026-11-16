// The boxd CLI that runs inside a boxd machine acts in its own region only and takes other arguments. The plugin
// refuses it up front, from `--help`, through the runner and once per binary (F9), instead of failing command by
// command. The fakes below log every call, so a test sees that nothing but `--help` ran.
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertLaptopCli as check } from "../../src/boxd/flavor.js"
import { createRunner } from "../../src/exec/runner.js"
import { BoxdError } from "../../src/errors.js"

const runner = createRunner()
afterAll(() => runner.dispose())
const assertLaptopCli = (bin: string) => check(bin, runner, { call: { callId: "call_flavor", source: "boxd_status" } })

const dir = mkdtempSync(join(realpathSync(tmpdir()), "boxd-flavor-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// What the in-VM CLI prints for `boxd --help`, shortened to the lines that name it.
const IN_VM_HELP = `boxd VM management CLI

Usage: boxd [OPTIONS] [COMMAND]

Commands:
  info       Current machine info (shortcut for \`machine get\` on this VM)
  machine    Create, inspect, and control machines [aliases: m]
  local      Interact with your local machine (laptop) from inside the VM

Options:
      --region <REGION>
          The region for machine and snapshot commands: this machine's only

          Default: BOXD_REGION. boxd inside a machine acts in its machine's region only.
`
// One in-VM phrase each: a laptop CLI could carry either in its own wording, so neither alone refuses it.
const REGION_ONLY_HELP = `boxd CLI

Commands:
  machine    Create, inspect, and control machines

Options:
      --region <REGION>
          Default: BOXD_REGION. boxd inside a machine acts in its machine's region only.
`
const LOCAL_ONLY_HELP = `boxd CLI

Commands:
  machine    Create, inspect, and control machines
  local      Interact with your local machine (laptop) from inside the VM
`
const LAPTOP_HELP = `boxd CLI

Usage: boxd [OPTIONS] [COMMAND]

Commands:
  auth       Sign in to boxd
  machine    Create, inspect, and control machines [aliases: m]
  snapshots  Save machine state and spin up fast copies from it
`

/** A fake CLI that logs its arguments to `<name>.log` and answers `--help` as `help` says. */
function fakeCli(name: string, help: "in-vm" | "laptop" | "fails" | "hangs" | "region-only" | "local-only"): { bin: string; calls: () => string[] } {
  const bin = join(dir, name)
  const log = join(dir, `${name}.log`)
  const text = help === "in-vm" ? IN_VM_HELP : help === "region-only" ? REGION_ONLY_HELP : help === "local-only" ? LOCAL_ONLY_HELP : LAPTOP_HELP
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> '${log}'
case "$1" in
  --help)
    ${help === "fails" ? 'echo "error: the boxd API answered 503 Service Unavailable" >&2; exit 1' : help === "hangs" ? "sleep 30" : `cat <<'EOF_HELP'\n${text}EOF_HELP`}
    exit 0 ;;
esac
`,
  )
  chmodSync(bin, 0o755)
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) }
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  )

describe("the boxd CLI the plugin finds on the PATH", () => {
  test("the in-VM CLI is refused as BOXD_MISSING, naming the laptop CLI, and nothing but --help runs", async () => {
    const { bin, calls } = fakeCli("in-vm", "in-vm")
    for (let attempt = 0; attempt < 3; attempt++) {
      const error = await failure(assertLaptopCli(bin))
      expect(error).toBeInstanceOf(BoxdError)
      expect((error as BoxdError).code).toBe("BOXD_MISSING")
      expect((error as BoxdError).what).toBe(
        "The boxd CLI on the PATH is the one that runs inside a boxd machine. This plugin drives machines in every region from the laptop's boxd CLI, and the in-VM CLI is not supported.",
      )
    }
    expect(new Set(calls())).toEqual(new Set(["--help"]))
  })

  test("the laptop CLI passes, and its flavour is read once, by one flight for concurrent callers", async () => {
    const { bin, calls } = fakeCli("laptop", "laptop")
    await Promise.all([assertLaptopCli(bin), assertLaptopCli(bin), assertLaptopCli(bin)])
    await assertLaptopCli(bin)
    expect(calls().filter((line) => line === "--help")).toHaveLength(1)
  })

  test("a help with only one of the in-VM phrases is not refused, either way round", async () => {
    for (const help of ["region-only", "local-only"] as const) {
      const { bin } = fakeCli(help, help)
      expect(await failure(assertLaptopCli(bin))).toBeUndefined()
    }
  })

  test("a CLI that cannot answer --help is not refused: the command that follows reports its own result", async () => {
    const { bin } = fakeCli("broken-help", "fails")
    expect(await failure(assertLaptopCli(bin))).toBeUndefined()
  })

  test("a binary that is not there stays BOXD_MISSING for its own reason", async () => {
    const error = await failure(assertLaptopCli(join(dir, "no-such-boxd")))
    expect((error as BoxdError).code).toBe("BOXD_MISSING")
    expect((error as BoxdError).what).toContain("could not be run")
  })
})
