// source-contract's conformance kit over the boxd.works source, run on the plugin's own tools RPC methods `events_list`
// and `probe` (`sourceMethods`, as setup registers them), over a real event log (`EventLog`, src/ledger/events.ts) in a
// temp ledger, written from test/fixtures/conformance.json. Its rotation size is small, so the log has already
// dropped its first events and an old cursor meets the ledger's own `cursorExpired`. No boxd CLI, no network. Each
// method asserts its action through the kit's recording permission, as the host's `ctx.permission.assert` would.
// `npm run conformance` writes the report (reports/conformance-report.json); test/unit/sources.test.ts asserts it.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sourceConformance, type ConformanceReport, type PageCase, type SessionContext, type ToolDeclaration } from "@we-the-rebel-alliance/source-contract/conformance"
import { encodeBoundCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import { readInstalledDescriptor } from "@we-the-rebel-alliance/source-contract/descriptor"
import { SOURCES_SCHEMA, type Sources } from "@we-the-rebel-alliance/source-contract/schema"
import type { PluginMethod, ToolCall } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { EventLog, type NewEvent } from "../../src/ledger/events.js"
import type { ImportState, WorkEvent } from "../../src/ports.js"
import { workList } from "../../src/fleet/status.js"
import { encodeWorksCursor, identityOf, PACKAGE, SOURCE, sourceMethods, type LocalIdentity, type SourceDeps } from "../../src/sources.js"
import { TOOLS } from "../../src/tools.js"
import { TOOLS_RPC_ID } from "../../src/tools-rpc.js"

export const ROOT = join(import.meta.dir, "..", "..")

export interface Fixture {
  readonly now: string
  readonly user: string
  readonly host: string
  readonly rotateBytes: number
  readonly events: readonly NewEvent[]
}

export const FIXTURE = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "conformance.json"), "utf8")) as Fixture

/** A temp ledger folder whose event log holds the fixture's events, rotated as the fixture's size says. */
export async function fixtureLog(fixture: Fixture = FIXTURE): Promise<{ readonly log: EventLog; readonly kept: readonly WorkEvent[]; readonly cleanup: () => void }> {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "boxd-sources-"))
  const log = new EventLog(dir, { rotateBytes: fixture.rotateBytes, now: () => new Date(fixture.now) })
  for (const event of fixture.events) await log.append(event)
  const kept = (await log.since(0)).events
  return { log, kept, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const COMPLETE: ImportState = { state: "complete", works: 3, blocked: [] }

/** The source's deps over one event log: the published ledger, this fixture's computer and user, and its clock. */
export function fixtureDeps(log: EventLog, fixture: Fixture = FIXTURE, overrides: Partial<SourceDeps> = {}): SourceDeps {
  const identity: LocalIdentity = identityOf(fixture.user, fixture.host)
  return {
    ledger: { eventsSince: (cursor) => log.since(cursor) },
    importV0: { state: () => COMPLETE },
    identity: () => identity,
    now: () => new Date(fixture.now),
    ...overrides,
  }
}

export const call = (): ToolCall => ({ sessionID: "ses_conformance", agent: "build", messageID: "msg_conformance", id: "call_conformance", signal: new AbortController().signal, progress: async () => {} })

/** The plugin's tools RPC methods, as describe lists them: the thirteen tools and the source's two reads. */
export function declaredTools(deps: SourceDeps): ToolDeclaration[] {
  const source = sourceMethods(deps, async () => {})
  return [...TOOLS.map((tool) => ({ id: tool.id, readOnly: tool.readOnly })), ...source.map((method) => ({ id: method.name, readOnly: method.class === "read" }))]
}

/** package.json's sources, as Memory's schema parses them for the kit; first read as a consumer reads the install. */
export function declaredSources(): Sources {
  const installed = readInstalledDescriptor(ROOT)
  if (!installed.ok) throw new Error(`package.json's sources: ${installed.problems.join("; ")}`)
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { sources: unknown }
  const checked = SOURCES_SCHEMA.check(pkg.sources)
  if (!checked.ok) throw new Error(`package.json's sources: ${checked.problems.join("; ")}`)
  return checked.value
}

/** The kit's report for boxd.works. */
export async function conformanceReports(fixture: Fixture = FIXTURE): Promise<ConformanceReport[]> {
  const sources = declaredSources()
  const { log, kept, cleanup } = await fixtureLog(fixture)
  try {
    const deps = fixtureDeps(log, fixture)
    const identity = deps.identity()
    const account = identity.account
    // The methods assert into whichever kit session is calling.
    let current: SessionContext["permission"] | undefined
    const methods = sourceMethods(deps, async (request) => {
      if (current === undefined) throw new Error("an assert ran outside a kit call")
      await current.assert({ action: request.action, resources: [...(request.resources ?? [])] })
    })
    const run = (method: PluginMethod) => (input: Readonly<Record<string, unknown>>, context: SessionContext) => {
      current = context.permission
      return method.run(input, call()).finally(() => (current = undefined))
    }
    const [list, probe] = methods as [PluginMethod, PluginMethod]
    const oldest = kept[0]!
    const newest = kept[kept.length - 1]!
    if (oldest.seq <= 1) throw new Error("the fixture's log has not rotated: lower rotateBytes, so an old cursor expires")
    const keptSince = kept[1]!.at
    const other = "other-mac"
    const cases: PageCase[] = [
      {
        name: "the works since a time the log still keeps, with the events of a work whose id is shaped like an API key refused",
        input: { source: SOURCE, account, since: keptSince },
      },
      { name: "the same, two at a time", input: { source: SOURCE, account, since: keptSince, limit: 2 } },
      { name: "the newest cursor lists nothing, and still answers a cursor", input: { cursor: encodeWorksCursor(account, { q: newest.seq, t: newest.at }) }, expect: "empty" },
      {
        name: "a window that starts before the oldest kept event says once that the history before it is gone",
        input: { since: "2026-11-15T00:00:00Z", limit: 3 },
      },
      {
        name: "a cursor the log has rotated away answers a gap and reads on from the oldest kept event",
        input: { cursor: encodeWorksCursor(account, { q: 1, t: fixture.events[0]!.at! }) },
        expect: "expired",
      },
      {
        name: "a cursor of another ledger, newer than this log, answers a gap too",
        input: { cursor: encodeWorksCursor(account, { q: newest.seq + 50, t: newest.at }) },
        expect: "expired",
      },
      { name: "another computer's account is refused", input: { account: other, since: keptSince }, expect: { refuses: "ACCOUNT_MISMATCH" } },
      { name: "another computer's cursor is refused", input: { cursor: encodeWorksCursor(other, { q: oldest.seq, t: oldest.at }) }, expect: { refuses: "CURSOR_INVALID" } },
      {
        name: "a cursor bound to another plugin is refused",
        input: { cursor: encodeBoundCursor({ plugin: "jobs", source: SOURCE, account }, { q: oldest.seq, t: oldest.at }) },
        expect: { refuses: "CURSOR_INVALID" },
      },
      { name: "a scope is refused: this source has none", input: { scope: { works: ["fix-auth"] } }, expect: { refuses: "INPUT_INVALID" } },
      { name: "a source boxd does not have is refused", input: { source: "machines" }, expect: { refuses: "SOURCE_UNKNOWN" } },
    ]
    const report = await sourceConformance({
      plugin: PACKAGE,
      source: sources.items[0]!,
      tools: declaredTools(deps),
      calls: { list: run(list), probe: run(probe) },
      cases,
      account,
      sources: { rpc: sources.rpc, probe: sources.probe },
      describe: { id: TOOLS_RPC_ID },
      atomicPages: {
        reason:
          "a page is one read of the local event log, where a line is read whole or not at all (a line cut off by a crash was never an event), so no single event can fail on its own",
      },
    })
    const listed = sources.items.find((item) => item.id === "boxd.works.list")
    if (listed === undefined) throw new Error("package.json must declare boxd.works.list")
    const snapshot = await sourceConformance({
      plugin: PACKAGE,
      source: listed,
      tools: declaredTools(deps),
      calls: {
        snapshot: async (input, context) => {
          await context.permission.assert({ action: "boxd_status", resources: ["*"] })
          const account = typeof input["account"] === "string" ? input["account"] : undefined
          return workList(
            [{ workId: "fix-auth", region: null, phase: "ready", outcome: null, saved: "fresh" }],
            account,
            fixture.now,
          )
        },
        probe: run(probe),
      },
      snapshotCases: [{ ...(listed.input ?? {}), account }],
      cases: [],
      account,
      sources: { rpc: sources.rpc, probe: sources.probe },
      describe: { id: TOOLS_RPC_ID },
    })
    return [report, snapshot]
  } finally {
    cleanup()
  }
}
