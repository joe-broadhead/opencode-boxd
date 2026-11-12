// A guest call that hangs is probed once: when the machine still answers, the error says why the guest does not (free
// memory, load, the largest processes, the server's port), because waiting a turn cannot fix a guest out of memory.
// When the probe hangs too, the plain timeout stands: nothing is known about the guest.
import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { cliGuest } from "../../src/cli-guest.js"
import { BoxdError } from "../../src/errors.js"

const dir = mkdtempSync(join(realpathSync(tmpdir()), "boxd-unresponsive-"))
const bin = join(dir, "boxd")
// The machine's own answer to the probe: out of memory, with a process name that is not plain text.
const STRAINED = JSON.stringify({
  ok: true,
  memTotalMiB: 15360,
  memAvailableMiB: 212,
  load1: 27.4,
  cpus: 4,
  top: [
    { pid: 4242, name: "chrome\u001b[31m$(id)", rssMiB: 6100 },
    { pid: 4243, name: "chrome", rssMiB: 5500 },
    { pid: 101, name: "opencode", rssMiB: 410 },
  ],
  server: "listening",
})
// A machine with memory to spare, a light load and its server up: the call was slow, not the guest stuck.
const WELL = JSON.stringify({ ok: true, memTotalMiB: 15360, memAvailableMiB: 9000, load1: 0.5, cpus: 4, top: [{ pid: 101, name: "opencode", rssMiB: 410 }], server: "listening" })
// The same well machine with nothing on the OpenCode port: the server is gone, not the machine stuck.
const DOWN = WELL.replace('"listening"', '"closed"')
// Out of memory and with the server gone, as a guest the kernel killed it on is: memory is the cause to report.
const BOTH = STRAINED.replace('"listening"', '"closed"')
// Every helper call hangs; the probe answers or hangs as FAKE_PROBE says. Other commands succeed and print nothing.
writeFileSync(
  bin,
  `#!/bin/sh
input=$(cat)
case "$*" in
  *"-- python3 "*)
    case "$input" in
      *'"action":"health"'*)
        [ "$FAKE_PROBE" = strained ] && { echo '${STRAINED}'; exit 0; }
        [ "$FAKE_PROBE" = well ] && { echo '${WELL}'; exit 0; }
        [ "$FAKE_PROBE" = down ] && { echo '${DOWN}'; exit 0; }
        [ "$FAKE_PROBE" = both ] && { echo '${BOTH}'; exit 0; }
        [ "$FAKE_PROBE" = garbled ] && { echo '{"ok": true, "memTotalMiB": 153'; exit 0; }
        sleep 5 ;;
      *) sleep 5 ;;
    esac ;;
esac
`,
)
chmodSync(bin, 0o755)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function hung(probe: "strained" | "well" | "down" | "both" | "garbled" | "hangs"): Promise<BoxdError> {
  process.env.FAKE_PROBE = probe
  try {
    const error = await cliGuest(bin, 300).phase("oc-review-api", "ses_root").then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(error).toBeInstanceOf(BoxdError)
    return error as BoxdError
  } finally {
    delete process.env.FAKE_PROBE
  }
}

describe("a guest call that hangs", () => {
  test("is GUEST_UNRESPONSIVE with the machine's own facts when the probe shows it strained", async () => {
    const error = await hung("strained")
    expect(error.code).toBe("GUEST_UNRESPONSIVE")
    expect(error.what).toBe(
      "The guest's phase on oc-review-api did not answer in time, but the machine did: 212 MiB of 15360 MiB memory available, load 27.4, largest chrome31mid (pid 4242) 6100 MiB, chrome (pid 4243) 5500 MiB, opencode (pid 101) 410 MiB; the OpenCode port is open.",
    )
    // One next step, and it is the user's: the model is not told to kill processes or reboot past the access option.
    expect(error.next).toBe("Tell the user the machine is short of memory or overloaded, and which processes the message names, so they can free it.")
    expect(error.next).not.toMatch(/boxd machine|kill|reboot/)
  })

  test("is GUEST_SERVER_DOWN, with its own next step, when the machine is well but nothing listens on the port", async () => {
    const error = await hung("down")
    expect(error.code).toBe("GUEST_SERVER_DOWN")
    expect(error.what).toContain("nothing listens on its OpenCode port: 9000 MiB of 15360 MiB memory available")
    expect(error.next).toBe("Call boxd_job in a later turn: it starts the guest's OpenCode again, and reports starting until it is up.")
  })

  test("reports memory first when the server is gone too, because restarting it would run out again", async () => {
    expect((await hung("both")).code).toBe("GUEST_UNRESPONSIVE")
  })

  test("a probe line that is not JSON is no answer: the coded timeout stands, not a raw parse error", async () => {
    const error = await hung("garbled")
    expect(error.code).toBe("TIMEOUT")
    expect(error.what).toBe("The guest's phase on oc-review-api did not answer within 300 ms.")
  })

  test("stays a TIMEOUT, with the facts, when the machine looks well: the call was slow, not the guest stuck", async () => {
    const error = await hung("well")
    expect(error.code).toBe("TIMEOUT")
    expect(error.message).toContain("looks well: 9000 MiB of 15360 MiB memory available, load 0.5, largest opencode (pid 101) 410 MiB; the OpenCode port is open.")
  })

  test("stays a plain TIMEOUT, naming the step, when the probe hangs too", async () => {
    const error = await hung("hangs")
    expect(error.code).toBe("TIMEOUT")
    expect(error.what).toBe("The guest's phase on oc-review-api did not answer within 300 ms.")
  })
})

describe("the guest's health action", () => {
  test("reads /proc, names processes by command name only, and talks to no server", () => {
    const helper = fileURLToPath(new URL("../../guest/guest.py", import.meta.url))
    // A port nothing listens on: the action must not need the guest's OpenCode.
    const result = spawnSync("python3", [helper], { input: JSON.stringify({ action: "health", base: "http://127.0.0.1:9" }), encoding: "utf8" })
    expect(result.status).toBe(0)
    const health = JSON.parse(result.stdout) as Record<string, unknown>
    expect(Object.keys(health).sort()).toEqual(["cpus", "load1", "memAvailableMiB", "memTotalMiB", "ok", "server", "top"])
    expect(health).toMatchObject({ ok: true, server: "closed" })
    expect(typeof health.memTotalMiB).toBe("number")
    const top = health.top as Array<Record<string, unknown>>
    expect(top.length).toBeLessThanOrEqual(3)
    for (const item of top) expect(Object.keys(item).sort()).toEqual(["name", "pid", "rssMiB"])
  })
})
