// What a failed guest call says: the step that timed out, the helper's own error and detail, or the last line the
// machine wrote. A tool result carries that sentence, so a caller can tell a hung guest from a refusal.
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cliGuest } from "../../src/cli-guest.js"
import { BoxdError } from "../../src/errors.js"
import { commandOf, duration } from "../../src/run.js"

const dir = mkdtempSync(join(realpathSync(tmpdir()), "boxd-cli-guest-"))
const bin = join(dir, "boxd")
// A boxd CLI whose helper call answers as FAKE_GUEST says; every other command succeeds and prints nothing.
writeFileSync(
  bin,
  `#!/bin/sh
cat > /dev/null
case "$*" in
  *"-- python3 "*)
    case "$FAKE_GUEST" in
      hang) sleep 5 ;;
      crash) echo "Traceback (most recent call last):" >&2; echo "ZeroDivisionError: division by zero" >&2; exit 1 ;;
      refuse) echo '{"ok": false, "error": "HTTP 500", "detail": "the server said no, token=abc123456789"}'; exit 1 ;;
    esac ;;
esac
`,
)
chmodSync(bin, 0o755)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** One helper call in the given mode, and the coded error it raised. */
async function failure(mode: string, timeoutMs = 30_000): Promise<BoxdError> {
  process.env.FAKE_GUEST = mode
  try {
    const error = await cliGuest(bin, timeoutMs).listSessions("oc-review-api").then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(error).toBeInstanceOf(BoxdError)
    return error as BoxdError
  } finally {
    delete process.env.FAKE_GUEST
  }
}

describe("a failed guest call", () => {
  test("a timeout names the guest's action and the machine", async () => {
    const error = await failure("hang", 300)
    expect(error.code).toBe("TIMEOUT")
    expect(error.what).toBe("The guest's list on oc-review-api did not answer within 300 ms.")
  })

  test("a refusal carries the helper's error and its detail, redacted", async () => {
    const error = await failure("refuse")
    expect(error.code).toBe("GUEST_FAILED")
    expect(error.what).toBe("The guest list failed (HTTP 500: the server said no, token=[redacted]).")
  })

  test("a crash with no answer carries the last line the machine wrote", async () => {
    const error = await failure("crash")
    expect(error.code).toBe("GUEST_FAILED")
    expect(error.what).toBe("The guest helper did not return JSON (ZeroDivisionError: division by zero).")
  })
})

describe("a command's name in a timeout", () => {
  test("is the subcommand and the machine, never the command's input", () => {
    expect(commandOf("boxd", ["machine", "exec", "oc-review-api", "--", "python3", "/tmp/opencode-boxd/guest.py"])).toBe("boxd machine exec oc-review-api")
    expect(commandOf("boxd", ["machine", "new", "oc-review-api", "--from-snapshot", "opencode-golden"])).toBe("boxd machine new oc-review-api")
    expect(commandOf("boxd", ["machine", "config", "set", "oc-review-api", "auto-hibernate.timeout", "1800"])).toBe("boxd machine config set oc-review-api")
    expect(commandOf(bin, ["snapshots", "list", "--json"])).toBe("boxd snapshots list")
  })

  test("says seconds, or milliseconds below a whole second", () => {
    expect(duration(30_000)).toBe("30 s")
    expect(duration(300)).toBe("300 ms")
  })
})
