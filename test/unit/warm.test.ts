// A repository's warm image on the fake boxd CLI and the real guest helper: the image's name, `ensure` choosing it,
// the region pick preferring a region that holds it, the fallback to the version's image and a clone, and the timing
// and event `ensure` answers. The warm image's disk carries the work's checkout in these tests, which is what a work
// starts from once the guest's own warm checkout lands; `ensure` never clones when the image already has one.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { warmImageName, isWarmImage, parseWarmImageName } from "../../src/fleet/warm.js"
import { repositoryHash } from "../../src/names.js"
import type { EnsureResult } from "../../src/results.js"
import { startKit, VERSION, workRecord, type Kit } from "../support/machines-kit.js"

setDefaultTimeout(120_000)

const REPO = "https://github.com/we-the-rebel-alliance/boxd-plugin"
const IMAGE = `oc-golden-${VERSION}-2x8`
const kits: Kit[] = []
afterEach(async () => {
  for (const kit of kits.splice(0)) await kit.dispose()
})
async function kit(input: Parameters<typeof startKit>[0] = {}) {
  const made = await startKit(input)
  kits.push(made)
  return made
}

/** A snapshot disk with the work folder already checked out, as a warm image carries it. */
function warmDisk(k: Kit, workId: string): string {
  const disk = join(k.project, `warm-${workId}`)
  mkdirSync(join(disk, "home", "boxd", "work", workId, ".git"), { recursive: true })
  writeFileSync(join(disk, "home", "boxd", "work", workId, "README.md"), `# ${workId}\n`)
  return disk
}

/** A machine labelled as this plugin's, with the helper already on it. */
async function owned(k: Kit, workId: string) {
  const ledger = await k.services.ledger.id({ call: { callId: "owned", source: "boxd_ensure" } })
  const machine = k.counter.fake.machine({ name: `oc-${workId}`, region: "fra", labels: { owner: "boxd", role: "session", work: workId, ledger } })
  await k.install(machine.region, machine.name, machine.id)
  return machine
}

/** A local origin for `REPO`, through a git config the fake machine's clone reads. */
function insteadOf(k: Kit, url: string): { readonly origin: string; readonly config: string } {
  const origin = join(k.project, "origin")
  mkdirSync(origin, { recursive: true })
  Bun.spawnSync(["git", "init", "--quiet", origin])
  writeFileSync(join(origin, "README.md"), "# warm\n")
  Bun.spawnSync(["git", "-C", origin, "add", "."])
  Bun.spawnSync(["git", "-C", origin, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "init"])
  const config = join(k.project, "gitconfig")
  writeFileSync(config, `[url "file://${origin}"]\n\tinsteadOf = ${url}\n`)
  return { origin, config }
}

describe("a repository's warm image name", () => {
  test("carries the repository, the URL's key, the version and the size, and reads back", () => {
    const name = warmImageName("oc-golden", REPO, VERSION, "2x8")
    expect(name).toBe(`oc-golden-boxd-plugin-${repositoryHash(REPO)}-${VERSION}-2x8`)
    expect(name.length).toBeLessThanOrEqual(64)
    expect(parseWarmImageName("oc-golden", name)).toEqual({ repo: { name: "boxd-plugin", hash: repositoryHash(REPO) }, opencode: VERSION, size: "2x8" })
    expect(isWarmImage("oc-golden", name)).toBe(true)
  })

  test("gives a repository one name whether its URL is written with .git or without it", () => {
    expect(warmImageName("oc-golden", "https://github.com/o/r", VERSION, "2x8")).toBe(warmImageName("oc-golden", "https://github.com/o/r.git", VERSION, "2x8"))
    expect(parseWarmImageName("oc-golden", warmImageName("oc-golden", "https://github.com/o/r.git", VERSION, "2x8"))).toEqual({
      repo: { name: "r", hash: repositoryHash("https://github.com/o/r") },
      opencode: VERSION,
      size: "2x8",
    })
  })

  test("cuts a long repository name to boxd's 64 characters, keeping the key, version and size whole", () => {
    const url = `https://github.com/we-the-rebel-alliance/${"a".repeat(80)}`
    const name = warmImageName("oc-golden", url, VERSION, "2x8")
    expect(name.length).toBe(64)
    const parsed = parseWarmImageName("oc-golden", name)
    expect(parsed?.repo.hash).toBe(repositoryHash(url))
    expect(parsed?.opencode).toBe(VERSION)
    expect(parsed?.size).toBe("2x8")
    expect(isWarmImage("oc-golden", IMAGE)).toBe(false)
  })
})

describe("boxd_ensure: a warm image", () => {
  test("a repo with a warm image creates from it, reaches ready with no clone, and answers warm and readySeconds", async () => {
    const k = await kit({ options: { buildGolden: "never" } })
    const image = warmImageName("oc-golden", REPO, VERSION, "2x8")
    k.counter.fake.snapshot({ region: "fra", name: image, disk: warmDisk(k, "warm-one") })
    k.reset()
    const result = (await k.runs.boxd_ensure({ workId: "warm-one", repo: REPO }, k.call())) as EnsureResult
    expect(result).toMatchObject({ state: "ready", workId: "warm-one", region: "fra", image, warm: true, created: true })
    expect(typeof result.readySeconds).toBe("number")
    expect(result.readySeconds).toBeGreaterThanOrEqual(0)
    const created = k.calls().find((entry) => entry.startsWith("machine new oc-warm-one"))!
    expect(created).toContain(`--from-snapshot ${image}`)
    // No warm image is ever built here, and the snapshot's checkout means no clone.
    expect(k.calls().some((entry) => entry.startsWith("machine new oc-gb-"))).toBe(false)
    const machine = k.counter.fake.read().machines.find((entry) => entry.name === "oc-warm-one")!
    expect(existsSync(join(k.counter.fake.disk(machine), "home", "boxd", ".boxd-plugin", "clones"))).toBe(false)
    const record = await k.record("warm-one")
    expect(record).toMatchObject({ image: { name: image }, warm: true })
    expect(record?.readyAt).toBeString()
    const page = await k.services.ledger.eventsSince(0, { call: { callId: "events", source: "boxd_events_list" } })
    const ready = page.events.find((event) => event.workId === "warm-one" && event.to === "ready")!
    expect(ready).toMatchObject({ warm: true, readySeconds: result.readySeconds })
  })

  test("auto prefers the region that holds the repository's warm image", async () => {
    const k = await kit({ options: { buildGolden: "never" } })
    const image = warmImageName("oc-golden", REPO, VERSION, "2x8")
    k.counter.fake.snapshot({ region: "fra", name: IMAGE })
    k.counter.fake.snapshot({ region: "nyc", name: image, disk: warmDisk(k, "prefer") })
    k.reset()
    const result = (await k.runs.boxd_ensure({ workId: "prefer", repo: REPO }, k.call())) as EnsureResult
    expect(result).toMatchObject({ state: "ready", region: "nyc", image, warm: true })
    expect(k.calls().find((entry) => entry.startsWith("machine new oc-prefer"))).toContain("--region nyc")
  })

  test("no warm image falls back to the version's image and a clone, and answers warm false", async () => {
    const k = await kit({ options: { buildGolden: "never" } })
    k.counter.fake.snapshot({ region: "fra", name: IMAGE })
    const { config } = insteadOf(k, REPO)
    const previous = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = config
    try {
      k.reset()
      const result = (await k.runs.boxd_ensure({ workId: "no-warm", repo: REPO }, k.call())) as EnsureResult
      expect(result).toMatchObject({ state: "ready", workId: "no-warm", region: "fra", image: IMAGE, warm: false, created: true })
      expect(k.calls().find((entry) => entry.startsWith("machine new oc-no-warm"))).toContain(`--from-snapshot ${IMAGE}`)
      expect(k.calls().some((entry) => entry.startsWith("machine new oc-gb-"))).toBe(false)
      const machine = k.counter.fake.read().machines.find((entry) => entry.name === "oc-no-warm")!
      // The clone ran, and its checkout is in the work folder the helper reports ready from.
      expect(existsSync(join(k.counter.fake.disk(machine), "home", "boxd", "work", "no-warm", ".git"))).toBe(true)
      expect((await k.record("no-warm"))?.warm).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = previous
    }
  })

  test("readySeconds counts from the work's first ensure to its first ready, and stays the same", async () => {
    const k = await kit()
    const machine = await owned(k, "timed")
    await k.write(
      workRecord("timed", {
        region: "fra",
        machineId: machine.id as never,
        createdAt: new Date(Date.now() - 12_000).toISOString(),
        image: { name: IMAGE, opencode: VERSION },
        tracked: true,
      }),
    )
    const first = (await k.runs.boxd_ensure({ workId: "timed" }, k.call())) as EnsureResult
    expect(first.state).toBe("ready")
    expect(first.readySeconds).toBeGreaterThanOrEqual(12)
    expect((await k.record("timed"))?.readyAt).toBeString()
    const second = (await k.runs.boxd_ensure({ workId: "timed" }, k.call())) as EnsureResult
    expect(second.readySeconds).toBe(first.readySeconds as number)
  })

  test("an older work without the mark answers no readySeconds and records no ready time", async () => {
    const k = await kit()
    const machine = await owned(k, "older")
    await k.write(
      workRecord("older", {
        region: "fra",
        machineId: machine.id as never,
        createdAt: new Date(Date.now() - 12_000).toISOString(),
        image: { name: IMAGE, opencode: VERSION },
      }),
    )
    const result = (await k.runs.boxd_ensure({ workId: "older" }, k.call())) as EnsureResult
    expect(result.state).toBe("ready")
    expect(result.readySeconds).toBeUndefined()
    expect((await k.record("older"))?.readyAt).toBeUndefined()
  })

  test("a resumed work rebuilds from its warm image", async () => {
    const k = await kit()
    const image = warmImageName("oc-golden", REPO, VERSION, "2x8")
    k.counter.fake.snapshot({ region: "fra", name: image, disk: warmDisk(k, "rebuilt") })
    const machine = await owned(k, "rebuilt")
    k.counter.fake.update((state) => {
      state.machines.find((entry) => entry.id === machine.id)!.status = "destroyed"
    })
    await k.write(
      workRecord("rebuilt", {
        region: "fra",
        machineId: machine.id as never,
        repo: { url: REPO },
        image: { name: image, opencode: VERSION },
        warm: true,
      }),
    )
    k.reset()
    const warm = await k.runs.boxd_resume({ workId: "rebuilt" }, k.call())
    expect(warm).toMatchObject({ state: "ready", rebuilt: true, region: "fra" })
    expect(k.calls().find((entry) => entry.startsWith("machine new oc-rebuilt"))).toContain(`--from-snapshot ${image}`)
    expect((await k.record("rebuilt"))?.warm).toBe(true)
  })

  test("a resumed work whose warm image is gone rebuilds from the version's image and is no longer warm", async () => {
    const k = await kit()
    const image = warmImageName("oc-golden", REPO, VERSION, "2x8")
    k.counter.fake.snapshot({ region: "fra", name: IMAGE })
    const machine = await owned(k, "gone")
    k.counter.fake.update((state) => {
      state.machines.find((entry) => entry.id === machine.id)!.status = "destroyed"
    })
    await k.write(
      workRecord("gone", {
        region: "fra",
        machineId: machine.id as never,
        repo: { url: REPO },
        image: { name: image, opencode: VERSION },
        warm: true,
      }),
    )
    k.reset()
    const fallback = await k.runs.boxd_resume({ workId: "gone" }, k.call())
    expect(fallback).toMatchObject({ state: "ready", rebuilt: true, region: "fra" })
    expect(k.calls().find((entry) => entry.startsWith("machine new oc-gone"))).toContain(`--from-snapshot ${IMAGE}`)
    expect((await k.record("gone"))?.warm).toBeUndefined()
  })

  test("a resume whose claim lands outside the warm image's region uses the version's image", async () => {
    const k = await kit()
    const warm = warmImageName("oc-golden", REPO, VERSION, "2x8")
    k.counter.fake.snapshot({ region: "fra", name: warm, disk: warmDisk(k, "claimed") })
    k.counter.fake.snapshot({ region: "fra", name: IMAGE })
    k.counter.fake.snapshot({ region: "nyc", name: IMAGE, disk: warmDisk(k, "claimed") })
    await k.write(
      workRecord("claimed", {
        region: null,
        machineId: null,
        repo: { url: REPO },
        image: { name: warm, opencode: VERSION },
        warm: true,
      }),
    )
    // Another call claims nyc after this resume has picked its region, so the claim lands away from the warm image.
    const real = k.services.boxd.snapshots
    let moved = false
    k.services.boxd.snapshots = async (context) => {
      if (!moved) {
        moved = true
        await k.services.ledger.update(
          ["claimed"],
          async (current) => {
            const now = current.get("claimed")!
            return { write: [{ ...now, region: "nyc" }], value: undefined }
          },
          context,
        )
      }
      return real(context)
    }
    k.reset()
    const result = await k.runs.boxd_resume({ workId: "claimed" }, k.call())
    expect(result).toMatchObject({ state: "ready", rebuilt: true, region: "nyc" })
    const created = k.calls().find((entry) => entry.startsWith("machine new oc-claimed"))!
    expect(created).toContain("--region nyc")
    expect(created).toContain(`--from-snapshot ${IMAGE}`)
    // The version's image is there, so no build runs, and the warm name is never built here.
    expect(k.calls().some((entry) => entry.startsWith("machine new oc-gb-"))).toBe(false)
    expect(k.counter.fake.read().snapshots.some((snapshot) => snapshot.region === "nyc" && snapshot.name === warm)).toBe(false)
  })
})
