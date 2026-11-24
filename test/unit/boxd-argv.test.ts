// Argv for the laptop CLI 0.3.8 (recorded in test/fixtures/boxd-cli-help.json), one builder per verb, and the readers of its JSON answers. Every machine verb passes
// --region, every change acts by id, a create carries the cost bounds of design §C.2, and nothing ever asks for
// --shared or --isolated.
import { describe, expect, test } from "bun:test"
import * as argv from "../../src/boxd/argv.js"
import { parseCreated, parseListing, parseMachine, parseMachineLimit, parseSecrets, parseSnapshots, parseUsage, regionLimits } from "../../src/boxd/parse.js"
import type { ChangeTarget, MachineId } from "../../src/ports.js"

// A test builds a target by hand; in the plugin only checkOwned makes one.
const target = { region: "nyc", name: "oc-review-api", machineId: "vm_0042" as MachineId, checkedAt: 1 } as unknown as ChangeTarget
const work = { kind: "work", region: "nyc", name: "oc-review-api", workId: "review-api", image: "oc-golden-2.2.6-4x16", autoSuspendSeconds: 0, autoHibernateSeconds: 7200 } as const

describe("argv", () => {
  test("a work's create: its image, the plugin's labels, the cost bounds, and the lease only when asked", () => {
    expect(argv.createWorkArgs(work)).toEqual([
      "machine", "new", "oc-review-api", "--region", "nyc", "--from-snapshot", "oc-golden-2.2.6-4x16",
      "--label", "owner=opencode-boxd", "--label", "role=session", "--label", "work=review-api",
      "--auto-suspend-timeout", "0", "--auto-hibernate-timeout", "7200", "--idle-ignore-outbound=off", "--json",
    ])
    expect(argv.createWorkArgs({ ...work, leaseDays: 3 })).toContain("--delete-after")
    expect(argv.createWorkArgs({ ...work, leaseDays: 3 }).join(" ")).toContain("--delete-after 3d --json")
    expect(argv.createWorkArgs(work).join(" ")).not.toMatch(/--shared|--isolated|--vcpu/)
    expect(() => argv.createWorkArgs({ ...work, name: "oc-other" })).toThrow(/NAME_INVALID/)
  })

  test("a builder: stock with its size, or a base snapshot; always a delete-after timer", () => {
    expect(argv.createBuilderArgs({ kind: "builder", region: "fra", name: "oc-gb-fra-4x16-ab12", size: "4x16", base: "stock", deleteAfter: "2h" })).toEqual([
      "machine", "new", "oc-gb-fra-4x16-ab12", "--region", "fra", "--vcpu", "4", "--label", "role=golden-builder", "--delete-after", "2h", "--json",
    ])
    expect(argv.createBuilderArgs({ kind: "builder", region: "fra", name: "oc-gb-fra-4x16-ab12", size: "4x16", base: { snapshot: "my-base" }, deleteAfter: "2h" }).join(" ")).toBe(
      "machine new oc-gb-fra-4x16-ab12 --region fra --from-snapshot my-base --label role=golden-builder --delete-after 2h --json",
    )
  })

  test("every change acts on the machine id, in its region", () => {
    expect(argv.wakeArgs(target)).toEqual(["machine", "wake", "vm_0042", "--region", "nyc", "--json"])
    expect(argv.hibernateArgs(target)).toEqual(["machine", "hibernate", "vm_0042", "--region", "nyc", "--json"])
    expect(argv.removeArgs(target)).toEqual(["machine", "remove", "vm_0042", "-y", "--region", "nyc", "--json"])
    expect(argv.rebootArgs(target)).toEqual(["machine", "reboot", "vm_0042", "--region", "nyc", "--json"])
    expect(argv.resizeArgs(target, "8x32")).toEqual(["machine", "resize", "vm_0042", "--vcpu", "8", "-y", "--region", "nyc", "--json"])
    expect(argv.renameArgs(target, "oc-next")).toEqual(["machine", "rename", "vm_0042", "oc-next", "-y", "--region", "nyc", "--json"])
    expect(argv.labelSetArgs(target, "work", "next")).toEqual(["machine", "label", "set", "vm_0042", "work", "next", "--region", "nyc"])
    expect(argv.leaseArgs(target, 2)).toEqual(["machine", "config", "set", "vm_0042", "delete-after", "2d", "--region", "nyc"])
    expect(argv.saveSnapshotArgs(target, "oc-golden-2.2.6-2x8")).toEqual(["snapshots", "save", "vm_0042", "oc-golden-2.2.6-2x8", "--region", "nyc", "--json"])
  })

  test("reads: one list for every region, a get in its region, and the account's lists", () => {
    expect(argv.listArgs()).toEqual(["machine", "list", "--region", "all", "--json"])
    expect(argv.getArgs("fra", "oc-a")).toEqual(["machine", "get", "oc-a", "--region", "fra", "--json"])
    expect(argv.snapshotsArgs()).toEqual(["snapshots", "list", "--region", "all", "--json"])
    expect(argv.machineLimitArgs()).toEqual(["manage", "machine-limit", "--json"])
    expect(argv.usageArgs("2026-11-15")).toEqual(["manage", "usage", "--since", "2026-11-15", "--json"])
    expect(argv.usageArgs("24h")).toEqual(["manage", "usage", "--since", "24h", "--json"])
    expect(() => argv.usageArgs("yesterday; rm -rf")).toThrow(/NAME_INVALID/)
    expect(argv.removeSnapshotArgs("nyc", "oc-golden-2.2.5-2x8")).toEqual(["snapshots", "rm", "oc-golden-2.2.5-2x8", "-y", "--region", "nyc", "--json"])
    expect(argv.envListArgs()).toEqual(["env", "list", "--json"])
  })

  test("exec passes boxd's own timeout and the command as one argument after --; cp names guest paths with the machine", () => {
    expect(argv.execArgs("fra", "oc-a", "python3 /home/boxd/.opencode-boxd/guest.py", 8, false)).toEqual([
      "machine", "exec", "oc-a", "--region", "fra", "--timeout", "8", "--", "python3 /home/boxd/.opencode-boxd/guest.py",
    ])
    expect(argv.execArgs("fra", "oc-a", "free -m", 60, true)).toContain("--json")
    expect(argv.copyToArgs("fra", "oc-a", "/laptop/guest.py", "/home/boxd/.opencode-boxd-upload.py")).toEqual(["machine", "cp", "/laptop/guest.py", "oc-a:/home/boxd/.opencode-boxd-upload.py", "--region", "fra"])
    expect(argv.copyFromArgs("fra", "oc-a", "/home/boxd/.opencode-boxd/exports/ses_a.json", "/laptop/x.tmp")).toEqual(["machine", "cp", "oc-a:/home/boxd/.opencode-boxd/exports/ses_a.json", "/laptop/x.tmp", "--region", "fra"])
    expect(() => argv.copyFromArgs("fra", "oc-a", "/home/boxd/../etc/passwd", "/x")).toThrow(/NAME_INVALID/)
    expect(() => argv.execArgs("fra", "oc-a", "  ", 5, false)).toThrow(/NAME_INVALID/)
  })

  test("a name, an id, a label or a snapshot that is not boxd's own shape is refused before anything runs", () => {
    expect(() => argv.machineArg("oc-a b")).toThrow(/NAME_INVALID/)
    expect(() => argv.idArg("vm 1" as MachineId)).toThrow(/NAME_INVALID/)
    expect(() => argv.labelSetArgs(target, "Work", "x")).toThrow(/NAME_INVALID/)
    expect(() => argv.snapshotArg("Golden Image")).toThrow(/NAME_INVALID/)
  })
})

describe("the JSON readers", () => {
  test("a listing row needs its region; the size comes from vcpu; labels in any of boxd's forms", () => {
    const rows = parseListing([
      { name: "oc-a", region: "fra", status: "running", vcpu: 4, memory_bytes: 17179869184, sharing: "private", labels: { role: "session" } },
      { name: "oc-b", region: "nyc", status: "hibernating", size: "2 vCPU · 8 GiB", sharing: "shared", labels: ["work=b", "owner=opencode-boxd"], id: "vm_9" },
    ])
    expect(rows).toEqual([
      { name: "oc-a", region: "fra", id: null, status: "running", size: "4x16", labels: { role: "session" }, sharing: "private", isolated: null },
      { name: "oc-b", region: "nyc", id: "vm_9" as MachineId, status: "hibernated", size: "2x8", labels: { work: "b", owner: "opencode-boxd" }, sharing: "shared", isolated: null },
    ])
    expect(() => parseListing([{ name: "oc-a", status: "running" }])).toThrow(/known region/)
    expect(parseListing({ machines: [] })).toEqual([])
  })

  test("a get always has an id; isolated is the string yes or no", () => {
    expect(parseMachine({ name: "oc-a", id: "vm_1", status: "running", isolated: "yes", sharing: "private", vcpu: 1 }, "nyc", "get")).toMatchObject({ id: "vm_1", region: "nyc", isolated: true, size: "1x4" })
    expect(() => parseMachine({ name: "oc-a", status: "running" }, "nyc", "get")).toThrow(/without a name or an id/)
  })

  test("a create's answer must carry the id the work records at once", () => {
    expect(parseCreated({ boot: "11ms", id: "vm_7", name: "oc-a", paused_automations: 0 }, "new")).toEqual({ id: "vm_7" as MachineId, name: "oc-a" })
    expect(() => parseCreated({ boot: "11ms", name: "oc-a" }, "new")).toThrow(/no machine id/)
  })

  test("the machine limit per region; the org-wide answer is one limit each region applies to its own machines", () => {
    expect(parseMachineLimit({ regions: [{ region: "fra", limit: 300, in_use: 294 }, { region: "nyc", limit: 300, in_use: 12 }] })).toEqual({
      perRegion: [
        { region: "fra", limit: 300, inUse: 294, free: 6 },
        { region: "nyc", limit: 300, inUse: 12, free: 288 },
      ],
    })
    expect(parseMachineLimit({ max_vms: 10, machines: 12 })).toEqual({ limit: 10 })
    const rows = parseListing([
      { name: "oc-a", region: "fra", status: "running" },
      { name: "oc-b", region: "fra", status: "hibernated" },
      { name: "oc-c", region: "nyc", status: "running" },
    ])
    expect(regionLimits(10, rows)).toEqual([
      { region: "fra", limit: 10, inUse: 2, free: 8 },
      { region: "nyc", limit: 10, inUse: 1, free: 9 },
    ])
    expect(() => parseMachineLimit({})).toThrow(/no limit/)
  })

  test("usage: micro-units of the org's currency, cost per machine id, and the rate card", () => {
    const usage = parseUsage({ currency: "eur", complete: false, rates: { vcpu_hour_micro: 39000, ram_gib_hour_micro: 12000, disk_gib_hour_micro: 80 }, machines: [{ id: "vm_1", cost_micro: 420000 }] }, "2026-11-15T10:00:00.000Z")
    expect(usage).toEqual({
      available: true,
      currency: "EUR",
      total: 0.42,
      estimated: true,
      complete: false,
      asOf: "2026-11-15T10:00:00.000Z",
      rates: { currency: "EUR", vcpuHour: 0.039, ramGiBHour: 0.012, diskGiBHour: 0.00008, source: "usage" },
      machines: [{ machineId: "vm_1" as MachineId, cost: 0.42 }],
    })
  })

  test("snapshots without a known region are left out; secrets never carry a value", () => {
    expect(parseSnapshots([{ name: "a", region: "fra", storage: "local", status: "ready" }, { name: "b", storage: "local" }])).toEqual([{ region: "fra", name: "a", storage: "local", status: "ready" }])
    expect(parseSecrets({ env: [{ name: "PLAIN", value: "visible" }], secret: [{ name: "OPENCODE_API_KEY", scope: "private", domains: ["api.example.com"], value: "never" }] })).toEqual([
      { name: "OPENCODE_API_KEY", scope: "private", hosts: ["api.example.com"] },
    ])
  })
})
