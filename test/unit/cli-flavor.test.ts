// The boxd CLI that runs inside a boxd machine takes `--vm <name>` where the laptop CLI takes the machine as an
// argument. The plugin refuses it up front, from `--help`, instead of failing command by command and ending as
// AWAKE_UNBOUND. The fakes below log every call, so a test sees that nothing but `--help` ran.
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cliBoxd } from "../../src/cli-boxd.js"
import { BoxdError } from "../../src/errors.js"

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
const LAPTOP_HELP = `boxd CLI

Usage: boxd [OPTIONS] [COMMAND]

Commands:
  auth       Sign in to boxd
  machine    Create, inspect, and control machines [aliases: m]
  snapshots  Save machine state and spin up fast copies from it
`
const MACHINE = JSON.stringify({ name: "oc-demo", status: "running", sharing: "private", isolated: "no" })

/** A fake CLI that logs its arguments to `<name>.log`, answers `--help` as `help` says, and a machine read with MACHINE. */
function fakeCli(name: string, help: "in-vm" | "laptop" | "fails" | "hangs"): { bin: string; calls: () => string[] } {
  const bin = join(dir, name)
  const log = join(dir, `${name}.log`)
  const text = help === "in-vm" ? IN_VM_HELP : LAPTOP_HELP
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> '${log}'
case "$1" in
  --help)
    ${help === "fails" ? 'echo "error: the boxd API answered 503 Service Unavailable" >&2; exit 1' : help === "hangs" ? "sleep 30" : `cat <<'EOF_HELP'\n${text}EOF_HELP`}
    exit 0 ;;
esac
echo '${MACHINE}'
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
  test("the in-VM CLI is refused as BOXD_MISSING, naming the laptop CLI, before any command that changes a machine", async () => {
    const { bin, calls } = fakeCli("in-vm", "in-vm")
    const port = cliBoxd(bin)
    for (const attempt of [() => port.get("oc-demo"), () => port.list(), () => port.holdAwake("oc-demo"), () => port.wake("oc-demo"), () => port.saveSnapshot("oc-demo", "image")]) {
      const error = await failure(attempt())
      expect(error).toBeInstanceOf(BoxdError)
      expect((error as BoxdError).code).toBe("BOXD_MISSING")
      expect((error as BoxdError).what).toBe(
        "The boxd CLI on the PATH is the one that runs inside a boxd machine. This plugin drives remote machines from the laptop's boxd CLI, and the in-VM CLI is not supported.",
      )
    }
    // Nothing ran but the read-only help.
    expect(new Set(calls())).toEqual(new Set(["--help"]))
  })

  test("the laptop CLI passes, and its flavour is read once", async () => {
    const { bin, calls } = fakeCli("laptop", "laptop")
    const port = cliBoxd(bin)
    expect((await port.get("oc-demo")).status).toBe("running")
    expect((await port.get("oc-demo")).status).toBe("running")
    expect(calls().filter((line) => line === "--help")).toHaveLength(1)
  })

  test("a CLI that cannot answer --help is not refused: the command that follows reports its own result", async () => {
    const { bin } = fakeCli("broken-help", "fails")
    expect((await cliBoxd(bin).get("oc-demo")).status).toBe("running")
  })

  test("a binary that is not there stays BOXD_MISSING for its own reason", async () => {
    const error = await failure(cliBoxd(join(dir, "no-such-boxd")).get("oc-demo"))
    expect((error as BoxdError).code).toBe("BOXD_MISSING")
    expect((error as BoxdError).what).toContain("could not be run")
  })
})
