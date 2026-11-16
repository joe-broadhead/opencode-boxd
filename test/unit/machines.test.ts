// Package C1 on the fake boxd CLI and the fake guest (design §7.1): the ensure state machine (new, adopt, wake,
// resize when idle, upgrade when idle, the VM agent's reboot once, the fresh probe of a starting machine), acting by
// id, regions and MACHINE_LIMIT, the budget, the creation flags, golden builds and their scrub, reassign, resume, and
// the §4.4 spawn budgets of ensure.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { WorkRecord } from "../../src/ledger/types.js"
import type { EnsureResult, ListResult, Refusal, ResumeResult, GoldenResult } from "../../src/results.js"
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
  const machine = k.counter.fake.machine({ name: `oc-${workId}`, region: "fra", labels: { owner: "opencode-boxd", role: "session", work: workId }, ...over })
  await k.install(machine.region, machine.name, machine.id)
  return machine
}

/** A work the ledger knows, on a machine it owns. */
async function known(k: Kit, workId: string, record: Partial<WorkRecord> = {}, machine: Parameters<typeof owned>[2] = {}) {
  const { status, ...rest } = machine as { status?: string }
  const made = await owned(k, workId, rest)
  // The helper's install is an exec, which boxd answers by waking the machine: the status is set after it.
  if (status) k.counter.fake.update((state) => void (state.machines.find((entry) => entry.id === made.id)!.status = status))
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
    expect(created).toContain("--label owner=opencode-boxd --label role=session --label work=review-api")
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
    const k = await kit({ seam: { boundMs: 300 } })
    const first = (await k.runs.boxd_ensure({ workId: "slow", region: "fra" }, k.call())) as EnsureResult
    expect(first).toMatchObject({ state: "creating", machineId: null, created: false })
    expect(first.next).toContain('boxd_ensure({ workId: "slow" })')
    // The next calls join the same build: one builder only, then the work is created from its image.
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
    k.counter.fake.update((state) => void (state.limits = { fra: 1, nyc: 1 }))
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

  test("v0's role=session with work=<id> is the plugin's too; the v1 owner label is added", async () => {
    const k = await kit()
    const machine = k.counter.fake.machine({ name: "oc-old", region: "nyc", labels: { role: "session", work: "old" } })
    const result = (await k.runs.boxd_ensure({ workId: "old" }, k.call())) as EnsureResult
    expect(result).toMatchObject({ state: "ready", region: "nyc", adopted: true })
    expect(k.calls()).toContain(`machine label set ${machine.id} owner opencode-boxd --region nyc`)
  })

  test("an oc-<id> without the labels is refused NOT_OURS, with no setup, clone or resize; adopt: true takes it over", async () => {
    const k = await kit()
    const machine = k.counter.fake.machine({ name: "oc-stranger", region: "fra", labels: { team: "data" } })
    const error = await errorOf(k.runs.boxd_ensure({ workId: "stranger", repo: "https://github.com/o/r", size: "4x16" }, k.call()))
    expect(error.code).toBe("NOT_OURS")
    expect(k.calls().filter((entry) => !entry.startsWith("machine list"))).toEqual([])
    const adopted = (await k.runs.boxd_ensure({ workId: "stranger", adopt: true }, k.call())) as EnsureResult
    expect(adopted).toMatchObject({ state: "ready", machineId: machine.id, adopted: true })
    expect(k.counter.fake.read().machines.find((entry) => entry.id === machine.id)?.labels).toMatchObject({ owner: "opencode-boxd", role: "session", work: "stranger", team: "data" })
  })

  test("two regions holding oc-<id> answer NOT_OURS naming both", async () => {
    const k = await kit()
    k.counter.fake.machine({ name: "oc-twin", region: "fra", labels: { owner: "opencode-boxd" } })
    k.counter.fake.machine({ name: "oc-twin", region: "nyc", labels: { owner: "opencode-boxd" } })
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
    writeFileSync(join(k.counter.fake.disk(machine), ".opencode-version"), "2.2.5\n")
    k.guest.sessions.set("ses_older", { id: "ses_older", busy: true, directory: "/home/boxd/work/older", messages: [], inbox: [], updated: Date.now() })
    const busy = (await k.runs.boxd_ensure({ workId: "older" }, k.call())) as EnsureResult
    expect(busy.upgraded).toBeUndefined()
    expect(busy.guestVersion).toBe("2.2.5")
    k.guest.idle("ses_older")
    const idle = (await k.runs.boxd_ensure({ workId: "older" }, k.call())) as EnsureResult
    expect(idle).toMatchObject({ upgraded: true, guestVersion: VERSION })
    expect(readFileSync(join(k.counter.fake.disk(machine), ".opencode-version"), "utf8").trim()).toBe(VERSION)
  })

  test("a silent VM agent after the plugin's resize is rebooted once; the next silence answers AGENT_UNREACHABLE; repair reboots", async () => {
    const k = await kit()
    const machine = await known(k, "quiet")
    k.counter.fake.update((state) => void (state.resizeSilencesAgent = true))
    const resized = (await k.runs.boxd_ensure({ workId: "quiet", size: "4x16" }, k.call())) as EnsureResult
    expect(resized).toMatchObject({ state: "ready", rebooted: true })
    expect(k.calls().filter((entry) => entry === `machine reboot ${machine.id} --region fra --json`)).toHaveLength(1)
    expect((await k.record("quiet"))?.reboots).toEqual([expect.objectContaining({ why: "agent-silent" })])

    // The agent goes silent again; the plugin changed nothing since its own reboot, so it does not reboot by itself.
    k.counter.fake.update((state) => void (state.machines.find((entry) => entry.id === machine.id)!.agentSilent = true))
    k.reset()
    const silent = await errorOf(k.runs.boxd_ensure({ workId: "quiet" }, k.call()))
    expect(silent.code).toBe("AGENT_UNREACHABLE")
    expect(k.calls().some((entry) => entry.startsWith("machine reboot"))).toBe(false)

    const repaired = (await k.runs.boxd_ensure({ workId: "quiet", repair: "reboot" }, k.call())) as EnsureResult
    expect(repaired).toMatchObject({ state: "ready", rebooted: true })
    expect((await k.record("quiet"))?.reboots?.map((reboot) => reboot.why)).toEqual(["agent-silent", "repair"])
  })

  test("a starting guest answers starting, and the next call probes it fresh rather than repeating a cached starting", async () => {
    const k = await kit({ seam: { boundMs: 800 } })
    await known(k, "warmup")
    // Nothing answers on the guest's port: the server is down, so setup starts it and the wait sees it still coming up.
    const port = k.counter.fake.read().port
    k.counter.fake.update((state) => void (state.port = 9))
    const first = (await k.runs.boxd_ensure({ workId: "warmup" }, k.call())) as EnsureResult
    expect(first.state).toBe("starting")
    expect(first.next).toContain('boxd_ensure({ workId: "warmup" })')
    k.counter.fake.update((state) => void (state.port = port))
    k.reset()
    const second = (await k.runs.boxd_ensure({ workId: "warmup" }, k.call())) as EnsureResult
    expect(second.state).toBe("ready")
    expect(k.calls().some((entry) => entry.startsWith("machine exec oc-warmup"))).toBe(true)
  })

  test("acting by id: oc-<id> now pointing at another machine answers NOT_OURS, and nothing is resized or rebooted", async () => {
    const k = await kit()
    const machine = await known(k, "moved")
    // Someone removed the work's machine and made another under the same name.
    k.counter.fake.update((state) => void (state.machines.find((entry) => entry.id === machine.id)!.status = "destroyed"))
    k.counter.fake.machine({ name: "oc-moved", region: "fra", labels: { owner: "opencode-boxd", work: "moved" } })
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
    expect(existsSync(join(image.disk!, "home/boxd/.opencode-boxd/guest.py"))).toBe(true)
    expect(existsSync(join(image.disk!, "home/boxd/.opencode-boxd/password"))).toBe(false)
    expect(existsSync(join(image.disk!, "home/boxd/work"))).toBe(false)

    expect(await k.runs.boxd_golden({ region: "fra" }, k.call())).toMatchObject({ state: "present" })
    k.reset()
    expect(await k.runs.boxd_golden({ region: "fra", rebuild: true }, k.call())).toMatchObject({ state: "built" })
    expect(k.calls().filter((entry) => entry.startsWith("snapshots save"))).toHaveLength(1)
  })

  test("no warning when a provider key is among the sealed secrets; with no input every region is built", async () => {
    const k = await kit()
    k.counter.fake.update((state) => void (state.secrets = [{ name: "ANTHROPIC_API_KEY", scope: "private", domains: ["api.anthropic.com"] }]))
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
    expect(existsSync(join(image.disk!, "home/boxd/.opencode-boxd-golden-setup.sh"))).toBe(false)

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

  test("prune removes unused images of other versions, never the current one or one an open work records", async () => {
    const k = await kit()
    k.counter.fake.snapshot({ region: "fra", name: "oc-golden-2.2.4-2x8" })
    k.counter.fake.snapshot({ region: "fra", name: "oc-golden-2.2.5-2x8" })
    k.counter.fake.snapshot({ region: "fra", name: IMAGE })
    k.counter.fake.snapshot({ region: "fra", name: "someone-elses" })
    await k.write(workRecord("keeper", { image: { name: "oc-golden-2.2.5-2x8", opencode: "2.2.5" } }))
    const result = (await k.runs.boxd_golden({ prune: true }, k.call())) as GoldenResult
    expect(result.state).toBe("pruned")
    expect(result.removed?.map((image) => image.name)).toEqual(["oc-golden-2.2.4-2x8"])
    expect(k.counter.fake.read().snapshots.map((snapshot) => snapshot.name).sort()).toEqual(["oc-golden-2.2.5-2x8", IMAGE, "someone-elses"].sort())
  })

  test("ensure picks only <prefix>-<version>-<size>: another snapshot is never a work's image", async () => {
    const k = await kit({ options: { buildGolden: "never" } })
    k.counter.fake.snapshot({ region: "fra", name: "my-work-saved" })
    k.counter.fake.snapshot({ region: "fra", name: `oc-golden-2.2.5-2x8` })
    expect((await errorOf(k.runs.boxd_ensure({ workId: "picky", region: "fra" }, k.call()))).code).toBe("GOLDEN_MISSING")
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
    expect(k.counter.fake.read().machines.find((entry) => entry.id === machine.id)).toMatchObject({ name: "oc-review-api", labels: { work: "review-api" } })
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
    k.counter.fake.update((state) => void (state.machines.find((entry) => entry.id === machine.id)!.status = "destroyed"))
    k.counter.fake.machine({ name: "oc-repointed", region: "fra", labels: { owner: "opencode-boxd" } })
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
    k.counter.fake.update((state) => void (state.machines.find((entry) => entry.id === machine.id)!.status = "destroyed"))
    k.reset()
    const result = (await k.runs.boxd_resume({ works: ["phoenix"] }, k.call())) as ListResult<ResumeResult>
    expect(result).toMatchObject({ state: "done", results: [{ state: "ready", rebuilt: true }] })
    const calls = k.calls()
    // The gone rule: a fresh listing and a not-found get of the recorded id in every region, before the create.
    expect(calls.slice(0, 3)).toEqual(["machine list --region all --json", `machine get ${machine.id} --region fra --json`, `machine get ${machine.id} --region nyc --json`])
    expect(calls.find((entry) => entry.startsWith("machine new"))).toContain(`--from-snapshot ${IMAGE}`)
    expect(k.guest.imports.map((entry) => entry.id)).toEqual(["ses_phoenix"])
    const record = await k.record("phoenix")
    expect(record?.machineId).not.toBe(machine.id)
    expect(record?.session?.rootId).toBe("ses_phoenix")
  })

  test("a failed read is never gone: a get that fails other than not-found rebuilds nothing", async () => {
    const k = await kit()
    const machine = await known(k, "flaky")
    k.counter.fake.update((state) => void (state.machines.find((entry) => entry.id === machine.id)!.status = "destroyed"))
    k.counter.fake.fault("machine get", { stderr: "error: upstream timeout" })
    k.reset()
    const error = await errorOf(k.runs.boxd_resume({ workId: "flaky" }, k.call()))
    expect(error.code).toBe("BOXD_FAILED")
    expect(k.calls().some((entry) => entry.startsWith("machine new"))).toBe(false)
  })

  test("a machine renamed by hand is found by its id, and answers NOT_OURS naming it", async () => {
    const k = await kit()
    const machine = await known(k, "renamed")
    k.counter.fake.update((state) => void (state.machines.find((entry) => entry.id === machine.id)!.name = "oc-by-hand"))
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
