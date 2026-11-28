// Package C1 on the fake boxd CLI and the fake guest (design §7.1): the ensure state machine (new, adopt, wake,
// resize when idle, upgrade when idle, the VM agent's reboot once, the fresh probe of a starting machine), acting by
// id, regions and MACHINE_LIMIT, the budget, the creation flags, golden builds and their scrub, reassign, resume, and
// the §4.4 spawn budgets of ensure.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseImageName } from "../../src/fleet/golden.js"
import { warmImageName } from "../../src/fleet/warm.js"
import type { WorkRecord } from "../../src/ledger/types.js"
import { repositoryHash } from "../../src/names.js"
import type { EnsureResult, ListResult, OrphanResult, Refusal, ResumeResult, GoldenResult } from "../../src/results.js"
import { budgetProblems, SPAWN_BUDGETS } from "../support/spawn-count.js"
import { startKit, VERSION, workRecord, type Kit } from "../support/machines-kit.js"

setDefaultTimeout(60_000)

const kits: Kit[] = []
afterEach(async () => {
  for (const kit of kits.splice(0)) await kit.dispose()
})
async function kit(input: Parameters<typeof startKit>[0] = {}) {
  const made = await startKit(input)
  kits.push(made)
  return made
}

const IMAGE = `oc-golden-${VERSION}-2x8`
const REPO = "https://github.com/we-the-rebel-alliance/boxd-plugin"
const WARM = warmImageName("oc-golden", REPO, VERSION, "2x8")
const row = (call: string, scenario: string) => SPAWN_BUDGETS.find((entry) => entry.call === call && entry.scenario.startsWith(scenario))!
const errorOf = async (promise: Promise<unknown>) =>
  promise.then(
    (value) => {
      throw new Error(`expected a refusal, got ${JSON.stringify(value)}`)
    },
    (error: { code?: string; what?: string; details?: Record<string, unknown> }) => error,
  )

/** A machine labelled as this plugin's, with the helper already on it, as an earlier ensure leaves it. */
async function owned(k: Kit, workId: string, over: Parameters<Kit["counter"]["fake"]["machine"]>[0] extends infer T ? Partial<T> : never = {}) {
  const ledger = await k.services.ledger.id({ call: { callId: "owned", source: "boxd_ensure" } })
  const machine = k.counter.fake.machine({ name: `oc-${workId}`, region: "fra", labels: { owner: "boxd", role: "session", work: workId, ledger }, ...over })
  await k.install(machine.region, machine.name, machine.id)
  return machine
}

/** A work the ledger knows, on a machine it owns. */
async function known(k: Kit, workId: string, record: Partial<WorkRecord> = {}, machine: Parameters<typeof owned>[2] = {}) {
  const { status, ...rest } = machine as { status?: string }
  const made = await owned(k, workId, rest)
  // The helper's install is an exec, which boxd answers by waking the machine: the status is set after it.
  if (status) k.counter.fake.update((state) => { state.machines.find((entry) => entry.id === made.id)!.status = status })
  await k.write(workRecord(workId, { region: made.region, machineId: made.id as never, laptopDirectory: k.project, ...record }))
  return made
}

describe("boxd_ensure: a new work", () => {
  test("auto picks a region, creates from the golden image with the cost bounds, records the id, and answers ready within its spawn budget", async () => {
    const k = await kit()
    await k.golden("fra")
    // The limit and snapshot caches are warm, as the budget's scenario says.
    await k.services.boxd.machineLimit({ call: { callId: "warm", source: "boxd_status" } })
    await k.services.boxd.snapshots({ call: { callId: "warm", source: "boxd_status" } })
    k.reset()
    const call = k.call()
    const result = (await k.runs.boxd_ensure({ workId: "review-api" }, call)) as EnsureResult
    expect(result).toMatchObject({ state: "ready", workId: "review-api", machine: "oc-review-api", region: "fra", size: "2x8", image: IMAGE, created: true, guestVersion: VERSION })
    expect(result.next).toContain('boxd_submit({ workId: "review-api"')
    const created = k.calls().find((entry) => entry.startsWith("machine new"))!
    expect(created).toContain("--from-snapshot " + IMAGE)
    expect(created).toContain("--auto-suspend-timeout 0 --auto-hibernate-timeout 7200 --idle-ignore-outbound=off")
    const ledger = await k.services.ledger.id({ call: { callId: "id", source: "boxd_ensure" } })
    expect(ledger).toMatch(/^[0-9a-f]{10}$/)
    expect(created).toContain(`--label ledger=${ledger} --label owner=boxd --label role=session --label work=review-api`)
    expect(created).not.toContain("--delete-after")
    expect(created).not.toContain("--vcpu")
    const record = await k.record("review-api")
    expect(record).toMatchObject({ state: "open", region: "fra", machineId: result.machineId, size: "2x8", image: { name: IMAGE, opencode: VERSION }, laptopDirectory: k.project })
    expect(record?.pendingCreate).toBeUndefined()
    expect(budgetProblems(row("boxd_ensure", "a new work"), k.counter.count(call.id))).toEqual([])
    expect(k.counter.untagged()).toEqual([])
    // The machine the fake made has the image's size; nothing resized it.
    expect(k.calls().some((entry) => entry.startsWith("machine resize"))).toBe(false)
  })

  test("leaseDays adds --delete-after, and the bounds come from the options whatever the access level", async () => {
    const k = await kit({ options: { leaseDays: 3, autoHibernateMinutes: 60, access: "read-only" } })
    await k.golden("fra")
    k.reset()
    await k.runs.boxd_ensure({ workId: "leased", region: "fra" }, k.call())
    const created = k.calls().find((entry) => entry.startsWith("machine new"))!
    expect(created).toContain("--auto-suspend-timeout 0 --auto-hibernate-timeout 3600 --idle-ignore-outbound=off --delete-after 3d")
    expect((await k.record("leased"))?.lease?.days).toBe(3)
  })

  test("no image and buildGolden never: GOLDEN_MISSING, and nothing is created", async () => {
    const k = await kit({ options: { buildGolden: "never" } })
    const error = await errorOf(k.runs.boxd_ensure({ workId: "x" }, k.call()))
    expect(error.code).toBe("GOLDEN_MISSING")
    expect(k.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
  })

  test("no image and buildGolden auto: the image is built first, then the work is created from it", async () => {
    const k = await kit()
    const result = (await k.runs.boxd_ensure({ workId: "fresh", region: "nyc" }, k.call())) as EnsureResult
    expect(result).toMatchObject({ state: "ready", region: "nyc", image: IMAGE, created: true })
    const news = k.calls().filter((entry) => entry.startsWith("machine new"))
    expect(news[0]).toMatch(/^machine new oc-gb-nyc-2x8-[0-9a-f]{6} --region nyc --vcpu 2 --label role=golden-builder --delete-after 2h --json$/)
    expect(news[1]).toContain(`machine new oc-fresh --region nyc --from-snapshot ${IMAGE}`)
  })

  test("B for a single call: an ensure whose image is still building answers creating, and the next call joins that build", async () => {
    let bound = 300
    const k = await kit({ seam: { boundMs: () => bound } })
    const first = (await k.runs.boxd_ensure({ workId: "slow", region: "fra" }, k.call())) as EnsureResult
    expect(first).toMatchObject({ state: "creating", machineId: null, created: false })
    expect(first.next).toContain('boxd_ensure({ workId: "slow" })')
    // The next calls, with room for a create, join the same build: one builder only, then the work is made from its image.
    bound = 120_000
    let result: EnsureResult | undefined
    for (let tries = 0; tries < 60 && result?.state !== "ready"; tries++) {
      result = (await k.runs.boxd_ensure({ workId: "slow", region: "fra" }, k.call())) as EnsureResult
      if (result.state !== "ready") await Bun.sleep(200)
    }
    expect(result).toMatchObject({ state: "ready", created: true })
    expect(k.calls().filter((entry) => entry.startsWith("machine new oc-gb-"))).toHaveLength(1)
  })

  test("B for a list: an item still waiting answers creating, and next repeats each pending item with its whole input", async () => {
    const k = await kit({ seam: { boundMs: 300 } })
    const list = (await k.runs.boxd_ensure({ works: [{ workId: "first", region: "fra", model: "anthropic/claude-sonnet-4-5" }, { workId: "second", region: "fra" }] }, k.call())) as ListResult<EnsureResult>
    expect(list.state).toBe("failed")
    expect(list.results.map((entry) => entry.state)).toEqual(["creating", "creating"])
    expect((list.results[0] as EnsureResult).next).toBe('boxd_ensure({ works: [{"workId":"first","region":"fra","model":"anthropic/claude-sonnet-4-5"}, {"workId":"second","region":"fra"}] })')
    // Both items waited for one build of the image.
    await Bun.sleep(100)
    expect(k.calls().filter((entry) => entry.startsWith("machine new oc-gb-"))).toHaveLength(1)
  })

  test("env: the declared names are checked, recorded without values, and sent to the guest's setup", async () => {
    const k = await kit()
    for (const env of [["gh_token"], ["OPENCODE_PASSWORD"], "GH_TOKEN", [1], Array.from({ length: 65 }, (_, index) => `VAR_${index}`)]) {
      expect(await errorOf(k.runs.boxd_ensure({ workId: "review-api", env }, k.call()))).toMatchObject({ code: "NAME_INVALID", details: { field: "env" } })
    }
    expect(k.calls()).toEqual([])
    await k.golden("fra")
    const result = (await k.runs.boxd_ensure({ workId: "review-api", env: ["TAVILY_API_KEY", "GH_TOKEN", "GH_TOKEN"] }, k.call())) as EnsureResult
    expect(result.state).toBe("ready")
    expect((await k.record("review-api"))?.env).toEqual(["GH_TOKEN", "TAVILY_API_KEY"])
    const machine = k.counter.fake.read().machines.find((entry) => entry.name === "oc-review-api")!
    expect(JSON.parse(readFileSync(join(k.counter.fake.disk(machine), "home/boxd/.boxd-plugin/env.json"), "utf8"))).toEqual(["GH_TOKEN", "TAVILY_API_KEY"])
    // A later ensure without env keeps the declaration, and an empty list withdraws it.
    await k.runs.boxd_ensure({ workId: "review-api" }, k.call())
    expect((await k.record("review-api"))?.env).toEqual(["GH_TOKEN", "TAVILY_API_KEY"])
    await k.runs.boxd_ensure({ workId: "review-api", env: [] }, k.call())
    expect((await k.record("review-api"))?.env).toEqual([])
    expect(JSON.parse(readFileSync(join(k.counter.fake.disk(machine), "home/boxd/.boxd-plugin/env.json"), "utf8"))).toEqual([])
  })

  test("a list: one bad item fails validation before anything runs, and results come back in input order", async () => {
    const k = await kit()
    const bad = await errorOf(k.runs.boxd_ensure({ works: [{ workId: "a" }, { workId: "b", size: "3x9" }] }, k.call()))
    expect(bad).toMatchObject({ code: "NAME_INVALID", details: { field: "works[1].size" } })
    expect(k.calls()).toEqual([])
    const twice = await errorOf(k.runs.boxd_ensure({ works: [{ workId: "a" }, { workId: "a" }] }, k.call()))
    expect(twice).toMatchObject({ code: "NAME_INVALID", details: { field: "works[1].workId" } })

    await k.golden("fra")
    k.counter.fake.machine({ name: "oc-b", region: "fra", labels: { team: "other" } })
    const list = (await k.runs.boxd_ensure({ works: [{ workId: "a", region: "fra" }, { workId: "b" }, { workId: "c", region: "fra" }] }, k.call())) as ListResult<EnsureResult>
    expect(list.state).toBe("partial")
    expect(list.results.map((entry) => [(entry as EnsureResult).workId, entry.state])).toEqual([
      ["a", "ready"],
      ["b", "refused"],
      ["c", "ready"],
    ])
    expect(list.counts).toEqual({ ready: 2, refused: 1 })
  })

  test("MACHINE_LIMIT: every region full answers with each region's limit, inUse and free, and creates nothing", async () => {
    const k = await kit()
    await k.golden("all")
    k.counter.fake.update((state) => { state.limits = { fra: 1, nyc: 1 } })
    k.counter.fake.machine({ name: "oc-one", region: "fra" })
    k.counter.fake.machine({ name: "oc-two", region: "nyc" })
    k.reset()
    const error = (await k.runs.boxd_ensure({ workId: "three", wait: "none" }, k.call()).then(
      () => undefined,
      (caught) => caught,
    )) as { code: string; details: { limit: unknown } }
    expect(error.code).toBe("MACHINE_LIMIT")
    expect(error.details.limit).toEqual([
      { region: "fra", limit: 1, inUse: 1, free: 0 },
      { region: "nyc", limit: 1, inUse: 1, free: 0 },
    ])
    expect(k.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
  })

  test("keepFree steers auto to the other region", async () => {
    const k = await kit({ options: { keepFree: { fra: 299 } } })
    await k.golden("all")
    const result = (await k.runs.boxd_ensure({ workId: "steered" }, k.call())) as EnsureResult
    expect(result.region).toBe("nyc")
  })

  test("a reached budget with refuse answers BUDGET_REACHED before any create", async () => {
    const k = await kit({ options: { budget: { daily: 50, action: "refuse" } } })
    await k.golden("fra")
    k.budgetReached = true
    k.reset()
    const error = await errorOf(k.runs.boxd_ensure({ workId: "costly" }, k.call()))
    expect(error).toMatchObject({ code: "BUDGET_REACHED", details: { today: 51, daily: 50, currency: "EUR" } })
    expect(k.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
  })
})

describe("boxd_ensure: adoption (L-b)", () => {
  test("an oc-<id> with the plugin's labels is adopted, its id read with one get, within the adoption budget", async () => {
    const k = await kit()
    const machine = await owned(k, "found")
    k.reset()
    const call = k.call()
    const result = (await k.runs.boxd_ensure({ workId: "found" }, call)) as EnsureResult
    expect(result).toMatchObject({ state: "ready", machineId: machine.id, created: false, adopted: true })
    expect((await k.record("found"))?.machineId as string | null | undefined).toBe(machine.id)
    expect(budgetProblems(row("boxd_ensure", "adopting"), k.counter.count(call.id))).toEqual([])
  })

  test("an oc-<id> with the plugin's labels but no ledger label gets only the ledger label", async () => {
    const k = await kit()
    const machine = await owned(k, "older", { labels: { owner: "boxd", role: "session", work: "older" } })
    k.reset()
    const result = (await k.runs.boxd_ensure({ workId: "older" }, k.call())) as EnsureResult
    expect(result).toMatchObject({ state: "ready", machineId: machine.id, adopted: true })
    const ledger = await k.services.ledger.id({ call: { callId: "id", source: "boxd_ensure" } })
    expect(k.calls().filter((entry) => entry.startsWith("machine label"))).toEqual([`machine label set ${machine.id} ledger ${ledger} --region fra`])
  })

  test("an oc-<id> that carries another ledger's label is refused NOT_OURS and keeps it; adopt: true takes it over", async () => {
    const k = await kit()
    const labels = { owner: "boxd", role: "session", work: "theirs", ledger: "ffffffffff" }
    const machine = await owned(k, "theirs", { labels })
    const labelsOf = () => k.counter.fake.read().machines.find((entry) => entry.id === machine.id)?.labels
    const error = await errorOf(k.runs.boxd_ensure({ workId: "theirs" }, k.call()))
    expect(error.code).toBe("NOT_OURS")
    expect(error.what).toContain("another ledger")
    expect(k.calls().filter((entry) => entry.startsWith("machine label"))).toEqual([])
    expect(labelsOf()).toMatchObject({ ledger: "ffffffffff" })
    const adopted = (await k.runs.boxd_ensure({ workId: "theirs", adopt: true }, k.call())) as EnsureResult
    expect(adopted).toMatchObject({ state: "ready", machineId: machine.id, adopted: true })
    expect(labelsOf()).toMatchObject({ ledger: await k.services.ledger.id({ call: { callId: "id", source: "boxd_ensure" } }) })
  })

  test("an oc-<id> without the labels is refused NOT_OURS, with no setup, clone or resize; adopt: true takes it over", async () => {
    const k = await kit()
    const machine = k.counter.fake.machine({ name: "oc-stranger", region: "fra", labels: { team: "data" } })
    const error = await errorOf(k.runs.boxd_ensure({ workId: "stranger", repo: "https://github.com/o/r", size: "4x16" }, k.call()))
    expect(error.code).toBe("NOT_OURS")
    expect(k.calls().filter((entry) => !entry.startsWith("machine list"))).toEqual([])
    const adopted = (await k.runs.boxd_ensure({ workId: "stranger", adopt: true }, k.call())) as EnsureResult
    expect(adopted).toMatchObject({ state: "ready", machineId: machine.id, adopted: true })
    expect(k.counter.fake.read().machines.find((entry) => entry.id === machine.id)?.labels).toMatchObject({ owner: "boxd", role: "session", work: "stranger", team: "data", ledger: await k.services.ledger.id({ call: { callId: "id", source: "boxd_ensure" } }) })
  })

  test("two regions holding oc-<id> answer NOT_OURS naming both", async () => {
    const k = await kit()
    k.counter.fake.machine({ name: "oc-twin", region: "fra", labels: { owner: "boxd" } })
    k.counter.fake.machine({ name: "oc-twin", region: "nyc", labels: { owner: "boxd" } })
    const error = await errorOf(k.runs.boxd_ensure({ workId: "twin" }, k.call()))
    expect(error.code).toBe("NOT_OURS")
    expect(error.what).toContain("fra and nyc")
  })

  test("a create that landed after its intent was recorded is adopted by the next ensure", async () => {
    const k = await kit()
    await k.write(workRecord("landed", { pendingCreate: { at: new Date().toISOString(), image: IMAGE } }))
    const machine = await owned(k, "landed")
    const result = (await k.runs.boxd_ensure({ workId: "landed" }, k.call())) as EnsureResult
    expect(result).toMatchObject({ state: "ready", machineId: machine.id, created: false })
    expect((await k.record("landed"))?.pendingCreate).toBeUndefined()
  })
})

describe("boxd_ensure select orphans", () => {
  /** An orphan machine with the helper installed and a checkout in its work folder, as an operator's own session leaves it. */
  async function seeded(k: Kit, workId: string, labels: Record<string, string>, options: { status?: string; remote?: string; session?: { busy: boolean; needsInput?: boolean } } = {}) {
    const machine = k.counter.fake.machine({ name: `oc-${workId}`, region: "fra", labels })
    await k.install(machine.region, machine.name, machine.id)
    if (options.status) k.counter.fake.update((state) => { state.machines.find((entry) => entry.id === machine.id)!.status = options.status! })
    const directory = join(k.counter.fake.disk(machine), "home/boxd/work", workId)
    Bun.spawnSync(["git", "-C", directory, "init", "--quiet"])
    writeFileSync(join(directory, "README.md"), `# ${workId}\n`)
    Bun.spawnSync(["git", "-C", directory, "add", "."])
    Bun.spawnSync(["git", "-C", directory, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "init"])
    if (options.remote) Bun.spawnSync(["git", "-C", directory, "remote", "add", "origin", options.remote])
    if (options.session) {
      k.guest.sessions.set(`ses_${workId}`, { id: `ses_${workId}`, busy: options.session.busy, directory: `/home/boxd/work/${workId}`, messages: [], inbox: [], updated: Date.now() })
      if (options.session.needsInput) k.guest.pending.set(`ses_${workId}`, "permission")
      // The guest's describe reads root sessions from the OpenCode store; the fake server only answers the live state.
      const store = join(k.counter.fake.disk(machine), "home/boxd/.local/share/opencode")
      mkdirSync(store, { recursive: true })
      const db = new Database(join(store, "opencode.db"))
      db.run("create table session_v2 (id text, parent_id text, directory text, time_busy integer, time_idle integer)")
      db.run("insert into session_v2 values (?, ?, ?, ?, ?)", [`ses_${workId}`, null, `/home/boxd/work/${workId}`, options.session.busy ? 2 : null, options.session.busy ? null : 2])
      db.close()
    }
    return machine
  }

  test("adopts the busy and idle orphans only, with their records and labels, and touches neither tree nor server", async () => {
    const k = await kit({ options: { keep: ["team=lead"] } })
    const busy = await seeded(k, "busy", { owner: "boxd", role: "session", work: "busy" }, { remote: "https://github.com/o/busy", session: { busy: true } })
    const idle = await seeded(k, "idle", { owner: "boxd", role: "session", work: "idle" }, { remote: "https://github.com/o/idle", session: { busy: false } })
    k.counter.fake.machine({ name: "oc-theirs", region: "fra", labels: { owner: "boxd", role: "session", work: "theirs", ledger: "ffffffffff" } })
    k.counter.fake.machine({ name: "lead-boxd", region: "fra", labels: { team: "lead" } })
    k.counter.fake.machine({ name: "oc-not-a-session", region: "fra", labels: {} })
    const before = new Map([busy, idle].map((machine) => [machine.id, readFileSync(join(k.counter.fake.disk(machine), ".opencode-version"), "utf8")]))
    k.reset()
    const started = Date.now()
    const result = (await k.runs.boxd_ensure({ select: "orphans" }, k.call())) as ListResult<OrphanResult>
    expect(result.select).toBe("orphans")
    expect(result.results.filter((item) => item.state === "adopted").map((item) => [(item as OrphanResult).workId, (item as OrphanResult).why])).toEqual([
      ["busy", "busy; adopted and left running"],
      ["idle", "idle; adopted and left running"],
    ])
    const ledger = await k.services.ledger.id({ call: { callId: "id", source: "boxd_ensure" } })
    const records = await Promise.all([k.record("busy"), k.record("idle")])
    expect(records[0]).toMatchObject({
      state: "open",
      region: "fra",
      machineId: busy.id,
      guestDirectory: "/home/boxd/work/busy",
      repo: { url: "https://github.com/o/busy" },
      session: { rootId: "ses_busy" },
      adopted: { from: "orphan" },
    })
    expect(records[1]).toMatchObject({ machineId: idle.id, guestDirectory: "/home/boxd/work/idle", session: { rootId: "ses_idle" } })
    const labels = new Map(k.counter.fake.read().machines.map((machine) => [machine.id, machine.labels]))
    for (const [machine, workId] of [[busy, "busy"], [idle, "idle"]] as const) {
      expect(labels.get(machine.id)).toMatchObject({ owner: "boxd", role: "session", work: workId, ledger })
    }
    expect(labels.get("vm_0003")).toEqual({ owner: "boxd", role: "session", work: "theirs", ledger: "ffffffffff" })
    expect(labels.get("vm_0004")).toEqual({ team: "lead" })
    expect(labels.get("vm_0005")).toEqual({})
    // No setup, clone, upgrade, resize or wake ran: the only guest action is describe.
    expect(k.counter.fake.spawns().filter((spawn) => spawn.startedAt >= started && spawn.action).map((spawn) => spawn.action)).toEqual(["describe", "describe"])
    expect(k.calls().some((call) => /^machine (new|cp|resize|reboot|wake|hibernate)/.test(call))).toBe(false)
    for (const machine of [busy, idle]) expect(readFileSync(join(k.counter.fake.disk(machine), ".opencode-version"), "utf8")).toBe(before.get(machine.id) ?? "")
    // The machines stay running, as adopted.
    expect(k.counter.fake.read().machines.filter((machine) => [busy.id, idle.id].includes(machine.id)).every((machine) => machine.status === "running")).toBe(true)

    k.reset()
    const againStarted = Date.now()
    const again = (await k.runs.boxd_ensure({ select: "orphans" }, k.call())) as ListResult<OrphanResult>
    expect(again.results.filter((item) => item.state === "adopted")).toEqual([])
    expect(k.calls().some((call) => call.startsWith("machine label"))).toBe(false)
    expect(k.counter.fake.spawns().filter((spawn) => spawn.startedAt >= againStarted && spawn.action)).toEqual([])
  })

  test("a shared orphan and an isolated orphan are skipped, with no labels from this ledger and no record", async () => {
    const k = await kit()
    const labels = { owner: "boxd", role: "session" }
    const shared = k.counter.fake.machine({ name: "oc-shared", region: "fra", labels: { ...labels, work: "shared" }, sharing: "shared" })
    const isolated = k.counter.fake.machine({ name: "oc-isolated", region: "fra", labels: { ...labels, work: "isolated" }, isolated: true })
    k.reset()
    const result = (await k.runs.boxd_ensure({ select: "orphans" }, k.call())) as ListResult<OrphanResult>
    const byWork = new Map(result.results.map((item) => [(item as OrphanResult).workId, item as OrphanResult]))
    expect(byWork.get("shared")).toMatchObject({ state: "skipped", machine: "oc-shared", why: "it is shared with the organisation" })
    expect(byWork.get("isolated")).toMatchObject({ state: "skipped", machine: "oc-isolated", why: "it is isolated" })
    const after = new Map(k.counter.fake.read().machines.map((machine) => [machine.id, machine.labels]))
    expect(after.get(shared.id)).toEqual({ owner: "boxd", role: "session", work: "shared" })
    expect(after.get(isolated.id)).toEqual({ owner: "boxd", role: "session", work: "isolated" })
    expect(await k.record("shared")).toBeUndefined()
    expect(await k.record("isolated")).toBeUndefined()
    expect(k.calls().some((call) => call.startsWith("machine label"))).toBe(false)
  })

  test("a describe that fails is skipped with its error, and no record is written", async () => {
    const k = await kit()
    k.counter.fake.machine({ name: "oc-unready", region: "fra", labels: { owner: "boxd", role: "session", work: "unready" } })
    const result = (await k.runs.boxd_ensure({ select: "orphans" }, k.call())) as ListResult<OrphanResult>
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({ state: "skipped", machine: "oc-unready", workId: "unready", error: "GUEST_FAILED" })
    expect((result.results[0] as OrphanResult).why).toContain("describe failed")
    expect(await k.record("unready")).toBeUndefined()
    expect(k.calls().some((call) => call.startsWith("machine label"))).toBe(false)
  })

  test("a hibernated orphan is woken to be read, then adopted with nothing else changed", async () => {
    const k = await kit()
    const machine = await seeded(k, "sleepy", { owner: "boxd", role: "session", work: "sleepy" }, { status: "hibernated" })
    k.reset()
    const started = Date.now()
    const result = (await k.runs.boxd_ensure({ select: "orphans" }, k.call())) as ListResult<OrphanResult>
    expect(result.results[0]).toMatchObject({ state: "adopted", machine: "oc-sleepy", workId: "sleepy" })
    expect(k.calls()).toContain(`machine wake ${machine.id} --region fra --json`)
    expect(k.counter.fake.read().machines.find((entry) => entry.id === machine.id)?.status).toBe("running")
    expect(k.counter.fake.spawns().filter((spawn) => spawn.startedAt >= started && spawn.action).map((spawn) => spawn.action)).toEqual(["describe"])
  })
})

describe("boxd_ensure: an existing work converges", () => {
  test("asleep: woken by id after the by-id check, then set up", async () => {
    const k = await kit()
    const machine = await known(k, "napper", {}, { status: "hibernated" })
    k.reset()
    const result = (await k.runs.boxd_ensure({ workId: "napper" }, k.call())) as EnsureResult
    expect(result).toMatchObject({ state: "ready", created: false })
    const calls = k.calls()
    expect(calls.indexOf(`machine get oc-napper --region fra --json`)).toBeLessThan(calls.indexOf(`machine wake ${machine.id} --region fra --json`))
    expect(k.counter.fake.read().wokenByExec ?? []).toEqual([])
  })

  test("another size: resized by id when the session is idle; SESSION_BUSY and no resize when it runs", async () => {
    const k = await kit()
    const machine = await known(k, "grow", { session: { rootId: "ses_grow" } })
    k.guest.sessions.set("ses_grow", { id: "ses_grow", busy: true, directory: "/home/boxd/work/grow", messages: [], inbox: [], updated: Date.now() })
    const busy = await errorOf(k.runs.boxd_ensure({ workId: "grow", size: "4x16" }, k.call()))
    expect(busy.code).toBe("SESSION_BUSY")
    expect(k.calls().some((entry) => entry.startsWith("machine resize"))).toBe(false)
    k.guest.idle("ses_grow")
    const result = (await k.runs.boxd_ensure({ workId: "grow", size: "4x16" }, k.call())) as EnsureResult
    expect(result).toMatchObject({ state: "ready", size: "4x16" })
    expect(k.calls()).toContain(`machine resize ${machine.id} --vcpu 4 -y --region fra --json`)
  })

  test("another OpenCode on the guest: upgraded in place while idle, left alone while busy", async () => {
    const k = await kit()
    const machine = await known(k, "older", { session: { rootId: "ses_older" } })
    writeFileSync(join(k.counter.fake.disk(machine), ".opencode-version"), "2.4.3\n")
    k.guest.sessions.set("ses_older", { id: "ses_older", busy: true, directory: "/home/boxd/work/older", messages: [], inbox: [], updated: Date.now() })
    const busy = (await k.runs.boxd_ensure({ workId: "older" }, k.call())) as EnsureResult
    expect(busy.upgraded).toBeUndefined()
    expect(busy.guestVersion).toBe("2.4.3")
    k.guest.idle("ses_older")
    const idle = (await k.runs.boxd_ensure({ workId: "older" }, k.call())) as EnsureResult
    expect(idle).toMatchObject({ upgraded: true, guestVersion: VERSION })
    expect(readFileSync(join(k.counter.fake.disk(machine), ".opencode-version"), "utf8").trim()).toBe(VERSION)
  })

  test("a silent VM agent after the plugin's resize is rebooted once; the next silence answers AGENT_UNREACHABLE; repair reboots", async () => {
    const k = await kit()
    const machine = await known(k, "quiet")
    k.counter.fake.update((state) => { state.resizeSilencesAgent = true })
    const resized = (await k.runs.boxd_ensure({ workId: "quiet", size: "4x16" }, k.call())) as EnsureResult
    expect(resized).toMatchObject({ state: "ready", rebooted: true })
    expect(k.calls().filter((entry) => entry === `machine reboot ${machine.id} --region fra --json`)).toHaveLength(1)
    expect((await k.record("quiet"))?.reboots).toEqual([expect.objectContaining({ why: "agent-silent" })])

    // The agent goes silent again; the plugin changed nothing since its own reboot, so it does not reboot by itself.
    k.counter.fake.update((state) => { state.machines.find((entry) => entry.id === machine.id)!.agentSilent = true })
    k.reset()
    const silent = await errorOf(k.runs.boxd_ensure({ workId: "quiet" }, k.call()))
    expect(silent.code).toBe("AGENT_UNREACHABLE")
    expect(k.calls().some((entry) => entry.startsWith("machine reboot"))).toBe(false)

    const repaired = (await k.runs.boxd_ensure({ workId: "quiet", repair: "reboot" }, k.call())) as EnsureResult
    expect(repaired).toMatchObject({ state: "ready", rebooted: true })
    expect((await k.record("quiet"))?.reboots?.map((reboot) => reboot.why)).toEqual(["agent-silent", "repair"])
  })

  test("a starting guest answers starting, and the next call probes it fresh rather than repeating a cached starting", async () => {
    const k = await kit({ seam: { readyMs: 800 } })
    await known(k, "warmup")
    // Nothing answers on the guest's port: the server is down, so setup starts it and the wait sees it still coming up.
    const port = k.counter.fake.read().port
    k.counter.fake.update((state) => { state.port = 9 })
    const first = (await k.runs.boxd_ensure({ workId: "warmup" }, k.call())) as EnsureResult
    expect(first.state).toBe("starting")
    expect(first.next).toContain('boxd_ensure({ workId: "warmup" })')
    k.counter.fake.update((state) => { state.port = port })
    k.reset()
    const second = (await k.runs.boxd_ensure({ workId: "warmup" }, k.call())) as EnsureResult
    expect(second.state).toBe("ready")
    expect(k.calls().some((entry) => entry.startsWith("machine exec oc-warmup"))).toBe(true)
  })

  test("acting by id: oc-<id> now pointing at another machine answers NOT_OURS, and nothing is resized or rebooted", async () => {
    const k = await kit()
    const machine = await known(k, "moved")
    // Someone removed the work's machine and made another under the same name.
    k.counter.fake.update((state) => { state.machines.find((entry) => entry.id === machine.id)!.status = "destroyed" })
    k.counter.fake.machine({ name: "oc-moved", region: "fra", labels: { owner: "boxd", work: "moved" } })
    k.reset()
    const error = await errorOf(k.runs.boxd_ensure({ workId: "moved", size: "4x16", repair: "reboot" }, k.call()))
    expect(error.code).toBe("NOT_OURS")
    expect(k.calls().filter((entry) => /^machine (resize|reboot|wake|exec|rename|remove)/.test(entry))).toEqual([])
  })

  test("the model path records the root of the calling session's tree as the work's coordinator", async () => {
    const k = await kit()
    await known(k, "led")
    k.parents.set("ses_subagent", "ses_middle")
    k.parents.set("ses_middle", "ses_root")
    await k.runs.boxd_ensure({ workId: "led" }, k.call({ sessionID: "ses_subagent", via: "model" }))
    expect((await k.record("led"))?.session?.notify).toBe("ses_root")
    // A script's ensure leaves the subscription as it was.
    await k.runs.boxd_ensure({ workId: "led" }, k.call({ sessionID: "ses_script", via: "rpc" }))
    expect((await k.record("led"))?.session?.notify).toBe("ses_root")
  })
})

describe("boxd_ensure: a work acts only with the identity it was given", () => {
  const GIVEN = "bxds_0123456789abcdef"
  const REAL = "operators-own-value"
  const LOGIN = ["oauth", "token"].join("_")
  const AWS = ["AWS", "SECRET", "ACCESS", "KEY"].join("_")
  const FIELD = ["pass", "word"].join("")
  const integration = (k: Kit, machine: { id: string }) => {
    // What boxd's git integration does on a private machine: git is handed a GitHub login for github.com.
    const helper = `"!f() { echo username=operator; echo ${FIELD}=${REAL}; }; f"`
    writeFileSync(join(k.counter.fake.disk(machine as never), "home/boxd/.gitconfig"), `[credential "https://github.com"]\n\thelper = ${helper}\n`)
  }
  const refused = async (k: Kit, workId: string) => {
    k.reset()
    const error = await errorOf(k.runs.boxd_ensure({ workId }, k.call()))
    expect(error.code).toBe("ACTS_AS_OPERATOR")
    return error as { what: string }
  }

  test("a work whose GitHub identity would be the operator's, through the git integration, is refused with the reason", async () => {
    const k = await kit()
    const machine = await known(k, "as-owner")
    integration(k, machine)
    const error = await refused(k, "as-owner")
    expect(error.what).toContain("git is given a GitHub login for github.com")
    expect(error.what).not.toContain(REAL)
    expect((await k.record("as-owner"))?.session).toBeUndefined()
  })

  test("a raw GitHub token is refused by name, and the value is never said", async () => {
    const k = await kit()
    await known(k, "raw-token")
    k.counter.fake.update((state) => { state.guestEnv = { GH_TOKEN: REAL } })
    const error = await refused(k, "raw-token")
    expect(error.what).toContain("GH_TOKEN is a real GitHub credential")
    expect(error.what).not.toContain(REAL)
  })

  test("a real model key, a cloud key and the operator's gh login are each refused", async () => {
    const k = await kit()
    const machine = await known(k, "many")
    k.counter.fake.update((state) => { state.guestEnv = { ANTHROPIC_API_KEY: REAL, AWS_SECRET_ACCESS_KEY: REAL } })
    mkdirSync(join(k.counter.fake.disk(machine), "home/boxd/.config/gh"), { recursive: true })
    writeFileSync(join(k.counter.fake.disk(machine), "home/boxd/.config/gh/hosts.yml"), `github.com:\n  ${LOGIN}: ${REAL}\n`)
    const error = await refused(k, "many")
    expect(error.what).toContain("ANTHROPIC_API_KEY is a real model credential")
    expect(error.what).toContain("AWS_SECRET_ACCESS_KEY is a real cloud credential")
    expect(error.what).toContain("holds a GitHub login")
  })

  test("a work given placeholders bound to one host passes", async () => {
    const k = await kit()
    await known(k, "given")
    k.counter.fake.update((state) => { state.guestEnv = { GH_TOKEN: GIVEN, ANTHROPIC_API_KEY: GIVEN, AWS_SECRET_ACCESS_KEY: GIVEN } })
    const result = (await k.runs.boxd_ensure({ workId: "given" }, k.call())) as EnsureResult
    expect(result).toMatchObject({ state: "ready", workId: "given" })
  })

  test("a real token in boxd's variables file is refused, and a placeholder there passes", async () => {
    const k = await kit()
    const machine = await known(k, "profile")
    const file = join(k.counter.fake.disk(machine), "etc/profile.d/boxd-env.sh")
    mkdirSync(join(k.counter.fake.disk(machine), "etc/profile.d"), { recursive: true })
    // The helper runs without a login shell, so nothing of this is in its own environment.
    writeFileSync(file, `export GH_TOKEN='${REAL}'\nexport ANTHROPIC_API_KEY='${GIVEN}'\n`)
    const error = await refused(k, "profile")
    expect(error.what).toContain("GH_TOKEN is a real GitHub credential")
    expect(error.what).not.toContain("ANTHROPIC_API_KEY")
    expect(error.what).not.toContain(REAL)
    writeFileSync(file, `export GH_TOKEN='${GIVEN}'\nexport ANTHROPIC_API_KEY='${GIVEN}'\n`)
    expect(await k.runs.boxd_ensure({ workId: "profile" }, k.call())).toMatchObject({ state: "ready", workId: "profile" })
  })

  test("each line of a git credentials file must be a placeholder", async () => {
    const k = await kit()
    const machine = await known(k, "lines")
    const home = join(k.counter.fake.disk(machine), "home/boxd")
    writeFileSync(join(home, ".git-credentials"), `https://app:${GIVEN}@github.com\n${REAL}\n`)
    const error = await refused(k, "lines")
    expect(error.what).toContain(".git-credentials holds a GitHub login")
    expect(error.what).not.toContain(REAL)
  })

  test("a work given the App's placeholder through git, gh's login or a stored credential passes", async () => {
    const k = await kit()
    const machine = await known(k, "app")
    const home = join(k.counter.fake.disk(machine), "home/boxd")
    // gh's credential helper with a placeholder GH_TOKEN hands git the placeholder as its password.
    const helper = `"!f() { echo username=app; echo ${FIELD}=${GIVEN}; }; f"`
    writeFileSync(join(home, ".gitconfig"), `[credential "https://github.com"]\n\thelper = ${helper}\n`)
    mkdirSync(join(home, ".config/gh"), { recursive: true })
    writeFileSync(join(home, ".config/gh/hosts.yml"), `github.com:\n  ${LOGIN}: ${GIVEN}\n`)
    writeFileSync(join(home, ".git-credentials"), `https://app:${GIVEN}@github.com\nhttps://${GIVEN}@github.com\n`)
    mkdirSync(join(home, ".aws"), { recursive: true })
    writeFileSync(join(home, ".aws/credentials"), `[default]\n${AWS}=${GIVEN}\n`)
    const result = (await k.runs.boxd_ensure({ workId: "app" }, k.call())) as EnsureResult
    expect(result).toMatchObject({ state: "ready", workId: "app" })
  })

  test("a real value in a stored credential is still refused beside a placeholder", async () => {
    const k = await kit()
    const machine = await known(k, "mixed")
    const home = join(k.counter.fake.disk(machine), "home/boxd")
    writeFileSync(join(home, ".git-credentials"), `https://app:${GIVEN}@github.com\nhttps://operator:${REAL}@github.com\n`)
    const error = await refused(k, "mixed")
    expect(error.what).toContain(".git-credentials holds a GitHub login")
    expect(error.what).not.toContain(REAL)
  })

  test("a stored login in a form that is not a placeholder is refused, whatever its shape", async () => {
    const k = await kit()
    const machine = await known(k, "shapes")
    const home = join(k.counter.fake.disk(machine), "home/boxd")
    // A token as the user name, with nothing after it: GitHub accepts it.
    writeFileSync(join(home, ".git-credentials"), `https://${REAL}@github.com\n`)
    // The AWS tools read option names without regard to case.
    mkdirSync(join(home, ".aws"), { recursive: true })
    writeFileSync(join(home, ".aws/credentials"), `[default]\n${AWS}=${REAL}\n`)
    // A file the check cannot read as a placeholder is refused rather than passed.
    mkdirSync(join(home, ".config/gh"), { recursive: true })
    writeFileSync(join(home, ".config/gh/hosts.yml"), "github.com:\n  user: operator\n")
    const error = await refused(k, "shapes")
    expect(error.what).toContain(".git-credentials holds a GitHub login")
    expect(error.what).toContain(".aws/credentials holds a cloud login")
    expect(error.what).toContain("hosts.yml holds a GitHub login")
    expect(error.what).not.toContain(REAL)
  })

  test("a new work is made, then refused at setup before it is cloned or its server started", async () => {
    const k = await kit()
    await k.golden("fra")
    k.counter.fake.update((state) => { state.guestEnv = { GITHUB_TOKEN: REAL } })
    const error = await errorOf(k.runs.boxd_ensure({ workId: "fresh", repo: "https://github.com/we-the-rebel-alliance/example" }, k.call()))
    expect(error.code).toBe("ACTS_AS_OPERATOR")
    const machine = k.counter.fake.read().machines.find((entry) => entry.name === "oc-fresh")!
    expect(existsSync(join(k.counter.fake.disk(machine), "home/boxd/work/fresh"))).toBe(false)
  })
})

describe("boxd_golden (design §2.3, §3.11)", () => {
  test("builds from stock with the recipe, removes the builder, and warns when no provider key is set", async () => {
    const k = await kit()
    const built = (await k.runs.boxd_golden({ region: "fra" }, k.call())) as GoldenResult
    expect(built).toMatchObject({ state: "built", images: [{ region: "fra", name: IMAGE, opencode: VERSION, size: "2x8" }], warning: "NO_MODEL_CREDENTIAL" })
    const state = k.counter.fake.read()
    const builder = state.machines.find((machine) => machine.name.startsWith("oc-gb-fra-2x8-"))!
    expect(builder).toMatchObject({ status: "destroyed", labels: { role: "golden-builder" }, deleteAfter: "2h" })
    const image = state.snapshots.find((snapshot) => snapshot.name === IMAGE)!
    // The helper is in the image; the password and the work folders are not.
    expect(existsSync(join(image.disk!, "home/boxd/.boxd-plugin/guest.py"))).toBe(true)
    expect(existsSync(join(image.disk!, "home/boxd/.boxd-plugin/password"))).toBe(false)
    expect(existsSync(join(image.disk!, "home/boxd/work"))).toBe(false)

    expect(await k.runs.boxd_golden({ region: "fra" }, k.call())).toMatchObject({ state: "present" })
    k.reset()
    expect(await k.runs.boxd_golden({ region: "fra", rebuild: true }, k.call())).toMatchObject({ state: "built" })
    expect(k.calls().filter((entry) => entry.startsWith("snapshots save"))).toHaveLength(1)
  })

  test("no warning when a provider key is among the sealed secrets; with no input every region is built", async () => {
    const k = await kit()
    k.counter.fake.update((state) => { state.secrets = [{ name: "ANTHROPIC_API_KEY", scope: "private", domains: ["api.anthropic.com"] }] })
    const built = (await k.runs.boxd_golden({}, k.call())) as GoldenResult
    expect(built.warning).toBeUndefined()
    expect(built.images.map((image) => image.region)).toEqual(["fra", "nyc"])
  })

  test("a base holding auth.json is refused GOLDEN_HAS_CREDENTIAL with the supported ways, and its builder is removed", async () => {
    const k = await kit()
    const disk = join(k.counter.fake.dir, "base-with-key")
    mkdirSync(join(disk, "home/boxd/.local/share/opencode"), { recursive: true })
    writeFileSync(join(disk, "home/boxd/.local/share/opencode/auth.json"), "{}")
    k.counter.fake.snapshot({ region: "fra", name: "team-base", disk })
    const error = await errorOf(k.runs.boxd_golden({ region: "fra", from: "team-base" }, k.call()))
    expect(error.code).toBe("GOLDEN_HAS_CREDENTIAL")
    expect((error as { next?: string }).next).toContain("host-bound boxd env secret")
    expect(k.counter.fake.read().snapshots.some((snapshot) => snapshot.name === IMAGE)).toBe(false)
    expect(k.counter.fake.read().machines.filter((machine) => machine.status !== "destroyed")).toEqual([])
  })

  test("a base whose OpenCode holds a session fails GOLDEN_BUILD_FAILED; a base in another region too", async () => {
    const k = await kit()
    k.counter.fake.snapshot({ region: "fra", name: "used-machine" })
    k.guest.sessions.set("ses_old", { id: "ses_old", busy: false, directory: "/home/boxd/work/x", messages: [], inbox: [], updated: Date.now() })
    expect((await errorOf(k.runs.boxd_golden({ region: "fra", from: "used-machine" }, k.call()))).code).toBe("GOLDEN_BUILD_FAILED")
    const elsewhere = await errorOf(k.runs.boxd_golden({ region: "nyc", from: "used-machine" }, k.call()))
    expect(elsewhere.code).toBe("GOLDEN_BUILD_FAILED")
    expect(elsewhere.what).toContain("snapshots do not cross regions")
  })

  test("goldenSetup runs once on the builder before the scrub; a failing script fails the build; one outside the roots is refused", async () => {
    const script = (body: string) => (project: string) => {
      writeFileSync(join(project, "setup.sh"), body)
      return { goldenSetup: join(project, "setup.sh") }
    }
    const k = await kit({ optionsFor: script('mkdir -p "$HOME/.tools" && echo ok > "$HOME/.tools/marker"\n') })
    expect(await k.runs.boxd_golden({ region: "fra" }, k.call())).toMatchObject({ state: "built" })
    const image = k.counter.fake.read().snapshots.find((snapshot) => snapshot.name === IMAGE)!
    expect(readFileSync(join(image.disk!, "home/boxd/.tools/marker"), "utf8").trim()).toBe("ok")
    expect(existsSync(join(image.disk!, "home/boxd/.boxd-plugin-golden-setup.sh"))).toBe(false)

    const failing = await kit({ optionsFor: script("exit 3\n") })
    const error = await errorOf(failing.runs.boxd_golden({ region: "fra" }, failing.call()))
    expect(error.code).toBe("GOLDEN_BUILD_FAILED")
    expect(error.what).toContain("goldenSetup exited with 3")
    expect(failing.counter.fake.read().machines.filter((machine) => machine.status !== "destroyed")).toEqual([])

    // A script outside the project and allowedRoots is refused before any builder is made.
    const outside = await kit({ optionsFor: () => ({ goldenSetup: join(k.project, "setup.sh") }) })
    expect((await errorOf(outside.runs.boxd_golden({ region: "fra" }, outside.call()))).code).toBe("PATH_REFUSED")
    expect(outside.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
  })

  test("a warm image starts from the version image, runs warm and its setup in the checkout, then the scrub and the save", async () => {
    const k = await kit({
      optionsFor: (project) => {
        writeFileSync(join(project, "warm-setup.sh"), 'pwd > setup-pwd.txt\necho setup >> "$HOME/order.log"\n')
        return { warm: [{ repo: REPO, setup: join(project, "warm-setup.sh") }] }
      },
    })
    const built = (await k.runs.boxd_golden({ repo: REPO, region: "fra" }, k.call())) as GoldenResult
    expect(built).toMatchObject({ state: "built", images: [{ region: "fra", name: WARM, opencode: VERSION, size: "2x8", repo: REPO }] })
    const news = k.calls().filter((entry) => entry.startsWith("machine new"))
    // The version image first, from stock; then the warm builder from that image.
    expect(news[0]).toMatch(/^machine new oc-gb-fra-2x8-[0-9a-f]{6} --region fra --vcpu 2 --label role=golden-builder --delete-after 2h --json$/)
    expect(news[1]).toContain(`--from-snapshot ${IMAGE}`)
    const state = k.counter.fake.read()
    const image = state.snapshots.find((snapshot) => snapshot.name === WARM)!
    const key = createHash("sha256").update(REPO).digest("hex").slice(0, 16)
    const checkout = join(image.disk!, "home/boxd/.boxd-plugin/warm", key)
    expect(readFileSync(join(checkout, "warm.txt"), "utf8")).toContain(REPO)
    // The setup ran inside the checkout, after warm and before the scrub.
    expect(readFileSync(join(checkout, "setup-pwd.txt"), "utf8").trim().endsWith(`/.boxd-plugin/warm/${key}`)).toBe(true)
    expect(readFileSync(join(image.disk!, "home/boxd/order.log"), "utf8")).toBe("warm\nsetup\n")
    expect(existsSync(join(image.disk!, "home/boxd/.boxd-plugin-warm-setup.sh"))).toBe(false)
    expect(state.machines.filter((machine) => machine.status !== "destroyed")).toEqual([])
    // The image is present on the next call, and the version image is not rebuilt.
    k.reset()
    expect(await k.runs.boxd_golden({ repo: REPO, region: "fra" }, k.call())).toMatchObject({ state: "present", images: [{ name: WARM }] })
    expect(k.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
  })

  test("the name golden saves is the name ensure looks up, with .git on the URL", async () => {
    const url = `${REPO}.git`
    const k = await kit({ options: { warm: [{ repo: url }], regions: ["fra"], buildGolden: "never" } })
    const built = (await k.runs.boxd_golden({ repo: url, region: "fra" }, k.call())) as GoldenResult
    const image = built.images[0]!.name
    k.reset()
    const ensured = (await k.runs.boxd_ensure({ workId: "from-warm", repo: url, region: "fra" }, k.call())) as EnsureResult
    expect(ensured).toMatchObject({ state: "ready", image, warm: true, created: true })
    expect(await k.record("from-warm")).toMatchObject({ image: { name: image }, warm: true })
    expect(k.calls().find((entry) => entry.startsWith("machine new oc-from-warm"))).toContain(`--from-snapshot ${image}`)
    expect(k.calls().some((entry) => entry.startsWith("machine new oc-gb-"))).toBe(false)
  })

  test("a warm setup that exits non-zero fails GOLDEN_BUILD_FAILED at its step and removes the builder", async () => {
    const k = await kit({
      optionsFor: (project) => {
        writeFileSync(join(project, "warm-setup.sh"), "exit 7\n")
        return { warm: [{ repo: REPO, setup: join(project, "warm-setup.sh") }] }
      },
    })
    const error = await errorOf(k.runs.boxd_golden({ repo: REPO, region: "fra" }, k.call()))
    expect(error.code).toBe("GOLDEN_BUILD_FAILED")
    expect(error.details?.step).toBe("run the repository's setup")
    expect(error.what).toContain(`The setup for ${REPO} exited with 7`)
    const state = k.counter.fake.read()
    expect(state.machines.filter((machine) => machine.status !== "destroyed")).toEqual([])
    expect(state.snapshots.some((snapshot) => snapshot.name === WARM)).toBe(false)
  })

  test("a repository not in warm is refused NAME_INVALID before any call, and so is from or prune with repo", async () => {
    const k = await kit()
    const missing = await errorOf(k.runs.boxd_golden({ repo: REPO, region: "fra" }, k.call()))
    expect(missing).toMatchObject({ code: "NAME_INVALID", details: { field: "repo" } })
    expect(k.calls()).toEqual([])
    const configured = await kit({ optionsFor: () => ({ warm: [{ repo: REPO }] }) })
    expect(await errorOf(configured.runs.boxd_golden({ repo: REPO, from: "stock" }, configured.call()))).toMatchObject({ code: "NAME_INVALID", details: { field: "repo" } })
    expect(await errorOf(configured.runs.boxd_golden({ repo: REPO, prune: true }, configured.call()))).toMatchObject({ code: "NAME_INVALID", details: { field: "repo" } })
    expect(configured.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
  })

  test("a warm image's name carries its repository and hash, fits 64 characters, and parseImageName reads it back", () => {
    const long = "https://github.com/we-the-rebel-alliance/a-very-long-repository-name-that-keeps-going-and-going"
    const name = warmImageName("oc-golden", long, VERSION, "8x32")
    expect(name.length).toBeLessThanOrEqual(64)
    expect(name).toBe(name.toLowerCase())
    expect(parseImageName("oc-golden", name)).toEqual({ opencode: VERSION, size: "8x32", repo: { name: expect.any(String), hash: repositoryHash(long) } })
    expect(parseImageName("oc-golden", IMAGE)).toEqual({ opencode: VERSION, size: "2x8" })
    expect(parseImageName("oc-golden", "someone-elses")).toBeUndefined()
    // The URL's optional .git does not change the name.
    expect(warmImageName("oc-golden", `${REPO}.git`, VERSION, "2x8")).toBe(WARM)
  })

  test("prune removes unused images of other versions, never the current one or one an open work records", async () => {
    const k = await kit()
    k.counter.fake.snapshot({ region: "fra", name: "oc-golden-2.4.2-2x8" })
    k.counter.fake.snapshot({ region: "fra", name: "oc-golden-2.4.3-2x8" })
    k.counter.fake.snapshot({ region: "fra", name: IMAGE })
    k.counter.fake.snapshot({ region: "fra", name: "someone-elses" })
    await k.write(workRecord("keeper", { image: { name: "oc-golden-2.4.3-2x8", opencode: "2.4.3" } }))
    const result = (await k.runs.boxd_golden({ prune: true }, k.call())) as GoldenResult
    expect(result.state).toBe("pruned")
    expect(result.removed?.map((image) => image.name)).toEqual(["oc-golden-2.4.2-2x8"])
    expect(k.counter.fake.read().snapshots.map((snapshot) => snapshot.name).sort()).toEqual(["oc-golden-2.4.3-2x8", IMAGE, "someone-elses"].sort())
  })

  test("ensure picks only <prefix>-<version>-<size>: another snapshot is never a work's image", async () => {
    const k = await kit({ options: { buildGolden: "never" } })
    k.counter.fake.snapshot({ region: "fra", name: "my-work-saved" })
    k.counter.fake.snapshot({ region: "fra", name: `oc-golden-2.4.3-2x8` })
    expect((await errorOf(k.runs.boxd_ensure({ workId: "picky", region: "fra" }, k.call()))).code).toBe("GOLDEN_MISSING")
  })
})

describe("the regions option pins new placement", () => {
  test("an explicit region outside the allowlist is refused REGION_NOT_ALLOWED before any call, and nothing is created", async () => {
    const k = await kit({ options: { regions: ["fra"] } })
    k.counter.fake.snapshot({ region: "nyc", name: IMAGE })
    k.reset()
    const error = await errorOf(k.runs.boxd_ensure({ workId: "abroad", region: "nyc" }, k.call()))
    expect(error).toMatchObject({ code: "REGION_NOT_ALLOWED", details: { region: "nyc", allowed: ["fra"] } })
    expect(error.what).toContain('allows only "fra"')
    expect(k.calls()).toEqual([])
    expect(k.counter.fake.read().machines).toEqual([])
  })

  test("auto considers only allowed regions, even when another region has more free machines", async () => {
    const k = await kit({ options: { regions: ["fra"] } })
    await k.golden("fra")
    // nyc has far more free machines and already holds the image; the allowlist does not consider it.
    k.counter.fake.snapshot({ region: "nyc", name: IMAGE })
    const result = (await k.runs.boxd_ensure({ workId: "pinned" }, k.call())) as EnsureResult
    expect(result).toMatchObject({ state: "ready", region: "fra", created: true })
    expect(k.counter.fake.read().machines.filter((machine) => machine.region === "nyc")).toEqual([])
  })

  test("a full allowed region answers MACHINE_LIMIT with allowed rows only: no fallback to nyc", async () => {
    const k = await kit({ options: { regions: ["fra"] } })
    await k.golden("fra")
    k.counter.fake.snapshot({ region: "nyc", name: IMAGE })
    k.counter.fake.update((state) => { state.limits = { fra: 1, nyc: 300 } })
    k.counter.fake.machine({ name: "oc-one", region: "fra" })
    k.reset()
    const error = await errorOf(k.runs.boxd_ensure({ workId: "three", wait: "none" }, k.call()))
    expect(error).toMatchObject({ code: "MACHINE_LIMIT", details: { limit: [{ region: "fra", limit: 1, inUse: 1, free: 0 }] } })
    expect(error.what).toContain('The option "regions" allows only "fra", so no other region is tried')
    expect(k.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
    expect(k.counter.fake.read().machines.filter((machine) => machine.region === "nyc")).toEqual([])
  })

  test("keepFree applies inside the allowlist: an unlisted region with room is never the fallback", async () => {
    const k = await kit({ options: { regions: ["fra"], keepFree: { fra: 300 } } })
    await k.golden("fra")
    k.counter.fake.snapshot({ region: "nyc", name: IMAGE })
    k.reset()
    const error = await errorOf(k.runs.boxd_ensure({ workId: "kept" }, k.call()))
    expect(error.code).toBe("MACHINE_LIMIT")
    expect(error.what).toContain("keepFree holds back 300 in fra")
    expect(k.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
  })

  test("golden builds only in the allowlist, and an explicit region outside it answers REGION_NOT_ALLOWED", async () => {
    const k = await kit({ options: { regions: ["fra"] } })
    const built = (await k.runs.boxd_golden({}, k.call())) as GoldenResult
    expect(built.state).toBe("built")
    expect(built.images.map((image) => image.region)).toEqual(["fra"])
    expect(k.counter.fake.read().snapshots.filter((snapshot) => snapshot.name === IMAGE).map((snapshot) => snapshot.region)).toEqual(["fra"])
    k.reset()
    const error = await errorOf(k.runs.boxd_golden({ region: "nyc" }, k.call()))
    expect(error).toMatchObject({ code: "REGION_NOT_ALLOWED", details: { region: "nyc", allowed: ["fra"] } })
    expect(k.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
  })

  test("a work that already lives outside the allowlist still converges and resumes", async () => {
    const k = await kit({ options: { regions: ["fra"] } })
    const machine = await known(k, "abroad", {}, { region: "nyc" })
    k.reset()
    const ensured = (await k.runs.boxd_ensure({ workId: "abroad" }, k.call())) as EnsureResult
    expect(ensured).toMatchObject({ state: "ready", region: "nyc", created: false, machineId: machine.id })
    expect(k.calls().some((entry) => /^machine (new|wake)/.test(entry))).toBe(false)
    // Asleep: resume wakes it by id, in its own region, with no create.
    k.counter.fake.update((state) => { state.machines.find((entry) => entry.id === machine.id)!.status = "hibernated" })
    k.reset()
    const resumed = (await k.runs.boxd_resume({ workId: "abroad" }, k.call())) as ResumeResult
    expect(resumed).toMatchObject({ state: "ready", rebuilt: false, region: "nyc" })
    expect(k.calls()).toContain(`machine wake ${machine.id} --region nyc --json`)
    expect(k.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
  })

  test("a work whose machine is gone is rebuilt in its recorded region from its image there, even outside the allowlist", async () => {
    const k = await kit({ options: { regions: ["fra"] } })
    await k.golden("fra")
    k.counter.fake.snapshot({ region: "nyc", name: IMAGE })
    const machine = await known(k, "restored", {}, { region: "nyc" })
    k.counter.fake.update((state) => { state.machines.find((entry) => entry.id === machine.id)!.status = "destroyed" })
    k.reset()
    const result = (await k.runs.boxd_resume({ workId: "restored" }, k.call())) as ResumeResult
    expect(result).toMatchObject({ state: "ready", rebuilt: true, region: "nyc" })
    const created = k.calls().find((entry) => entry.startsWith("machine new"))
    expect(created).toContain("--region nyc")
    expect(created).toContain(`--from-snapshot ${IMAGE}`)
    // The image was there: no builder ran.
    expect(k.calls().some((entry) => entry.startsWith("machine new oc-gb-"))).toBe(false)
  })

  test("a gone machine outside the allowlist is rebuilt there even when its image is missing: the build is recovery", async () => {
    const k = await kit({ options: { regions: ["fra"] } })
    const machine = await known(k, "recovered", {}, { region: "nyc" })
    k.counter.fake.update((state) => { state.machines.find((entry) => entry.id === machine.id)!.status = "destroyed" })
    k.reset()
    const result = (await k.runs.boxd_resume({ workId: "recovered" }, k.call())) as ResumeResult
    expect(result).toMatchObject({ state: "ready", rebuilt: true, region: "nyc" })
    // A builder and its image in the work's own region, then the work's machine: not a REGION_NOT_ALLOWED refusal.
    expect(k.calls().find((entry) => entry.startsWith("machine new"))).toMatch(/^machine new oc-gb-nyc-2x8-[0-9a-f]{6} --region nyc /)
    expect(k.counter.fake.read().snapshots.filter((snapshot) => snapshot.name === IMAGE).map((snapshot) => snapshot.region)).toEqual(["nyc"])
    expect(k.calls().find((entry) => entry.startsWith("machine new oc-recovered"))).toContain("--region nyc")
    expect(k.counter.fake.read().machines.filter((entry) => entry.name.startsWith("oc-gb-") && entry.status !== "destroyed")).toEqual([])
  })

  test("a landed work outside the allowlist with no image and buildGolden never answers GOLDEN_MISSING, not REGION_NOT_ALLOWED", async () => {
    const k = await kit({ options: { regions: ["fra"], buildGolden: "never" } })
    const machine = await known(k, "bare", {}, { region: "nyc" })
    k.counter.fake.update((state) => { state.machines.find((entry) => entry.id === machine.id)!.status = "destroyed" })
    k.reset()
    const error = await errorOf(k.runs.boxd_resume({ workId: "bare" }, k.call()))
    expect(error.code).toBe("GOLDEN_MISSING")
    expect(error.what).toContain('Set it to "auto" so a resume builds the image there')
    expect(k.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
  })

  test("an explicit region on an existing work is checked against the allowlist, and otherwise ignored", async () => {
    const k = await kit({ options: { regions: ["fra"] } })
    const machine = await known(k, "settled")
    k.reset()
    const refused = await errorOf(k.runs.boxd_ensure({ workId: "settled", region: "nyc" }, k.call()))
    expect(refused).toMatchObject({ code: "REGION_NOT_ALLOWED", details: { region: "nyc", allowed: ["fra"] } })
    expect(k.calls()).toEqual([])
    const converged = (await k.runs.boxd_ensure({ workId: "settled", region: "fra" }, k.call())) as EnsureResult
    expect(converged).toMatchObject({ state: "ready", created: false, machineId: machine.id, region: "fra" })
  })

  test("a full recorded region on a resume rebuild names a next step resume can take, with its own row", async () => {
    const k = await kit({ options: { regions: ["fra"] } })
    k.counter.fake.snapshot({ region: "nyc", name: IMAGE })
    const machine = await known(k, "packed", {}, { region: "nyc" })
    k.counter.fake.update((state) => { state.limits = { nyc: 1 } })
    k.counter.fake.machine({ name: "oc-occupant", region: "nyc" })
    k.counter.fake.update((state) => { state.machines.find((entry) => entry.id === machine.id)!.status = "destroyed" })
    k.reset()
    const error = await errorOf(k.runs.boxd_resume({ workId: "packed" }, k.call()))
    expect(error).toMatchObject({
      code: "MACHINE_LIMIT",
      details: {
        limit: [
          { region: "fra", limit: 300, inUse: 0, free: 300 },
          // This call's own create is still in flight, so the row counts it on top of the listing's occupant.
          expect.objectContaining({ region: "nyc", limit: 1, free: 0 }),
        ],
      },
    })
    expect(error.what).toContain("This work is rebuilt in nyc")
    expect(error.what).toContain("free a machine there with boxd_drop or boxd_reassign")
    expect(error.what).not.toContain('pass region: "fra"')
    expect(k.counter.fake.read().machines.filter((entry) => entry.name === "oc-packed" && entry.status !== "destroyed")).toEqual([])
  })

  test("a prune covers a region outside the allowlist: deleting is not placement", async () => {
    const k = await kit({ options: { regions: ["fra"] } })
    k.counter.fake.snapshot({ region: "nyc", name: "oc-golden-2.4.2-2x8" })
    k.counter.fake.snapshot({ region: "fra", name: "oc-golden-2.4.4-2x8" })
    const one = (await k.runs.boxd_golden({ region: "nyc", prune: true }, k.call())) as GoldenResult
    expect(one.state).toBe("pruned")
    expect(one.removed?.map((image) => image.name)).toEqual(["oc-golden-2.4.2-2x8"])
    k.counter.fake.snapshot({ region: "nyc", name: "oc-golden-2.4.5-2x8" })
    k.reset()
    const all = (await k.runs.boxd_golden({ prune: true }, k.call())) as GoldenResult
    expect(all.state).toBe("pruned")
    expect(all.removed?.map((image) => `${image.region}/${image.name}`).sort()).toEqual(["fra/oc-golden-2.4.4-2x8", "nyc/oc-golden-2.4.5-2x8"])
    expect(k.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
  })

  test("a work with no recorded region picks its rebuild region from the allowlist", async () => {
    const k = await kit({ options: { regions: ["nyc"] } })
    await k.golden("nyc")
    await k.write(workRecord("homeless", { region: null, machineId: null, laptopDirectory: k.project, pendingCreate: { at: new Date().toISOString(), image: IMAGE } }))
    k.reset()
    const result = (await k.runs.boxd_resume({ workId: "homeless" }, k.call())) as ResumeResult
    expect(result).toMatchObject({ state: "ready", rebuilt: true, region: "nyc" })
    expect(k.calls().find((entry) => entry.startsWith("machine new"))).toContain("--region nyc")
    expect(k.counter.fake.read().machines.filter((entry) => entry.region === "fra")).toEqual([])
  })

  test("a claim that never landed outside the allowlist is refused: it is still new placement", async () => {
    const k = await kit({ options: { regions: ["fra"] } })
    k.counter.fake.snapshot({ region: "nyc", name: IMAGE })
    await k.write(workRecord("claimed", { region: "nyc", laptopDirectory: k.project, pendingCreate: { at: new Date().toISOString(), image: IMAGE } }))
    k.reset()
    const error = await errorOf(k.runs.boxd_ensure({ workId: "claimed" }, k.call()))
    expect(error).toMatchObject({ code: "REGION_NOT_ALLOWED", details: { region: "nyc", allowed: ["fra"] } })
    expect(k.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
    expect(k.counter.fake.read().machines.filter((machine) => machine.region === "nyc")).toEqual([])
    // Resume refuses it the same way: no machine ever landed there.
    const resumed = await errorOf(k.runs.boxd_resume({ workId: "claimed" }, k.call()))
    expect(resumed).toMatchObject({ code: "REGION_NOT_ALLOWED", details: { region: "nyc", allowed: ["fra"] } })
    expect(k.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
  })
})

describe("boxd_reassign (design §3.10)", () => {
  test("moves an unstarted work's machine to a new id by its machine id, closes from, and sets the new work up", async () => {
    const k = await kit()
    const machine = await known(k, "spare")
    k.reset()
    const result = (await k.runs.boxd_reassign({ from: "spare", to: "review-api", model: "anthropic/claude-sonnet-4-5", title: "Review the API" }, k.call())) as EnsureResult & { from: string }
    expect(result).toMatchObject({ from: "spare", workId: "review-api", machine: "oc-review-api", machineId: machine.id, created: false })
    expect(k.calls()).toContain(`machine rename ${machine.id} oc-review-api -y --region fra --json`)
    expect(k.calls()).toContain(`machine label set ${machine.id} work review-api --region fra`)
    expect(await k.record("spare")).toMatchObject({ state: "closed", closed: { how: "reassigned", to: "review-api" } })
    const moved = await k.record("review-api")
    expect(moved).toMatchObject({ state: "open", machineId: machine.id, model: "anthropic/claude-sonnet-4-5", title: "Review the API" })
    expect(moved?.pendingRename).toBeUndefined()
    expect(k.counter.fake.read().machines.find((entry) => entry.id === machine.id)).toMatchObject({ name: "oc-review-api", labels: { work: "review-api", ledger: await k.services.ledger.id({ call: { callId: "id", source: "boxd_ensure" } }) } })
  })

  test("refused NOT_REASSIGNABLE for a work with a session, uploaded files, a dirty tree, or an open to", async () => {
    const k = await kit()
    await known(k, "busy-one", { session: { rootId: "ses_x" } })
    await known(k, "files-one", { files: { in: [{ path: "a", bytes: 1, sha256: "0".repeat(64), at: new Date().toISOString() }], out: [] } })
    const dirty = await known(k, "dirty-one")
    const tree = join(k.counter.fake.disk(dirty), "home/boxd/work/dirty-one")
    mkdirSync(tree, { recursive: true })
    Bun.spawnSync(["git", "init", "--quiet", tree])
    writeFileSync(join(tree, "scratch.txt"), "x")
    await known(k, "taken")
    await known(k, "clean")
    for (const [from, to] of [["busy-one", "n1"], ["files-one", "n2"], ["dirty-one", "n3"], ["clean", "taken"]]) {
      expect({ from, code: (await errorOf(k.runs.boxd_reassign({ from, to }, k.call()))).code }).toEqual({ from, code: "NOT_REASSIGNABLE" })
    }
    expect(k.calls().some((entry) => entry.startsWith("machine rename"))).toBe(false)
  })

  test("acting by id: oc-<from> re-pointed to another machine answers NOT_OURS, and nothing is renamed", async () => {
    const k = await kit()
    const machine = await known(k, "repointed")
    k.counter.fake.update((state) => { state.machines.find((entry) => entry.id === machine.id)!.status = "destroyed" })
    k.counter.fake.machine({ name: "oc-repointed", region: "fra", labels: { owner: "boxd" } })
    k.reset()
    expect((await errorOf(k.runs.boxd_reassign({ from: "repointed", to: "other" }, k.call()))).code).toBe("NOT_OURS")
    expect(k.calls().filter((entry) => /^machine (rename|label)/.test(entry))).toEqual([])
    expect(await k.record("other")).toBeUndefined()
  })

  test("a reassign that stopped after writing to is finished by the next ensure of either id", async () => {
    for (const which of ["to", "from"] as const) {
      const k = await kit()
      const machine = await known(k, "half")
      await k.write(workRecord("whole", { region: "fra", machineId: machine.id as never, laptopDirectory: k.project, pendingRename: { from: "half", machineId: machine.id as never, at: new Date().toISOString() } }))
      if (which === "to") {
        const result = (await k.runs.boxd_ensure({ workId: "whole" }, k.call())) as EnsureResult
        expect(result).toMatchObject({ state: "ready", machine: "oc-whole", machineId: machine.id })
      } else {
        // The finish closes the from id first; its ensure then makes it a new work on a machine of its own.
        await k.golden("fra")
        const result = (await k.runs.boxd_ensure({ workId: "half" }, k.call())) as EnsureResult
        expect(result).toMatchObject({ state: "ready", created: true })
        expect(result.machineId).not.toBe(machine.id)
      }
      if (which === "to") expect(await k.record("half")).toMatchObject({ state: "closed", closed: { how: "reassigned", to: "whole" } })
      expect((await k.record("whole"))?.pendingRename).toBeUndefined()
      expect(k.counter.fake.read().machines.find((entry) => entry.id === machine.id)?.name).toBe("oc-whole")
    }
  })

  test("two opposite reassigns at once (L-h): one finishes, the other refuses, and neither waits on the other", async () => {
    const k = await kit()
    await known(k, "left")
    const t0 = Date.now()
    const [one, two] = await Promise.all([
      k.runs.boxd_reassign({ from: "left", to: "right" }, k.call()).then((value) => value, (error: { code?: string }) => error.code),
      k.runs.boxd_reassign({ from: "right", to: "left" }, k.call()).then((value) => value, (error: { code?: string }) => error.code),
    ])
    expect(one).toMatchObject({ from: "left", workId: "right" })
    expect(["NOT_OURS", "NOT_REASSIGNABLE"]).toContain(two as string)
    expect(Date.now() - t0).toBeLessThan(30_000)
  })
})

describe("boxd_resume (design §3.8)", () => {
  test("a hibernated machine is woken by id after the by-id check", async () => {
    const k = await kit()
    const machine = await known(k, "sleepy", { slept: { at: new Date().toISOString(), by: "boxd_sleep" } }, { status: "hibernated" })
    k.reset()
    const result = (await k.runs.boxd_resume({ workId: "sleepy" }, k.call())) as ResumeResult
    expect(result).toMatchObject({ state: "ready", rebuilt: false, machine: "oc-sleepy" })
    expect(k.calls()).toContain(`machine wake ${machine.id} --region fra --json`)
    expect((await k.record("sleepy"))?.slept).toBeUndefined()
  })

  test("a destroyed machine is rebuilt from its image after the two-check gone rule, and the saved transcript is imported", async () => {
    const k = await kit()
    await k.golden("fra")
    const machine = await known(k, "phoenix", {
      session: { rootId: "ses_phoenix" },
      saved: { at: new Date().toISOString(), complete: true, guestVersion: VERSION, sessions: [{ id: "ses_phoenix", parentId: null, sha256: "0".repeat(64), bytes: 10, lastMessageId: null, messages: 0, updated: 0 }] },
    })
    const folder = join(k.services.ledger.workFolder("phoenix"), "exports")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "ses_phoenix.json"), JSON.stringify({ info: { id: "ses_phoenix", title: "phoenix" }, messages: [] }))
    k.counter.fake.update((state) => { state.machines.find((entry) => entry.id === machine.id)!.status = "destroyed" })
    k.reset()
    const result = (await k.runs.boxd_resume({ works: ["phoenix"] }, k.call())) as ListResult<ResumeResult>
    expect(result).toMatchObject({ state: "done", results: [{ state: "ready", rebuilt: true }] })
    const calls = k.calls()
    // The gone rule: a fresh listing and a not-found get of the recorded id in every region, before the create.
    const first = calls.indexOf(`machine get ${machine.id} --region fra --json`)
    expect(calls.slice(first - 1, first + 2)).toEqual(["machine list --region all --json", `machine get ${machine.id} --region fra --json`, `machine get ${machine.id} --region nyc --json`])
    expect(calls.findIndex((entry) => entry.startsWith("machine new"))).toBeGreaterThan(first)
    expect(calls.find((entry) => entry.startsWith("machine new"))).toContain(`--from-snapshot ${IMAGE}`)
    expect(k.guest.imports.map((entry) => entry.id)).toEqual(["ses_phoenix"])
    const record = await k.record("phoenix")
    expect(record?.machineId).not.toBe(machine.id)
    expect(record?.session?.rootId).toBe("ses_phoenix")
  })

  test("a failed read is never gone: a get that fails other than not-found rebuilds nothing", async () => {
    const k = await kit()
    const machine = await known(k, "flaky")
    k.counter.fake.update((state) => { state.machines.find((entry) => entry.id === machine.id)!.status = "destroyed" })
    k.counter.fake.fault("machine get", { stderr: "error: upstream timeout" })
    k.reset()
    const error = await errorOf(k.runs.boxd_resume({ workId: "flaky" }, k.call()))
    expect(error.code).toBe("BOXD_FAILED")
    expect(k.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
  })

  test("a machine renamed by hand is found by its id, and answers NOT_OURS naming it", async () => {
    const k = await kit()
    const machine = await known(k, "renamed")
    k.counter.fake.update((state) => { state.machines.find((entry) => entry.id === machine.id)!.name = "oc-by-hand" })
    const error = await errorOf(k.runs.boxd_resume({ workId: "renamed" }, k.call()))
    expect(error.code).toBe("NOT_OURS")
    expect(error.what).toContain("oc-by-hand")
  })

  test("a reached budget with refuse answers BUDGET_REACHED before anything wakes", async () => {
    const k = await kit({ options: { budget: { daily: 1, action: "refuse" } } })
    await known(k, "frozen", {}, { status: "hibernated" })
    k.budgetReached = true
    k.reset()
    expect((await errorOf(k.runs.boxd_resume({ workId: "frozen" }, k.call()))).code).toBe("BUDGET_REACHED")
    expect(k.calls()).toEqual([])
  })

  test("an unknown work answers NOT_OURS", async () => {
    const k = await kit()
    const result = (await k.runs.boxd_resume({ works: ["nobody"] }, k.call())) as ListResult<ResumeResult>
    expect(result.results[0]).toMatchObject({ state: "refused", error: "NOT_OURS" } satisfies Partial<Refusal>)
  })
})

/** The next all-region listing answers as if the machines that exist had not shown up in it yet (boxd's listing lags). */
const lagListing = (k: Kit, times = 1) => {
  for (let index = 0; index < times; index++) k.counter.fake.fault("machine list", { stdout: "[]\n", stderr: "", code: 0 })
}
const named = (k: Kit, name: string) => k.counter.fake.read().machines.filter((machine) => machine.name === name && machine.status !== "destroyed")

describe("one machine per work, whatever the listing shows (review HIGH-1)", () => {
  test("a recorded create that landed in fra while the listing lags is adopted there, never made again in nyc", async () => {
    const k = await kit()
    await k.golden("all")
    k.counter.fake.update((state) => { state.limits = { fra: 5, nyc: 300 } })
    const landed = await owned(k, "lag")
    await k.write(workRecord("lag", { region: "fra", laptopDirectory: k.project, pendingCreate: { at: new Date().toISOString(), image: IMAGE } }))
    lagListing(k)
    k.reset()
    const result = (await k.runs.boxd_ensure({ workId: "lag" }, k.call())) as EnsureResult
    expect(result).toMatchObject({ state: "ready", region: "fra", machineId: landed.id, created: false, adopted: true })
    expect(named(k, "oc-lag")).toHaveLength(1)
    expect(k.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
    expect(k.calls()).toContain("machine get oc-lag --region fra --json")
    expect((await k.record("lag"))?.pendingCreate).toBeUndefined()
  })

  test("a create boxd refuses because the name is taken adopts the machine that holds it, never BOXD_FAILED", async () => {
    const k = await kit()
    await k.golden("fra")
    const landed = await owned(k, "taken")
    lagListing(k)
    const result = (await k.runs.boxd_ensure({ workId: "taken", region: "fra" }, k.call())) as EnsureResult
    expect(result).toMatchObject({ state: "ready", machineId: landed.id, created: false, adopted: true })
    expect(named(k, "oc-taken")).toHaveLength(1)
  })

  test("two ensures of one new work at once make one machine, and both answer it", async () => {
    const k = await kit()
    await k.golden("all")
    const [one, two] = (await Promise.all([k.runs.boxd_ensure({ workId: "twice" }, k.call()), k.runs.boxd_ensure({ workId: "twice" }, k.call())])) as EnsureResult[]
    expect(named(k, "oc-twice")).toHaveLength(1)
    expect(one!.machineId).toBe(two!.machineId)
    expect([one!.created, two!.created].sort()).toEqual([false, true])
  })

  test("boxd_resume of a work whose create landed while every listing lags adopts it rather than answering BOXD_FAILED", async () => {
    const k = await kit()
    await k.golden("fra")
    const landed = await owned(k, "late")
    await k.write(workRecord("late", { region: "fra", laptopDirectory: k.project, pendingCreate: { at: new Date().toISOString(), image: IMAGE } }))
    lagListing(k, 2)
    const result = (await k.runs.boxd_resume({ workId: "late" }, k.call())) as ResumeResult
    expect(result).toMatchObject({ state: "ready", rebuilt: false, region: "fra" })
    expect(named(k, "oc-late")).toHaveLength(1)
    expect((await k.record("late"))?.machineId as string | null | undefined).toBe(landed.id)
  })
})

describe("integration lows (C1)", () => {
  const getLags = (k: Kit, name: string, times: number) => {
    for (let index = 0; index < times; index++) k.counter.fake.fault("machine get", { stderr: `error: no machine "${name}" in fra\n`, code: 1 })
  }

  test("adopt: true never takes a machine whose id another open work records", async () => {
    const k = await kit()
    const machine = k.counter.fake.machine({ name: "oc-thief", region: "fra", labels: { team: "data" } })
    await k.write(workRecord("holder", { region: "fra", machineId: machine.id as never, laptopDirectory: k.project }))
    k.reset()
    const error = await errorOf(k.runs.boxd_ensure({ workId: "thief", adopt: true }, k.call()))
    expect(error.code).toBe("NOT_OURS")
    expect(error.what).toContain("holder")
    expect(k.calls().filter((entry) => /^machine (exec|wake|resize|reboot|rename|label|remove|new)/.test(entry))).toEqual([])
    expect(await k.record("thief")).toBeUndefined()
    expect((await k.record("holder"))?.machineId as string | null | undefined).toBe(machine.id)
  })

  test("a resume whose create is refused as taken while the get still lags answers starting, and the next resume adopts it", async () => {
    const k = await kit()
    await k.golden("fra")
    const landed = await owned(k, "slow")
    await k.write(workRecord("slow", { region: "fra", laptopDirectory: k.project, pendingCreate: { at: new Date().toISOString(), image: IMAGE } }))
    lagListing(k, 2)
    getLags(k, "oc-slow", 2)
    const first = (await k.runs.boxd_resume({ workId: "slow" }, k.call())) as ResumeResult
    expect(first).toMatchObject({ state: "starting", rebuilt: false })
    expect(first.next).toContain('boxd_resume({ workId: "slow" })')
    expect(named(k, "oc-slow")).toHaveLength(1)
    const second = (await k.runs.boxd_resume({ workId: "slow" }, k.call())) as ResumeResult
    expect(second).toMatchObject({ state: "ready", rebuilt: false, region: "fra" })
    expect((await k.record("slow"))?.machineId as string | null | undefined).toBe(landed.id)
    expect(named(k, "oc-slow")).toHaveLength(1)
  })

  test("a get that lags its create's refusal once is read again in the same call, and the machine adopted", async () => {
    const k = await kit()
    await k.golden("fra")
    const landed = await owned(k, "once")
    lagListing(k)
    getLags(k, "oc-once", 1)
    const result = (await k.runs.boxd_ensure({ workId: "once", region: "fra" }, k.call())) as EnsureResult
    expect(result).toMatchObject({ state: "ready", machineId: landed.id, created: false, adopted: true })
    expect(named(k, "oc-once")).toHaveLength(1)
  })
})

describe("auto counts the machines that landed (review MEDIUM-3)", () => {
  test("six creates where fra has the image and 3 free and nyc 40: three go to each region, none refused", async () => {
    const k = await kit()
    await k.golden("fra")
    k.counter.fake.update((state) => { state.limits = { fra: 3, nyc: 40 } })
    // The machine-limit answer is cached from before the creates, as at the start of a long list.
    await k.services.boxd.machineLimit({ call: { callId: "warm", source: "boxd_status" } })
    const list = (await k.runs.boxd_ensure({ works: Array.from({ length: 6 }, (_, index) => ({ workId: `w${index}`, wait: "created" })) }, k.call())) as ListResult<EnsureResult>
    expect(list.counts.refused).toBeUndefined()
    const regions = list.results.map((entry) => (entry as EnsureResult).region).sort()
    expect(regions).toEqual(["fra", "fra", "fra", "nyc", "nyc", "nyc"])
  })
})

describe("the bound B holds for active steps (review MEDIUM-4)", () => {
  test("a single ensure with B of 1.5 s and 0.9 s of CLI latency answers creating and starts no create", async () => {
    // The image is built under the ordinary bound (a slow test machine needs more than 1.5 s for it); only the ensure
    // under test runs with B of 1.5 s.
    let bound = 4 * 60_000
    const k = await kit({ seam: { boundMs: () => bound } })
    await k.golden("fra")
    bound = 1_500
    k.counter.fake.update((state) => { state.latencyMs = [900, 900] })
    const t0 = Date.now()
    const result = (await k.runs.boxd_ensure({ workId: "late", region: "fra" }, k.call())) as EnsureResult
    expect(result.state).toBe("creating")
    expect(result.next).toContain('boxd_ensure({ workId: "late" })')
    expect(k.calls().some((entry) => entry.startsWith("machine new oc-late"))).toBe(false)
    // Only the reads before the create ran: a listing, the snapshots and the machine limit.
    expect(Date.now() - t0).toBeLessThan(1_500 + 3 * 1_200)
  })

  test("a known work with less time left than setup's bound answers starting and runs no setup", async () => {
    const k = await kit({ seam: { boundMs: 20_000 } })
    await known(k, "tight")
    k.reset()
    const result = (await k.runs.boxd_ensure({ workId: "tight" }, k.call())) as EnsureResult
    expect(result).toMatchObject({ state: "starting", machineId: expect.any(String) })
    expect(k.calls().some((entry) => entry.startsWith("machine exec"))).toBe(false)
  })
})

describe("a reassign to a taken name (review MEDIUM-5)", () => {
  test("is refused before anything is written when a listing shows oc-<to>", async () => {
    const k = await kit()
    await known(k, "src")
    k.counter.fake.machine({ name: "oc-dst", region: "nyc", labels: { team: "someone" } })
    k.reset()
    const error = await errorOf(k.runs.boxd_reassign({ from: "src", to: "dst" }, k.call()))
    expect(error.code).toBe("NOT_REASSIGNABLE")
    expect(await k.record("dst")).toBeUndefined()
    expect(k.calls().some((entry) => entry.startsWith("machine rename"))).toBe(false)
  })

  test("a rename boxd refuses as taken rolls to back, and both works carry on", async () => {
    const k = await kit()
    const source = await known(k, "src")
    k.counter.fake.machine({ name: "oc-dst", region: "fra", labels: { team: "someone" } })
    lagListing(k)
    const error = await errorOf(k.runs.boxd_reassign({ from: "src", to: "dst" }, k.call()))
    expect(error.code).toBe("NOT_REASSIGNABLE")
    expect(await k.record("dst")).toMatchObject({ state: "closed", closed: { how: "reassigned", to: "src" } })
    expect((await k.record("dst"))?.pendingRename).toBeUndefined()
    expect(await k.record("src")).toMatchObject({ state: "open", machineId: source.id })
    expect(await k.runs.boxd_ensure({ workId: "src" }, k.call())).toMatchObject({ state: "ready", machineId: source.id })
    expect((await errorOf(k.runs.boxd_ensure({ workId: "dst" }, k.call()))).code).toBe("NOT_OURS")
  })
})

describe("waits ride out an outage and a busy runner (review MEDIUM 5b)", () => {
  /** 40 works whose guest server is down for 6 s, behind 300 ms of CLI latency. */
  async function outage(k: Kit, run: () => Promise<ListResult<{ readonly state: string }>>) {
    const port = k.counter.fake.read().port
    k.counter.fake.update((state) => {
      state.latencyMs = [300, 300]
      state.port = 9
    })
    const back = setTimeout(() => k.counter.fake.update((state) => { state.port = port }), 6_000)
    try {
      return await run()
    } finally {
      clearTimeout(back)
    }
  }

  test("ensure: 40 works all end ready or starting, none unreachable or BOXD_FAILED", async () => {
    const k = await kit({ seam: { intervalMs: 500 } })
    for (let index = 0; index < 40; index++) await known(k, `p${index}`)
    const list = await outage(k, () => k.runs.boxd_ensure({ works: Array.from({ length: 40 }, (_, index) => ({ workId: `p${index}` })) }, k.call()) as Promise<ListResult<EnsureResult>>)
    const states = list.results.map((entry) => entry.state)
    expect(states.filter((state) => state !== "ready" && state !== "starting")).toEqual([])
    expect(list.results.filter((entry) => (entry as Refusal).error !== undefined)).toEqual([])
  }, 180_000)

  test("resume: 40 hibernated works all end ready or starting, none unreachable or BOXD_FAILED", async () => {
    const k = await kit()
    for (let index = 0; index < 40; index++) await known(k, `q${index}`, {}, { status: "hibernated" })
    const list = await outage(k, () => k.runs.boxd_resume({ works: Array.from({ length: 40 }, (_, index) => `q${index}`) }, k.call()) as Promise<ListResult<ResumeResult>>)
    expect(list.results.map((entry) => entry.state).filter((state) => state !== "ready" && state !== "starting")).toEqual([])
    expect(list.results.filter((entry) => (entry as Refusal).error !== undefined)).toEqual([])
  }, 180_000)

  test("a wait whose listings fail on the real runner keeps waiting, and ends ready", async () => {
    const k = await kit({ seam: { intervalMs: 100 } })
    await known(k, "relisted")
    const port = k.counter.fake.read().port
    k.counter.fake.update((state) => { state.port = 9 })
    // Every listing in the next second fails: the wait's own listing and the runner's refresh alike.
    for (let index = 0; index < 4; index++) k.counter.fake.fault("machine list", { stderr: "error: network unreachable", code: 1 })
    const back = setTimeout(() => k.counter.fake.update((state) => { state.port = port }), 1_000)
    const result = (await k.runs.boxd_ensure({ workId: "relisted" }, k.call())) as EnsureResult
    clearTimeout(back)
    expect(result.state).toBe("ready")
  })

  test("a session read whose listing fails once is read again, and acts on the answer", async () => {
    const k = await kit()
    const machine = await known(k, "relist-size", { session: { rootId: "ses_relist" } })
    k.guest.sessions.set("ses_relist", { id: "ses_relist", busy: false, directory: "/home/boxd/work/relist-size", messages: [], inbox: [], updated: Date.now() })
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    k.counter.fake.fault("machine list", { stderr: "error: network unreachable", code: 1 })
    expect(await k.runs.boxd_ensure({ workId: "relist-size", size: "4x16" }, k.call())).toMatchObject({ state: "ready", size: "4x16" })
    expect(k.calls()).toContain(`machine resize ${machine.id} --vcpu 4 -y --region fra --json`)
  })

  test("a signed-out CLI is not a listing to wait for: the wait answers its refusal at once", async () => {
    const { readTarget } = await import("../../src/fleet/ensure.js")
    const { boxdError } = await import("../../src/errors.js")
    const machines = { services: { boxd: { list: async () => Promise.reject(boxdError("BOXD_MISSING", "not signed in")) } } } as never
    const refused = await readTarget(machines, "fra", "oc-x", null, { call: { callId: "t", source: "boxd_ensure" } }).then(
      () => undefined,
      (error: unknown) => error as { code: string; details: Record<string, unknown> },
    )
    expect([refused?.code, refused?.details.kind]).toEqual(["BOXD_MISSING", undefined])
  })

  test("a wait whose serve reads are refused for the listing's age keeps waiting, and ends ready", async () => {
    const k = await kit({ seam: { intervalMs: 100 } })
    await known(k, "queued")
    const port = k.counter.fake.read().port
    k.counter.fake.update((state) => { state.port = 9 })
    k.staleReads = 4
    const back = setTimeout(() => k.counter.fake.update((state) => { state.port = port }), 1_000)
    const result = (await k.runs.boxd_ensure({ workId: "queued" }, k.call())) as EnsureResult
    clearTimeout(back)
    expect(result.state).toBe("ready")
    expect(k.staleReads).toBe(0)
  })

  test("ensure's and resume's single session reads retry once on the marker, and act on the answer", async () => {
    const k = await kit()
    const machine = await known(k, "sized", { session: { rootId: "ses_sized" } })
    k.guest.sessions.set("ses_sized", { id: "ses_sized", busy: false, directory: "/home/boxd/work/sized", messages: [], inbox: [], updated: Date.now() })
    k.staleReads = 1
    expect(await k.runs.boxd_ensure({ workId: "sized", size: "4x16" }, k.call())).toMatchObject({ state: "ready", size: "4x16" })
    expect(k.calls()).toContain(`machine resize ${machine.id} --vcpu 4 -y --region fra --json`)
    // Refused twice: the state is unknown, so the resize waits for the next call rather than guessing.
    k.staleReads = 2
    expect((await errorOf(k.runs.boxd_ensure({ workId: "sized", size: "8x32" }, k.call()))).code).toBe("MACHINE_STARTING")

    const saved = { at: new Date().toISOString(), complete: true, guestVersion: VERSION, sessions: [{ id: "ses_sized", parentId: null, sha256: "0".repeat(64), bytes: 1, lastMessageId: null, messages: 0, updated: 0 }] }
    await k.write({ ...(await k.record("sized"))!, saved })
    k.staleReads = 2
    // Resume's read of the session, refused twice, is not taken for missing: nothing is imported, and it answers starting.
    expect(await k.runs.boxd_resume({ workId: "sized" }, k.call())).toMatchObject({ state: "starting" })
    expect(k.guest.imports).toEqual([])
  })

  test("a session read the read rule did not make is retried once, and never read as busy, missing or failed", async () => {
    const { readOnce, notReadYet } = await import("../../src/fleet/ensure.js")
    const { boxdError } = await import("../../src/errors.js")
    const stale = () => boxdError("BOXD_FAILED", "listing aged in the queue", { rule: "listing-age", kind: "listing-stale" })
    const asleep = () => boxdError("MACHINE_ASLEEP", "not running", { kind: "not-readable" })
    const failedListing = () => boxdError("BOXD_FAILED", "the listing the read needed failed", { kind: "listing-failed", retryable: true })
    expect([stale(), asleep(), failedListing()].every(notReadYet)).toBe(true)
    expect(notReadYet(boxdError("BOXD_FAILED", "something else"))).toBe(false)
    let tries = 0
    expect(await readOnce(async () => (++tries === 1 ? Promise.reject(stale()) : "idle"))).toBe("idle")
    tries = 0
    expect(await readOnce(async () => (++tries === 1 ? Promise.reject(failedListing()) : "idle"))).toBe("idle")
    expect(await readOnce(async () => Promise.reject(asleep()))).toBeUndefined()
    await expect(readOnce(async () => Promise.reject(boxdError("GUEST_FAILED", "a real failure")))).rejects.toThrow("GUEST_FAILED")
  })
})

describe("the reviewer's lows", () => {
  test("LOW-7: a known machine missing in its region says boxd_resume checks every region, not MACHINE_GONE", async () => {
    const k = await kit()
    const machine = await known(k, "vanished")
    k.counter.fake.update((state) => { state.machines.find((entry) => entry.id === machine.id)!.status = "destroyed" })
    const error = await errorOf(k.runs.boxd_ensure({ workId: "vanished" }, k.call()))
    expect(error.code).toBe("BOXD_FAILED")
    expect(error.what).toContain("boxd_resume")
    expect(error.what).toContain("checks every region")
  })

  test("LOW-10: an adopted machine of another size is resized to the size asked for, by id, when idle", async () => {
    const k = await kit()
    const machine = await owned(k, "small", { vcpu: 2 })
    const result = (await k.runs.boxd_ensure({ workId: "small", size: "4x16" }, k.call())) as EnsureResult
    expect(result).toMatchObject({ state: "ready", adopted: true, size: "4x16" })
    expect(k.calls()).toContain(`machine resize ${machine.id} --vcpu 4 -y --region fra --json`)
  })
})

describe("a get's label-based target only adopts a work with no recorded machine id (contract 7b2a417)", () => {
  const op = { call: { callId: "probe", source: "boxd_ensure" as const } }

  test("a work with a recorded id is never taken over by a fully labelled machine that now holds its name", async () => {
    const k = await kit()
    const machine = await known(k, "pinned")
    k.counter.fake.update((state) => { state.machines.find((entry) => entry.id === machine.id)!.status = "destroyed" })
    const stranger = k.counter.fake.machine({ name: "oc-pinned", region: "fra", labels: { owner: "boxd", role: "session", work: "pinned" } })
    // The port would hand it out for adoption by its labels...
    expect((await k.services.boxd.get("fra", "oc-pinned", op)).owned?.target.machineId as string | undefined).toBe(stranger.id)
    k.reset()
    // ...but ensure and resume resolve the recorded id, and refuse.
    expect((await errorOf(k.runs.boxd_ensure({ workId: "pinned" }, k.call()))).code).toBe("NOT_OURS")
    expect((await errorOf(k.runs.boxd_resume({ workId: "pinned" }, k.call()))).code).toBe("NOT_OURS")
    expect(k.calls().filter((entry) => /^machine (exec|wake|resize|reboot|rename|label|remove)/.test(entry))).toEqual([])
    expect((await k.record("pinned"))?.machineId as string | null | undefined).toBe(machine.id)
  })

  test("a rebuild whose create finds the name taken refuses NOT_OURS for a work with a recorded id, and adopts nothing", async () => {
    const k = await kit()
    await k.golden("fra")
    const machine = await known(k, "rebuilt")
    k.counter.fake.update((state) => { state.machines.find((entry) => entry.id === machine.id)!.status = "destroyed" })
    k.counter.fake.machine({ name: "oc-rebuilt", region: "fra", labels: { owner: "boxd", role: "session", work: "rebuilt" } })
    lagListing(k, 2)
    expect((await errorOf(k.runs.boxd_resume({ workId: "rebuilt" }, k.call()))).code).toBe("NOT_OURS")
    expect((await k.record("rebuilt"))?.machineId as string | null | undefined).toBe(machine.id)
  })

  test("a machine renamed by hand keeps another work's label: no adoption target, and ensure refuses NOT_OURS", async () => {
    const k = await kit()
    k.counter.fake.machine({ name: "oc-renamed", region: "fra", labels: { owner: "boxd", role: "session", work: "original" } })
    expect((await k.services.boxd.get("fra", "oc-renamed", op)).owned).toBeUndefined()
    k.counter.fake.machine({ name: "oc-proper", region: "fra", labels: { owner: "boxd", role: "session", work: "proper" } })
    expect((await k.services.boxd.get("fra", "oc-proper", op)).owned).toBeDefined()
    k.reset()
    expect((await errorOf(k.runs.boxd_ensure({ workId: "renamed" }, k.call()))).code).toBe("NOT_OURS")
    expect(k.calls().filter((entry) => !entry.startsWith("machine list"))).toEqual([])
  })

  test("a shared machine gets no adoption target, and is refused MACHINE_SHARED", async () => {
    const k = await kit()
    k.counter.fake.machine({ name: "oc-common", region: "fra", sharing: "shared", labels: { owner: "boxd", role: "session", work: "common" } })
    expect((await k.services.boxd.get("fra", "oc-common", op)).owned).toBeUndefined()
    expect((await errorOf(k.runs.boxd_ensure({ workId: "common" }, k.call()))).code).toBe("MACHINE_SHARED")
  })
})
