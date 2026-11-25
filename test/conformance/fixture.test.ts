// The recorded conformance fixture against the plugin's own handlers: the page, the probe, the works list snapshot and
// the status answer in fixtures/conformance.json are what the handlers answer, and every non-read method records the
// input the contract's RPC confirmation check is refused with.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { statusAnswer } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { manifest, PACKAGE, VERSION } from "../../src/manifest.js"
import { listWorks, probeWorks } from "../../src/handlers/events.js"
import { worksSnapshot } from "../../src/status.js"
import type { WorkBrief } from "../../src/results.js"
import type { WorkEvent } from "../../src/ports.js"

const fixture = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "fixtures", "conformance.json"), "utf8"))
const owner = { id: "os-user:ana@studio", label: "ana on studio" }
const identity = () => ({ id: owner.id, label: owner.label })
const now = () => new Date("2026-11-16T10:00:00.000Z")
const events: readonly WorkEvent[] = [
  { seq: 1, at: "2026-11-16T09:30:00.000Z", workId: "review-api", from: null, to: "ready" },
  { seq: 2, at: "2026-11-16T09:40:00.000Z", workId: "review-api", from: "ready", to: "busy" },
  { seq: 3, at: "2026-11-16T09:50:00.000Z", workId: "review-api", from: "busy", to: "idle", outcome: "completed" },
]
const ledger = { eventsSince: async (q: number) => ({ events: events.filter((event) => event.seq > q), cursor: 3, cursorExpired: false }) }
const deps = { ledger, identity, now }
const works: readonly WorkBrief[] = [
  { workId: "review-api", region: "fra", phase: "idle", outcome: "completed", saved: "fresh", lastActivityAt: "2026-11-16T09:50:00.000Z" },
  { workId: "docs", region: "nyc", phase: "asleep", outcome: null, saved: "stale", lastActivityAt: "2026-11-15T18:00:00.000Z" },
]

describe("the recorded conformance fixture", () => {
  test("is the installed package's, and declares no plugin-held accounts", () => {
    expect(fixture.plugin).toBe(PACKAGE)
    expect(fixture).not.toHaveProperty("accounts")
    expect(fixture.namespace).toBe(manifest.plugin.summary)
  })

  test("records the page, the probe and the snapshot the handlers answer", async () => {
    const page = await listWorks(deps, fixture.sources["boxd.works"].cases[0].input)
    expect(page).toEqual(fixture.sources["boxd.works"].cases[0].answer)
    expect(probeWorks(deps, { source: "works" })).toEqual(fixture.sources["boxd.works"].probe.answer)
    expect(worksSnapshot({ asOf: "2026-11-16T10:00:00.000Z", works } as never)).toEqual(fixture.sources["boxd.works.list"].snapshot.answer)
  })

  test("records the status answer the contract's statusAnswer builds", () => {
    const answer = statusAnswer({ manifest, version: VERSION, hostVersion: "2.4.1", accounts: [], problems: [], unguardedAgents: { ok: true, agents: [] } })
    expect(answer).toEqual(fixture.events.status)
  })

  test("records an input for every non-read method, the contract's RPC confirmation uses", () => {
    const nonRead = Object.entries(manifest.methods)
      .filter(([, item]) => item.class !== "read" && !item.commits)
      .map(([method]) => method)
      .sort()
    expect(Object.keys(fixture.rpc.inputs).sort()).toEqual(nonRead)
  })

  test("declares the one emitted bus event", () => {
    expect(fixture.events.emitted).toEqual(["changed"])
    expect(Object.keys(manifest.events)).toEqual(["changed"])
  })
})
