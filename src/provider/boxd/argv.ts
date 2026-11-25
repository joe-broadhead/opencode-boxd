/**
 * Argv for the laptop boxd CLI (0.3.8), one builder per verb: never a shell string, `--region` on every machine,
 * snapshot and list verb, a machine id wherever the CLI takes "machine name or ID", and never `--shared` or
 * `--isolated`. Its recorded `--help` is `test/fixtures/boxd-cli-help.json`. Pure, so `test/unit/boxd-argv.test.ts`
 * pins each one.
 */
import { boxdError } from "../../errors.js"
import type { ChangeTarget, CreateBuilder, CreateWork, MachineId, MachineName, Region, Size } from "../../ports.js"
import { SIZE_VCPU, WORK_LABELS } from "../../ports.js"

const WORK_ID = /^[a-z][a-z0-9-]{0,24}$/
const SNAPSHOT = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MACHINE = /^[a-z0-9][a-z0-9-]{0,62}$/
const LABEL_KEY = /^[a-z0-9._/-]{1,63}$/
const LABEL_VALUE = /^[A-Za-z0-9._/@:-]{0,63}$/
const ID = /^[A-Za-z0-9_-]{1,80}$/
/** A guest path: absolute, no spaces, no `..`. */
const GUEST_PATH = /^\/[A-Za-z0-9_./-]+$/

const invalid = (what: string) => boxdError("NAME_INVALID", what)

export function machineArg(name: string): MachineName {
  if (!MACHINE.test(name)) throw invalid(`"${name}" is not a boxd machine name.`)
  return name as MachineName
}

export function idArg(id: MachineId): string {
  if (!ID.test(id)) throw invalid(`"${id}" is not a boxd machine id.`)
  return id
}

export function snapshotArg(name: string): string {
  if (!SNAPSHOT.test(name)) throw invalid(`Snapshot name "${name}" is not a boxd snapshot name: up to 64 lowercase letters, digits, dots, underscores or hyphens.`)
  return name
}

export function guestPathArg(path: string): string {
  if (!GUEST_PATH.test(path) || path.split("/").includes("..")) throw invalid(`"${path}" is not an absolute guest path without spaces or "..".`)
  return path
}

function labelArgs(labels: Readonly<Record<string, string>>): string[] {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, value]) => {
      if (!LABEL_KEY.test(key) || !LABEL_VALUE.test(value)) throw invalid(`The label ${key}=${value} is not a boxd label.`)
      return ["--label", `${key}=${value}`]
    })
}

/** Every list: one call for every region. */
export const listArgs = () => ["machine", "list", "--region", "all", "--json"]

export const getArgs = (region: Region, nameOrId: string) => ["machine", "get", nameOrId, "--region", region, "--json"]

/**
 * A work machine from its golden image, with the cost bounds of design §C.2 set in the same call (F7): auto-suspend
 * off, auto-hibernate, `idle.ignore-outbound` off, and `--delete-after` only with `leaseDays`. The size comes from the
 * image: boxd refuses `--vcpu` with `--from-snapshot`, so nothing is resized after.
 */
export function createWorkArgs(input: CreateWork): string[] {
  if (!WORK_ID.test(input.workId) || input.name !== `oc-${input.workId}`) throw invalid(`A work machine is oc-<work id>, not ${input.name}.`)
  if (!Number.isInteger(input.autoHibernateSeconds) || input.autoHibernateSeconds < 60) throw invalid("autoHibernateSeconds must be whole seconds, at least 60.")
  if (input.leaseDays !== undefined && (!Number.isInteger(input.leaseDays) || input.leaseDays < 1)) throw invalid("leaseDays must be a whole number of days, at least 1.")
  return [
    "machine",
    "new",
    machineArg(input.name),
    "--region",
    input.region,
    "--from-snapshot",
    snapshotArg(input.image),
    ...labelArgs({ ...WORK_LABELS, work: input.workId }),
    "--auto-suspend-timeout",
    String(input.autoSuspendSeconds),
    "--auto-hibernate-timeout",
    String(input.autoHibernateSeconds),
    "--idle-ignore-outbound=off",
    ...(input.leaseDays !== undefined ? ["--delete-after", `${input.leaseDays}d`] : []),
    "--json",
  ]
}

/** A golden builder: stock with its size, or a base snapshot (resized after the restore); always `--delete-after`. */
export function createBuilderArgs(input: CreateBuilder): string[] {
  if (!/^\d+[smhd]$|^\d+h\d+m$/.test(input.deleteAfter)) throw invalid(`deleteAfter "${input.deleteAfter}" is not a boxd duration such as 2h.`)
  return [
    "machine",
    "new",
    machineArg(input.name),
    "--region",
    input.region,
    ...(input.base === "stock" ? ["--vcpu", String(SIZE_VCPU[input.size])] : ["--from-snapshot", snapshotArg(input.base.snapshot)]),
    "--label",
    "role=golden-builder",
    "--delete-after",
    input.deleteAfter,
    "--json",
  ]
}

const byId = (verb: string, target: ChangeTarget, ...rest: string[]) => ["machine", verb, idArg(target.machineId), ...rest, "--region", target.region]

export const wakeArgs = (target: ChangeTarget) => [...byId("wake", target), "--json"]
export const hibernateArgs = (target: ChangeTarget) => [...byId("hibernate", target), "--json"]
export const removeArgs = (target: ChangeTarget) => [...byId("remove", target, "-y"), "--json"]
export const rebootArgs = (target: ChangeTarget) => [...byId("reboot", target), "--json"]
/** `-y` confirms the reboot that applies the size. */
export const resizeArgs = (target: ChangeTarget, size: Size) => [...byId("resize", target, "--vcpu", String(SIZE_VCPU[size]), "-y"), "--json"]
/** `-y` confirms the reboot a rename makes. */
export const renameArgs = (target: ChangeTarget, to: MachineName) => [...byId("rename", target, machineArg(to), "-y"), "--json"]

/** One label per call: `machine label set` takes a key and a value. */
export function labelSetArgs(target: ChangeTarget, key: string, value: string): string[] {
  if (!LABEL_KEY.test(key) || !LABEL_VALUE.test(value)) throw invalid(`The label ${key}=${value} is not a boxd label.`)
  return ["machine", "label", "set", idArg(target.machineId), key, value, "--region", target.region]
}

export function leaseArgs(target: ChangeTarget, days: number): string[] {
  if (!Number.isInteger(days) || days < 1) throw invalid("A lease is a whole number of days, at least 1.")
  return ["machine", "config", "set", idArg(target.machineId), "delete-after", `${days}d`, "--region", target.region]
}

/**
 * `machine exec` with boxd's own timeout, so boxd kills the remote side too. The command is one argument after `--`:
 * the remote side runs it through a shell. `--json` merges stdout and stderr into one `output`, so `boxd_exec` leaves
 * it off.
 */
export function execArgs(region: Region, machine: MachineName, command: string, timeoutSeconds: number, json: boolean): string[] {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) throw invalid("An exec timeout is whole seconds, at least 1.")
  if (command.trim() === "") throw invalid("An exec needs a command.")
  return ["machine", "exec", machineArg(machine), "--region", region, "--timeout", String(timeoutSeconds), ...(json ? ["--json"] : []), "--", command]
}

export const copyToArgs = (region: Region, machine: MachineName, localPath: string, guestPath: string) => [
  "machine",
  "cp",
  localPath,
  `${machineArg(machine)}:${guestPathArg(guestPath)}`,
  "--region",
  region,
]

export const copyFromArgs = (region: Region, machine: MachineName, guestPath: string, localPath: string) => [
  "machine",
  "cp",
  `${machineArg(machine)}:${guestPathArg(guestPath)}`,
  localPath,
  "--region",
  region,
]

export const machineLimitArgs = () => ["manage", "machine-limit", "--json"]

/** `since` is boxd's own form: a duration back from now, a UTC date or time, or unix seconds. */
export function usageArgs(since: string): string[] {
  if (!/^(?:\d+[hdw]|\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?Z)?|\d{9,11})$/.test(since)) throw invalid(`"${since}" is not a boxd --since value.`)
  return ["manage", "usage", "--since", since, "--json"]
}

export const snapshotsArgs = () => ["snapshots", "list", "--region", "all", "--json"]
export const saveSnapshotArgs = (builder: ChangeTarget, name: string) => ["snapshots", "save", idArg(builder.machineId), snapshotArg(name), "--region", builder.region, "--json"]
export const removeSnapshotArgs = (region: Region, name: string) => ["snapshots", "rm", snapshotArg(name), "-y", "--region", region, "--json"]
/** The account's variables: only the sealed ones are read, and boxd never prints their values. */
export const envListArgs = () => ["env", "list", "--json"]
