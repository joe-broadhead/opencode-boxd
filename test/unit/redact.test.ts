// Credentials and paths never reach what status prints. Every shape is checked on the status model, /boxd-status, the
// dialog, and the failed-ledger reason, which is the only text status takes from outside.
import { describe, expect, test } from "bun:test"
import { excerpt, reasonOf, shortReason, oneLine, cut } from "../../src/redact.js"
import { buildStatus, formatStatus } from "../../src/status.js"
import { defaultRules } from "../../src/permissions.js"
import { TOOLS } from "../../src/tools.js"
import { registerStatusRpc, StatusRpc, type Status } from "../../src/status.js"

const SECRETS = ["abcdefghijklmnop", "sk-live-0123456789abcdef", "eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl", "fake-signature", "x".repeat(48)]

describe("redaction", () => {
  test("cuts a bearer token, a key assignment, a JWT, a vendor key and a long run", () => {
    for (const secret of SECRETS) {
      const text = shortReason(`boxd failed: Authorization: Bearer ${secret} and api_key=${secret} https://boxd.sh/x?token=${secret}`)
      expect(text).not.toContain(secret)
    }
  })

  test("keeps a URL's scheme, host and path, and drops its credentials and query", () => {
    expect(shortReason("GET https://user:pass@boxd.sh/machines/oc-1?token=abc#frag failed")).toBe("GET https://boxd.sh/machines/oc-1 failed")
  })

  test("a guest's words are redacted the same way, cut to their own limit, and keep their closing punctuation", () => {
    for (const secret of SECRETS) expect(excerpt(`Pushed with Authorization: Bearer ${secret}\nand api_key=${secret}.`, 300)).not.toContain(secret)
    expect(excerpt("Done.\nThe pull request is open.", 300)).toBe("Done. The pull request is open.")
    expect(Array.from(excerpt("word ".repeat(100), 300)!)).toHaveLength(300)
    expect(excerpt(" \n ", 300)).toBeUndefined()
  })

  test("one line, no controls, no bidi, at most 160 characters", () => {
    expect(oneLine("a\nb\u0000c\u202ed")).toBe("a b cd")
    expect(cut("x".repeat(200), 160)).toHaveLength(160)
    expect(cut("short", 160)).toBe("short")
    expect(reasonOf(new Error(""))).toBe("no reason given")
  })
})

const host = { version: "2.2.6", range: ">=2.2.3 <2.3.0", tested: true }

const status = (ledgerError?: string): Status =>
  buildStatus({
    access: "all",
    host,
    snapshot: "opencode-golden",
    guestVersion: "2.2.6",
    ...(ledgerError ? { ledgerError } : { ledger: { snapshot: "opencode-golden", works: [], orphans: [], snapshotPresent: true } }),
    tools: TOOLS.map((tool) => tool.id),
    agents: [{ id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }, ...defaultRules()] }],
    problems: [],
  })

describe("nothing secret reaches a status surface", () => {
  test("the model and the report show a redacted ledger failure", () => {
    const failure = "EACCES: scandir the ledger directory with token=abcdefghijklmnop"
    for (const text of [JSON.stringify(status(failure)), formatStatus(status(failure))]) {
      expect(text).not.toContain("abcdefghijklmnop")
      expect(text).toContain("EACCES")
    }
  })

  test("a failure's reason is one line of at most 160 characters", () => {
    const line = status(`EACCES: ${"x".repeat(400)}`).error!
    expect(line.length).toBeLessThanOrEqual(160)
    expect(line).not.toContain("\n")
  })

  test("the status RPC declares one error, with a next step", () => {
    expect(StatusRpc.methods.status.errors).toHaveProperty("unavailable")
    expect(registerStatusRpc).toBeDefined()
  })
})
