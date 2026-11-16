// The boxd CLI port on the fake laptop CLI, through the real runner: regions on every verb, one listing for every
// region, changes by id after checkOwned and inside the machine lock, the creation flags of design §C.2, the read rule
// before a read exec, no upload from a read, the stderr table, the caches, and every child tagged with its call.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { createBoxdCli, isChangeTarget } from "../../src/boxd/cli.js"
import { BoxdError } from "../../src/errors.js"
import { createRunner } from "../../src/exec/runner.js"
import type { BoxdPort, ChangeTarget, MachineId, OpContext, ReadTarget } from "../../src/ports.js"
import { startFakeCli, type FakeCli } from "../host/fake-cli.js"

let fake: FakeCli
let runner: ReturnType<typeof createRunner>
let boxd: BoxdPort
const context = (callId = "call_test"): OpContext => ({ call: { callId, source: "boxd_ensure" } })
const code = (error: unknown) => (error instanceof BoxdError ? error.code : String(error))
const fail = <T>(promise: Promise<T>) => promise.then(() => undefined, (error: unknown) => error as BoxdError)

beforeEach(() => {
  fake = startFakeCli()
  runner = createRunner()
  boxd = createBoxdCli({ bin: fake.bin, runner })
})
afterEach(async () => {
  await runner.dispose()
  fake.dispose()
})
afterAll(() => {})

/** A change as the fleet makes it: the by-id check under the machine lock. */
async function owned<T>(region: "fra" | "nyc", name: `oc-${string}`, id: string, fn: (target: ChangeTarget) => Promise<T>): Promise<T> {
  return runner.withMachineLock({ id: id as MachineId }, context(), async () => fn((await boxd.checkOwned(region, name, id as MachineId, context())).target))
}

describe("reads", () => {
  test("one listing for every region, shared by concurrent readers and reused within its age", async () => {
    fake.machine({ name: "oc-a", region: "fra", labels: { role: "session" } })
    fake.machine({ name: "oc-a", region: "nyc", status: "hibernated" })
    const [one, two] = await Promise.all([boxd.list({ maxAgeMs: 10_000 }, context()), boxd.list({ maxAgeMs: 10_000 }, context())])
    expect(one.machines.map((row) => [row.name, row.region, row.status])).toEqual([
      ["oc-a", "fra", "running"],
      ["oc-a", "nyc", "hibernated"],
    ])
    expect(one.fresh).toBe(false)
    expect(two.machines).toEqual(one.machines)
    await boxd.list({ maxAgeMs: 10_000 }, context())
    expect(fake.calls()).toEqual(["machine list --region all --json"])
    // A fresh listing is its own call, and is marked fresh.
    expect((await boxd.list({ maxAgeMs: 0 }, context())).fresh).toBe(true)
    expect(fake.calls()).toHaveLength(2)
  }, 20_000)

  test("get hands back a change target only for a machine whose labels show the plugin owns it", async () => {
    const ours = fake.machine({ name: "oc-a", region: "fra", labels: { role: "session", owner: "opencode-boxd", work: "a" } })
    const v0 = fake.machine({ name: "oc-b", region: "fra", labels: { role: "session", work: "b" } })
    fake.machine({ name: "oc-c", region: "fra", labels: { role: "session", work: "other" } })
    fake.machine({ name: "oc-d", region: "fra" })
    expect((await boxd.get("fra", "oc-a", context())).owned).toMatchObject({ target: { region: "fra", name: "oc-a", machineId: ours.id }, status: "running" })
    expect((await boxd.get("fra", "oc-b", context())).owned?.target).toMatchObject({ machineId: v0.id })
    expect((await boxd.get("fra", "oc-c", context())).owned).toBeUndefined()
    expect((await boxd.get("fra", "oc-d", context())).owned).toBeUndefined()
  }, 20_000)

  test("get never hands back a change target for a shared or isolated machine, whatever its labels", async () => {
    const labels = { role: "session", owner: "opencode-boxd", work: "s" }
    fake.machine({ name: "oc-s", region: "fra", labels, sharing: "shared" })
    fake.machine({ name: "oc-i", region: "fra", labels: { ...labels, work: "i" }, isolated: true })
    expect(await boxd.get("fra", "oc-s", context())).toMatchObject({ sharing: "shared" })
    expect((await boxd.get("fra", "oc-s", context())).owned).toBeUndefined()
    expect(await boxd.get("fra", "oc-i", context())).toMatchObject({ isolated: true })
    expect((await boxd.get("fra", "oc-i", context())).owned).toBeUndefined()
  }, 20_000)

  test("a create whose answer names another machine is BOXD_FAILED, and nothing is branded", async () => {
    fake.snapshot({ region: "fra", name: "img" })
    fake.update((state) => void (state.createAnswersName = "oc-someone-else"))
    const key = { create: { region: "fra" as const, name: "oc-asked" as const } }
    const error = await fail(
      runner.withMachineLock(key, context(), () =>
        boxd.create({ kind: "work", region: "fra", name: "oc-asked", workId: "asked", image: "img", autoSuspendSeconds: 0, autoHibernateSeconds: 7200 }, context()),
      ),
    )
    expect([error?.code, error?.what]).toEqual(["BOXD_FAILED", "boxd machine new oc-asked in fra answered for machine oc-someone-else. Nothing was recorded."])
  })

  test("get answers the machine and its id in the region asked; a not-found answer is classified, never guessed", async () => {
    const machine = fake.machine({ name: "oc-a", region: "nyc" })
    expect(await boxd.get("nyc", "oc-a", context())).toMatchObject({ id: machine.id, name: "oc-a", region: "nyc", isolated: false })
    expect(await boxd.get("nyc", machine.id, context())).toMatchObject({ name: "oc-a" })
    const elsewhere = await fail(boxd.get("fra", "oc-a", context()))
    expect([elsewhere?.code, elsewhere?.details.kind, elsewhere?.details.region]).toEqual(["BOXD_FAILED", "elsewhere", "nyc"])
    const missing = await fail(boxd.get("fra", "oc-gone", context()))
    expect([missing?.code, missing?.details.kind]).toEqual(["BOXD_FAILED", "missing"])
  })

  test("the machine limit per region, cached for a minute; the org-wide shape gives every region the same headroom", async () => {
    fake.update((state) => void (state.limits = { fra: 2, nyc: 5 }))
    fake.machine({ name: "oc-a", region: "fra" })
    expect(await boxd.machineLimit(context())).toEqual([
      { region: "fra", limit: 2, inUse: 1, free: 1 },
      { region: "nyc", limit: 5, inUse: 0, free: 5 },
    ])
    await boxd.machineLimit(context())
    expect(fake.calls().filter((call) => call.startsWith("manage machine-limit"))).toHaveLength(1)
  })

  test("usage for an owner, and a plain refusal for a member", async () => {
    expect(await boxd.usage("24h", context())).toEqual({ available: false, reason: "boxd's machine usage is for organisation owners and admins." })
    fake.update((state) => void (state.usage = { currency: "USD", complete: true, rates: { vcpu_hour_micro: 47000, ram_gib_hour_micro: 14000, disk_gib_hour_micro: 96 }, machines: [{ id: "vm_0001", cost_micro: 1_000_000 }] }))
    expect(await boxd.usage("24h", context())).toMatchObject({ available: true, currency: "USD", total: 1, complete: true, machines: [{ machineId: "vm_0001", cost: 1 }] })
  })

  test("snapshots in every region, cached; secrets by name, scope and hosts only", async () => {
    fake.snapshot({ region: "nyc", name: "oc-golden-2.2.6-2x8" })
    expect(await boxd.snapshots(context())).toEqual([{ region: "nyc", name: "oc-golden-2.2.6-2x8", storage: "local", status: "ready" }])
    await boxd.snapshots(context())
    expect(fake.calls().filter((call) => call.startsWith("snapshots list"))).toHaveLength(1)
    fake.update((state) => void (state.secrets = [{ name: "OPENCODE_API_KEY", scope: "private", domains: ["api.example.com"] }]))
    expect(await boxd.secrets(context())).toEqual([{ name: "OPENCODE_API_KEY", scope: "private", hosts: ["api.example.com"] }])
  })
})

describe("changes", () => {
  test("a work's create carries the labels and the cost bounds, records the id, and never a size", async () => {
    fake.snapshot({ region: "nyc", name: "oc-golden-2.2.6-4x16", vcpu: 4, labels: { role: "golden-builder", tier: "x" } })
    const key = { create: { region: "nyc" as const, name: "oc-review-api" as const } }
    const info = await runner.withMachineLock(key, context(), () =>
      boxd.create({ kind: "work", region: "nyc", name: "oc-review-api", workId: "review-api", image: "oc-golden-2.2.6-4x16", autoSuspendSeconds: 0, autoHibernateSeconds: 7200 }, context()),
    )
    const stored = fake.read().machines[0]!
    expect(info).toMatchObject({ id: stored.id, name: "oc-review-api", region: "nyc", sharing: "private", isolated: false })
    // This process made it with this id, so the create hands back a change target: no second get to act on it.
    expect(info.owned).toMatchObject({ target: { region: "nyc", name: "oc-review-api", machineId: stored.id }, status: "starting" })
    expect(isChangeTarget(info.owned.target)).toBe(true)
    expect(stored).toMatchObject({ vcpu: 4, autoSuspend: 0, autoHibernate: 7200, ignoreOutbound: "off", labels: { role: "session", owner: "opencode-boxd", work: "review-api", tier: "x" } })
    expect(stored.deleteAfter).toBeUndefined()
  })

  test("a lease adds --delete-after; a full region answers MACHINE_LIMIT before anything lands", async () => {
    fake.snapshot({ region: "fra", name: "img" })
    const create = (workId: string, leaseDays?: number) =>
      runner.withMachineLock({ create: { region: "fra", name: `oc-${workId}` } }, context(), () =>
        boxd.create({ kind: "work", region: "fra", name: `oc-${workId}`, workId, image: "img", autoSuspendSeconds: 0, autoHibernateSeconds: 7200, ...(leaseDays ? { leaseDays } : {}) }, context()),
      )
    await create("a", 2)
    expect(fake.read().machines[0]!.deleteAfter).toBe("2d")
    fake.update((state) => void (state.limits = { fra: 1 }))
    expect(code(await fail(create("b")))).toBe("MACHINE_LIMIT")
    expect(fake.read().machines).toHaveLength(1)
  })

  test("a create outside its lock is a bug, refused before it runs", async () => {
    await expect(boxd.create({ kind: "work", region: "fra", name: "oc-a", workId: "a", image: "img", autoSuspendSeconds: 0, autoHibernateSeconds: 7200 }, context())).rejects.toThrow(/withMachineLock/)
    expect(fake.calls()).toEqual([])
  })

  test("checkOwned resolves the name to the recorded id; a re-pointed name is NOT_OURS and nothing changes", async () => {
    const machine = fake.machine({ name: "oc-a", region: "fra" })
    await owned("fra", "oc-a", machine.id, (target) => boxd.hibernate(target, context()))
    expect(fake.read().machines[0]!.status).toBe("hibernated")
    // The name now points at another machine.
    fake.update((state) => void (state.machines[0]!.name = "oc-moved"))
    const other = fake.machine({ name: "oc-a", region: "fra" })
    const refused = await fail(owned("fra", "oc-a", machine.id, (target) => boxd.remove(target, context())))
    expect(refused?.code).toBe("NOT_OURS")
    expect(fake.read().machines.map((item) => item.status)).toEqual(["hibernated", "running"])
    expect(fake.calls().filter((call) => call.includes("remove"))).toEqual([])
    expect(other.id).not.toBe(machine.id)
  })

  test("every change verb acts on the id, in its region", async () => {
    const machine = fake.machine({ name: "oc-a", region: "nyc", status: "hibernated" })
    await owned("nyc", "oc-a", machine.id, async (target) => {
      await boxd.wake(target, context())
      await boxd.resize(target, "4x16", context())
      await boxd.reboot(target, context())
      await boxd.setLabels(target, { work: "b", owner: "opencode-boxd" }, context())
      await boxd.renewLease(target, 1, context())
      await boxd.rename(target, "oc-b", context())
      await boxd.saveSnapshot(target, "oc-golden-2.2.6-4x16", context())
    })
    const id = machine.id
    expect(fake.calls().filter((call) => !call.startsWith("machine get"))).toEqual([
      `machine wake ${id} --region nyc --json`,
      `machine resize ${id} --vcpu 4 -y --region nyc --json`,
      `machine reboot ${id} --region nyc --json`,
      `machine label set ${id} owner opencode-boxd --region nyc`,
      `machine label set ${id} work b --region nyc`,
      `machine config set ${id} delete-after 1d --region nyc`,
      `machine rename ${id} oc-b -y --region nyc --json`,
      `snapshots save ${id} oc-golden-2.2.6-4x16 --region nyc --json`,
    ])
    expect(fake.read().machines[0]).toMatchObject({ name: "oc-b", vcpu: 4, status: "running", deleteAfter: "1d", labels: { work: "b", owner: "opencode-boxd" } })
    expect(fake.read().snapshots[0]).toMatchObject({ region: "nyc", name: "oc-golden-2.2.6-4x16", vcpu: 4 })
  })

  test("checkOwned yields the target and the status the same get showed", async () => {
    const machine = fake.machine({ name: "oc-a", region: "fra", status: "hibernated" })
    expect(await boxd.checkOwned("fra", "oc-a", machine.id as MachineId, context())).toMatchObject({ target: { machineId: machine.id }, status: "hibernated" })
  })

  test("a change outside the machine lock, or on a target checkOwned did not make, is a bug and runs nothing", async () => {
    const machine = fake.machine({ name: "oc-a", region: "fra" })
    const target = (await boxd.checkOwned("fra", "oc-a", machine.id as MachineId, context())).target
    await expect(boxd.hibernate(target, context())).rejects.toThrow(/withMachineLock/)
    const forged = { region: "fra", name: "oc-a", machineId: machine.id } as unknown as ChangeTarget
    await expect(runner.withMachineLock({ id: machine.id as MachineId }, context(), () => boxd.remove(forged, context()))).rejects.toThrow(/checkOwned/)
    expect(fake.calls().filter((call) => !call.startsWith("machine get"))).toEqual([])
  })

  test("boxd_exec, in the exec pool, takes no machine lock; any other exec on a change target needs it", async () => {
    const machine = fake.machine({ name: "oc-a", region: "fra" })
    const target = (await boxd.checkOwned("fra", "oc-a", machine.id as MachineId, context())).target
    expect((await boxd.exec(target, "echo ok", { timeoutSeconds: 5, json: false }, { ...context(), pool: "exec" })).stdout).toBe("ok\n")
    await expect(boxd.exec(target, "echo ok", { timeoutSeconds: 5, json: false }, context())).rejects.toThrow(/withMachineLock/)
  })

  test("a silent VM agent is AGENT_UNREACHABLE", async () => {
    const machine = fake.machine({ name: "oc-a", region: "fra", agentSilent: true })
    const error = await fail(owned("fra", "oc-a", machine.id, (target) => boxd.exec(target, "true", { timeoutSeconds: 5, json: false }, context())))
    expect(error?.code).toBe("AGENT_UNREACHABLE")
  })
})

describe("exec and copies", () => {
  const readTarget = (listing: ReadTarget["listing"], name = "oc-a"): ReadTarget => ({ region: "fra", name: name as `oc-${string}`, listing, machineId: null })

  test("a read exec on a running machine runs; on a hibernated one it is refused before any exec, so nothing wakes", async () => {
    fake.machine({ name: "oc-a", region: "fra" })
    fake.machine({ name: "oc-b", region: "fra", status: "hibernated" })
    const listing = await boxd.list({ maxAgeMs: 0 }, context())
    const ran = await boxd.exec(readTarget(listing), "echo hello", { timeoutSeconds: 5, json: false }, context())
    expect([ran.code, ran.stdout]).toEqual([0, "hello\n"])
    const refused = await fail(boxd.exec(readTarget(listing, "oc-b"), "echo hello", { timeoutSeconds: 5, json: false }, context()))
    expect(refused?.code).toBe("MACHINE_ASLEEP")
    expect(fake.calls().filter((call) => call.includes("oc-b"))).toEqual([])
    expect(fake.read().wokenByExec ?? []).toEqual([])
  })

  test("a listing older than 2 s is refused for a read", async () => {
    fake.machine({ name: "oc-a", region: "fra" })
    const listing = await boxd.list({ maxAgeMs: 0 }, context())
    const old = { ...listing, takenAt: listing.takenAt - 2_500 }
    expect((await fail(boxd.exec(readTarget(old), "true", { timeoutSeconds: 5, json: false }, context())))?.details.rule).toBe("listing-age")
  })

  test("the remote exit code comes back as the result; with --json the output is boxd's merged output", async () => {
    const machine = fake.machine({ name: "oc-a", region: "fra" })
    const plain = await owned("fra", "oc-a", machine.id, (target) => boxd.exec(target, "echo out; echo err >&2; exit 3", { timeoutSeconds: 5, json: false }, context()))
    expect([plain.code, plain.stdout, plain.stderr]).toEqual([3, "out\n", "err\n"])
    const json = await owned("fra", "oc-a", machine.id, (target) => boxd.exec(target, "echo out; exit 4", { timeoutSeconds: 5, json: true }, context()))
    expect([json.code, json.stdout]).toEqual([4, "out\n"])
  })

  test("boxd's own timeout ends the remote command, and stdin reaches it", async () => {
    const machine = fake.machine({ name: "oc-a", region: "fra" })
    const slow = await owned("fra", "oc-a", machine.id, (target) => boxd.exec(target, "sleep 5", { timeoutSeconds: 1, json: false }, context()))
    expect(slow.code).toBe(124)
    const echoed = await owned("fra", "oc-a", machine.id, (target) => boxd.exec(target, "cat", { timeoutSeconds: 5, json: false, stdin: '{"a":1}' }, context()))
    expect(echoed.stdout).toBe('{"a":1}')
  })

  test("copies go by name to and from the guest; a read target can never upload", async () => {
    const machine = fake.machine({ name: "oc-a", region: "fra" })
    const local = join(fake.dir, "up.txt")
    writeFileSync(local, "bytes")
    await owned("fra", "oc-a", machine.id, (target) => boxd.copyTo(target, local, "/home/boxd/up.txt", context()))
    const listing = await boxd.list({ maxAgeMs: 0 }, context())
    await boxd.copyFrom(readTarget(listing), "/home/boxd/up.txt", join(fake.dir, "down.txt"), context())
    expect(await Bun.file(join(fake.dir, "down.txt")).text()).toBe("bytes")
    await expect(runner.withMachineLock({ id: machine.id as MachineId }, context(), () => boxd.copyTo(readTarget(listing) as unknown as ChangeTarget, local, "/home/boxd/x", context()))).rejects.toThrow(/checkOwned/)
    expect(fake.calls().filter((call) => call.startsWith("machine cp"))).toEqual([
      `machine cp ${local} oc-a:/home/boxd/up.txt --region fra`,
      `machine cp oc-a:/home/boxd/up.txt ${join(fake.dir, "down.txt")} --region fra`,
    ])
  })
})

describe("the CLI itself", () => {
  test("the flavour check runs once per binary, as one flight, and refuses the in-VM CLI", async () => {
    await Promise.all([boxd.list({ maxAgeMs: 10_000 }, context()), boxd.machineLimit(context()), boxd.snapshots(context())])
    expect(fake.spawns().filter((spawn) => spawn.argv[0] === "--help")).toHaveLength(1)
    fake.update((state) => void (state.inVm = true))
    const fresh = createBoxdCli({ bin: fake.bin, runner: createRunner() })
    const error = await fail(fresh.list({ maxAgeMs: 0 }, context()))
    expect(error?.code).toBe("BOXD_MISSING")
    expect(error?.what).toContain("inside a boxd machine")
  })

  test("a CLI that waits for a browser sign-in is cut by the timeout and answers BOXD_MISSING", async () => {
    fake.fault("machine list", { stdout: "Not logged in. Let's fix that.\n\n  Please go to this URL manually and complete the sign-in:\n", hang: 30_000 })
    const slow = createBoxdCli({ bin: fake.bin, runner: createRunner({ killGraceMs: 100 }) })
    await slow.assertLaptopCli(context())
    const started = Date.now()
    const error = await fail(slow.list({ maxAgeMs: 0 }, { ...context(), signal: AbortSignal.timeout(60_000) }))
    // The real bound is 15 s; the fake answers the sign-in at once and then waits.
    expect(error?.code).toBe("BOXD_MISSING")
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 30_000)

  test("an unknown failure is BOXD_FAILED with the CLI's words, never missing", async () => {
    fake.fault("machine get", { stderr: "error: unexpected argument '--frobnicate' found", code: 2 })
    const error = await fail(boxd.get("fra", "oc-a", context()))
    expect([error?.code, error?.details.kind]).toEqual(["BOXD_FAILED", "unknown"])
  })

  test("every child carries its call's tag: nothing bypasses the runner", async () => {
    const machine = fake.machine({ name: "oc-a", region: "fra" })
    await boxd.list({ maxAgeMs: 0 }, context("call_one"))
    await owned("fra", "oc-a", machine.id, (target) => boxd.hibernate(target, context("call_two")))
    const spawns = fake.spawns()
    expect(spawns.filter((spawn) => spawn.call === null)).toEqual([])
    expect(spawns.map((spawn) => spawn.call).sort()).toEqual(["call_one", "call_one", "call_test", "call_two"])
  })
})
