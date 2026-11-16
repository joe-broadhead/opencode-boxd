// The stderr table (design §5): each case is the CLI's own words as a fixture. Only an exact not-found answer for the
// name and region asked is `missing`; the other-region hint is `elsewhere`; everything else, an unknown flag and a
// not-found answer about another region included, is never `missing` (F4).
import { describe, expect, test } from "bun:test"
import { classify, failure } from "../../src/boxd/errors-table.js"

/** The CLI's words, as boxd 0.2.29, 0.3.3 and 0.3.5 printed them (docs/architecture.md), and clap's. */
const FIXTURES = {
  missing03: 'error: no machine "oc-review-api" in fra\n',
  missing02: "error: VM 'oc-review-api' not found\n",
  elsewhere: 'error: no machine "oc-review-api" in fra\nThere is a machine named "oc-review-api" in nyc; pass --region nyc.\n',
  otherRegion: 'error: no machine "oc-review-api" in fra\n',
  unknownFlag: "error: unexpected argument '--frobnicate' found\n\n  tip: to pass '--frobnicate' as a value, use '-- --frobnicate'\n",
  unknownRegion: 'error: unknown region "ams"\n',
  agent: "error: cannot connect to VM agent: connection refused\n",
  signIn: "Not logged in. Let's fix that.\n\n  Was not able to launch a web browser\n  Please go to this URL manually and complete the sign-in:\n",
  sizeOnRestore: "error: the argument '--vcpu <VCPU>' cannot be used with '--from-snapshot <FROM_SNAPSHOT>'\n\nUsage: boxd machine new --vcpu <VCPU> [NAME]\n",
  limit: "error: your org has reached its machine limit (2 machines in fra). Ask for more with `boxd manage machine-limit request --max-vms <n>`.\n",
  quota: "error: 8 vCPU exceeds your org's size quota (4 vCPU)\n",
} as const

describe("classify", () => {
  test("a not-found answer for the name and region asked is missing, on 0.3 and on 0.2", () => {
    expect(classify(FIXTURES.missing03, { machine: "oc-review-api", region: "fra" })).toEqual({ kind: "missing" })
    expect(classify(FIXTURES.missing02, { machine: "oc-review-api", region: "fra" })).toEqual({ kind: "missing" })
  })

  test("the CLI's hint for a name in another region is elsewhere, with that region", () => {
    expect(classify(FIXTURES.elsewhere, { machine: "oc-review-api", region: "fra" })).toEqual({ kind: "elsewhere", region: "nyc" })
  })

  test("a not-found answer about another region than the one asked is not missing (F4)", () => {
    expect(classify(FIXTURES.otherRegion, { machine: "oc-review-api", region: "nyc" })).toEqual({ kind: "unknown" })
  })

  test("a not-found answer for another machine is not missing", () => {
    expect(classify(FIXTURES.missing03, { machine: "oc-review", region: "fra" })).toEqual({ kind: "unknown" })
    expect(classify(FIXTURES.missing03, {})).toEqual({ kind: "unknown" })
  })

  test("an unknown flag or an unknown region is never missing (F4)", () => {
    expect(classify(FIXTURES.unknownFlag, { machine: "oc-review-api", region: "fra" })).toEqual({ kind: "unknown" })
    expect(classify(FIXTURES.unknownRegion, { machine: "oc-review-api", region: "fra" })).toEqual({ kind: "unknown" })
  })

  test("the other cases each have their own kind", () => {
    expect(classify(FIXTURES.agent).kind).toBe("agent-silent")
    expect(classify(FIXTURES.signIn).kind).toBe("auth")
    expect(classify(FIXTURES.sizeOnRestore).kind).toBe("size-on-restore")
    expect(classify(FIXTURES.limit).kind).toBe("limit")
    expect(classify(FIXTURES.quota).kind).toBe("quota")
  })
})

describe("failure", () => {
  test("each kind has its code, and the kind and region ride in details", () => {
    const of = (output: string, asked = { machine: "oc-review-api", region: "fra" as const }) => {
      const error = failure("boxd machine get", output, asked)
      return [error.code, error.details.kind, error.details.region]
    }
    expect(of(FIXTURES.missing03)).toEqual(["BOXD_FAILED", "missing", undefined])
    expect(of(FIXTURES.elsewhere)).toEqual(["BOXD_FAILED", "elsewhere", "nyc"])
    expect(of(FIXTURES.agent)).toEqual(["AGENT_UNREACHABLE", "agent-silent", undefined])
    expect(of(FIXTURES.signIn)).toEqual(["BOXD_MISSING", "auth", undefined])
    expect(of(FIXTURES.limit)).toEqual(["MACHINE_LIMIT", "limit", undefined])
    expect(of(FIXTURES.quota)).toEqual(["SIZE_UNAVAILABLE", "quota", undefined])
    expect(of(FIXTURES.unknownFlag)).toEqual(["BOXD_FAILED", "unknown", undefined])
  })

  test("the CLI's words reach the message as one redacted line", () => {
    const error = failure("boxd machine get", "error: token sk-abcdefghijklmnop rejected\nmore\n")
    expect(error.what).toBe("boxd machine get failed (error: token [redacted] rejected).")
    expect(failure("boxd machine get", FIXTURES.missing03, { machine: "oc-review-api", region: "fra" }).what).toBe('boxd found no machine oc-review-api in fra (error: no machine "oc-review-api" in fra).')
  })
})
