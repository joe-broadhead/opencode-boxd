/**
 * The boxd CLI port, v1 (design §4.1, §3): the laptop CLI 0.3.8 through the runner. Every call passes `--region` (or
 * `--region all` for a list), every change acts on a machine id that `checkOwned` resolved in this call, a read exec
 * passes the read rule first, and every failure is read through the one stderr table (`./errors-table.ts`).
 *
 * The shared answers: one listing flight at a time for every caller that accepts an age (a caller that needs a fresh
 * one and the "gone" rule take their own), the machine limit cached for 60 s, and the snapshots for
 * 5 minutes. The CLI flavour check runs once per binary, as one flight (F9).
 */
import { BoxdError, boxdError } from "../../errors.js"
import { machineWorkLabels } from "../../names.js"
import { partialOutput, type PluginRunner } from "../runner.js"
import {
  BUILDER_LABELS,
  CALL_BOUND_MS,
  TIMEOUTS,
  LEDGER_LABEL,
  REGISTRY_LABELS,
  SHARED_LABEL,
  WORK_LABELS,
  type BoxdPort,
  type ChangeTarget,
  type CreatedMachine,
  type FetchedMachine,
  type Listing,
  type MachineId,
  type MachineInfo,
  type MachineLimit,
  type MachineLockKey,
  type MachineName,
  type MachineStatus,
  type Owned,
  type OpContext,
  type ReadTarget,
  type Region,
  type SnapshotRow,
  type SpawnResult,
} from "../../ports.js"
import {
  backupsArgs,
  copyFromArgs,
  copyStdinToArgs,
  copyToArgs,
  copyTreeArgs,
  createBuilderArgs,
  createRegistryArgs,
  createWorkArgs,
  envListArgs,
  execArgs,
  getArgs,
  hibernateArgs,
  labelSetArgs,
  leaseArgs,
  listArgs,
  machineLimitArgs,
  rebootArgs,
  removeArgs,
  removeSnapshotArgs,
  renameArgs,
  resizeArgs,
  saveSnapshotArgs,
  snapshotsArgs,
  usageArgs,
  wakeArgs,
} from "./argv.js"
import { classify, failure, type Asked } from "./errors-table.js"
import { assertLaptopCli } from "./flavor.js"
import { parseCreated, parseJson, parseListing, parseMachine, parseMachineLimit, parseSecrets, parseSnapshots, parseUsage, regionLimits } from "./parse.js"

export interface BoxdCliOptions {
  /** The laptop boxd binary; `boxd` on the server's PATH by default. */
  readonly bin?: string
  readonly runner: PluginRunner
  readonly now?: () => number
}

/** A change verb's bound: the CLI answers once boxd has the change; a create and the reboots have their own. */
const CHANGE_MS = TIMEOUTS.helperChange
/** `machine usage` and `manage usage` are for owners and admins; a member gets this refusal. */
const USAGE_REFUSED = /\bowners? and admins? only\b|\bonly (?:org )?(?:owners|admins)\b|\bnot (?:an? )?(?:owner|admin)\b|\bforbidden\b|\b403\b/i

/**
 * How long a read keeps retrying on fresh listings before its refusal is the caller's (it then reads as stale): the call
 * bound `B`. A count would not do: one listing serves only the reads that get a slot within its 2 s, so with many reads
 * queued on a slow machine every read but those few ages out once per listing, while the queue still drains in order.
 * A read that cannot run for another reason (its machine not running, a failed listing) is refused at once.
 */
const READ_RETRY_BOUND_MS = CALL_BOUND_MS
/** How young a listing a retried read takes: most of the 2 s the read rule allows is left for its wait at the front. */
const RETRY_LISTING_MAX_AGE_MS = TIMEOUTS.readListingMaxAgeMs / 4
/** The listing failures a read may wait out: boxd answered with an unknown failure, or not in time. */
const TRANSIENT: ReadonlySet<string> = new Set(["BOXD_FAILED", "TIMEOUT"])
const isListingAge = (error: unknown) => error instanceof BoxdError && error.details.rule === "listing-age"

export function createBoxdCli(options: BoxdCliOptions): BoxdPort {
  const bin = options.bin ?? "boxd"
  const runner = options.runner
  const now = options.now ?? Date.now
  /** A change outside its machine's lock is a bug, not a race. */
  const holds = (key: MachineLockKey) => runner.holds(key)

  let listing: Listing | undefined
  let limits: { readonly at: number; readonly value: MachineLimit } | undefined
  let snapshots: { readonly at: number; readonly value: readonly SnapshotRow[] } | undefined

  /** One CLI call: the flavour check first, then the child in its pool, then the stderr table on a failure. */
  async function cli(args: readonly string[], context: OpContext, timeoutMs: number, asked: Asked = {}, guard?: () => void, front = false, stdin?: string): Promise<SpawnResult> {
    await assertLaptopCli(bin, runner, context)
    const command = `boxd ${args.filter((arg) => !arg.startsWith("-")).slice(0, 2).join(" ")}`
    let result: SpawnResult
    try {
      result = await runner.spawn({ ...context, bin, args, timeoutMs, ...(stdin !== undefined ? { stdin } : {}), ...(guard ? { guard } : {}), ...(front ? { front } : {}) })
    } catch (error) {
      // A CLI that is not signed in starts a browser sign-in and waits: the timeout cut it, and its words say why.
      const partial = partialOutput(error)
      if (error instanceof BoxdError && error.code === "TIMEOUT" && partial && classify(`${partial.stdout}\n${partial.stderr}`).kind === "auth") {
        throw boxdError("BOXD_MISSING", "The laptop boxd CLI is not signed in: it asked for a browser sign-in.")
      }
      throw error
    }
    if (result.code !== 0) throw failure(command, `${result.stderr}\n${result.stdout}`, asked)
    return result
  }

  /**
   * Every change: the target came from `checkOwned` in this call, and the caller holds its machine's lock. `boxd_exec`
   * (an exec in the `exec` pool) is the one change that takes no machine lock (M4), so a long command never blocks the
   * work's other calls; it still acts only on a checked target.
   */
  function change(target: ChangeTarget, pool?: OpContext["pool"]): void {
    if (!isChangeTarget(target)) throw new Error("A machine change needs a target from checkOwned, which resolves the name to the recorded id.")
    if (pool === "exec") return
    if (holds && !holds({ id: target.machineId })) throw new Error(`A change to ${target.machineId} must run inside runner.withMachineLock({ id }).`)
  }

  async function takeListing(context: OpContext): Promise<Listing> {
    // Queued reads wait for this listing, so it waits at the front of its pool.
    const result = await cli(listArgs(), context, TIMEOUTS.cliRead, {}, undefined, true)
    const machines = parseListing(parseJson(result.stdout, "boxd machine list"))
    return { takenAt: now(), fresh: true, machines }
  }

  async function get(region: Region, nameOrId: string, context: OpContext): Promise<FetchedMachine> {
    const result = await cli(getArgs(region, nameOrId), context, TIMEOUTS.cliRead, { machine: nameOrId, region })
    const info = parseMachine(parseJson(result.stdout, "boxd machine get"), region, "boxd machine get")
    // A claim by labels, for adopting a work with no recorded id only; never for a shared or isolated machine.
    return ownsLabels(info) && info.sharing === "private" && !info.isolated ? { ...info, owned: owned(info) } : info
  }

  /**
   * The one place a change target is made, for a machine this process just read or made with this id, with the status
   * that same answer showed. Only `get`, `create` and `checkOwned` call it.
   */
  const owned = (info: { readonly region: Region; readonly name: string; readonly id: MachineId; readonly status: MachineStatus; readonly labels: Readonly<Record<string, string>> }): Owned => ({
    target: { region: info.region, name: info.name as MachineName, machineId: info.id, checkedAt: now() } as ChangeTarget,
    status: info.status,
    labels: info.labels,
  })

  /**
   * A read target on a listing young enough for the read rule: its own, or the shared one, refreshed when older than
   * `maxAgeMs`. A read retried after its listing aged in the queue asks for a younger one (`RETRY_LISTING_MAX_AGE_MS`),
   * so it does not start its next wait on a listing that is about to age out again.
   */
  async function readable(target: ReadTarget, context: OpContext, maxAgeMs: number = TIMEOUTS.readListingMaxAgeMs): Promise<ReadTarget> {
    target = newest(target)
    if (now() - target.listing.takenAt <= maxAgeMs) return target
    try {
      return { ...target, listing: await list({ maxAgeMs }, context) }
    } catch (error) {
      // Only a transient failure is a read to try again; a signed-out or missing CLI (`BOXD_MISSING`), or a stop, is
      // the caller's error as it is, so it fails at once.
      if (!(error instanceof BoxdError) || !TRANSIENT.has(error.code)) throw error
      // The listing failed, not the guest: nothing was read, and the caller may try again (`kind: "listing-failed"`).
      const code = error.code
      const reason = error.what
      throw boxdError(code, `The machine listing a read of ${target.name} needs failed (${reason.replace(/\.$/, "")}); nothing was read.`, { kind: "listing-failed", retryable: true })
    }
  }

  async function exec(target: ReadTarget | ChangeTarget, command: string, settings: { readonly timeoutSeconds: number; readonly json: boolean; readonly stdin?: string }, context: OpContext) {
    const args = execArgs(target.region, target.name, command, settings.timeoutSeconds, settings.json)
    await assertLaptopCli(bin, runner, context)
    let current = isChangeTarget(target) ? target : await readable(target, context)
    const started = now()
    let result: SpawnResult
    for (let attempt = 0; ; attempt++) {
      const guard = readGuard(current, context.pool)
      try {
        // boxd kills the remote command at its timeout; the laptop kills the CLI shortly after, should it not return.
        result = await runner.spawn({
          ...context,
          bin,
          args,
          timeoutMs: settings.timeoutSeconds * 1000 + TIMEOUTS.killGraceMs,
          ...(settings.stdin !== undefined ? { stdin: settings.stdin } : {}),
          ...(guard ? { guard } : {}),
          ...(attempt > 0 ? { front: true } : {}),
        })
        break
      } catch (error) {
        // A read whose listing aged while it waited for its slot: join a fresh shared listing, check again, and wait at
        // the front. Only a machine that listing does not show running is refused (`kind: "not-readable"`).
        if (isChangeTarget(current) || !isListingAge(error) || now() - started > READ_RETRY_BOUND_MS) throw error
        current = await readable(current, context, RETRY_LISTING_MAX_AGE_MS)
      }
    }
    if (settings.json) {
      if (result.code !== 0) {
        const classified = classify(`${result.stderr}\n${result.stdout}`, { machine: target.name, region: target.region })
        if (classified.kind !== "unknown" || !result.stdout.includes("exit_code")) throw failure("boxd machine exec", `${result.stderr}\n${result.stdout}`, { machine: target.name, region: target.region })
      }
      const answer = parseJson(result.stdout, "boxd machine exec") as { output?: unknown; exit_code?: unknown }
      return { code: typeof answer.exit_code === "number" ? answer.exit_code : result.code, stdout: typeof answer.output === "string" ? answer.output : "", stderr: result.stderr, ms: result.ms }
    }
    // Without --json the exit code is the remote command's own, so only the CLI's own known failures are raised here.
    if (result.code !== 0 && classify(result.stderr, { machine: target.name, region: target.region }).kind !== "unknown") {
      throw failure("boxd machine exec", result.stderr, { machine: target.name, region: target.region })
    }
    return result
  }

  async function list(settings: { readonly maxAgeMs: number }, context: OpContext): Promise<Listing> {
    if (settings.maxAgeMs <= 0) {
      // The gone rule and the import need a listing taken in this call; it still refreshes the shared one.
      listing = await takeListing(context)
      return listing
    }
    if (listing && now() - listing.takenAt <= settings.maxAgeMs) return { ...listing, fresh: false }
    const taken = await runner.join("boxd:list", context, takeListing)
    listing = taken
    return { ...taken, fresh: false }
  }

  /**
   * A change target passes the change check now; a read target passes the read rule now, so a refused read starts
   * nothing, and again when its slot is granted, so a read that waited in a queue never starts on a listing that has
   * since gone stale or on a machine that has since gone to sleep (M1).
   */
  function readGuard(target: ReadTarget | ChangeTarget, pool?: OpContext["pool"]): (() => void) | undefined {
    if (isChangeTarget(target)) {
      change(target, pool)
      return undefined
    }
    runner.assertReadable(newest(target))
    // At the slot, the newest shared listing counts too: one refresh every 2 s serves every read still queued.
    return () => runner.assertReadable(newest(target))
  }

  /** A read target on the newer of its own listing and the shared one. */
  function newest(target: ReadTarget): ReadTarget {
    return listing && listing.takenAt > target.listing.takenAt ? { ...target, listing: { ...listing, fresh: false } } : target
  }

  return {
    assertLaptopCli: (context) => assertLaptopCli(bin, runner, context),

    list,

    get,

    async checkOwned(region, name, machineId, context) {
      const info = await get(region, name, context)
      if (info.id !== machineId) {
        throw boxdError("NOT_OURS", `${name} in ${region} is machine ${info.id}, not the recorded ${machineId}. Nothing was changed.`, { machine: name, region, found: info.id })
      }
      // The name was resolved to the recorded id in this call.
      return owned(info)
    },

    async create(input, context): Promise<CreatedMachine> {
      const key: MachineLockKey = { create: { region: input.region, name: input.name as MachineName } }
      if (holds && !holds(key)) throw new Error(`A create of ${input.name} must run inside runner.withMachineLock({ create: { region, name } }).`)
      const args = input.kind === "work" ? createWorkArgs(input) : input.kind === "builder" ? createBuilderArgs(input) : createRegistryArgs(input)
      let result: SpawnResult
      try {
        result = await cli(args, context, TIMEOUTS.create, { machine: input.name, region: input.region })
      } catch (error) {
        // A create cut off by its bound may still land: say so, and let the next ensure adopt it.
        if (error instanceof BoxdError && error.code === "TIMEOUT") throw boxdError("CREATE_UNCERTAIN", `boxd machine new ${input.name} in ${input.region} did not answer within ${TIMEOUTS.create / 1000} s.`)
        throw error
      }
      const created = parseCreated(parseJson(result.stdout, "boxd machine new"), "boxd machine new")
      if (created.name !== input.name) {
        // Never brand a machine boxd named differently: nothing is recorded, and the next ensure finds what landed.
        throw boxdError("BOXD_FAILED", `boxd machine new ${input.name} in ${input.region} answered for machine ${created.name}. Nothing was recorded.`, { machine: input.name, region: input.region })
      }
      listing = undefined
      // `machine new --json` names the machine and its id only. A create never asks for --shared or --isolated, so the
      // machine is private and not isolated; its labels are the ones set here, merged over the image's.
      const info: MachineInfo = {
        id: created.id,
        name: created.name,
        region: input.region,
        status: "starting",
        size: input.kind === "builder" ? input.size : null,
        labels:
          input.kind === "builder"
            ? { ...BUILDER_LABELS }
            : input.kind === "registry"
              ? { ...REGISTRY_LABELS, [LEDGER_LABEL]: input.ledger }
              : input.shared !== undefined
                ? { ...WORK_LABELS, [SHARED_LABEL]: input.shared, [LEDGER_LABEL]: input.ledger }
                : { ...WORK_LABELS, work: input.workId, [LEDGER_LABEL]: input.ledger, ...machineWorkLabels(input.labels) },
        sharing: "private",
        isolated: false,
      }
      // This process made it and boxd answered its id: it is ours to change.
      return { ...info, owned: owned(info) }
    },

    async wake(target, context) {
      change(target)
      await cli(wakeArgs(target), context, CHANGE_MS, { machine: target.machineId, region: target.region })
      listing = undefined
    },

    async hibernate(target, context) {
      change(target)
      await cli(hibernateArgs(target), context, CHANGE_MS, { machine: target.machineId, region: target.region })
      listing = undefined
    },

    async remove(target, context) {
      change(target)
      await cli(removeArgs(target), context, CHANGE_MS, { machine: target.machineId, region: target.region })
      listing = undefined
    },

    async resize(target, size, context) {
      change(target)
      await cli(resizeArgs(target, size), context, TIMEOUTS.resize, { machine: target.machineId, region: target.region })
      listing = undefined
    },

    async reboot(target, context) {
      change(target)
      await cli(rebootArgs(target), context, TIMEOUTS.reboot, { machine: target.machineId, region: target.region })
      listing = undefined
    },

    async rename(target, to, context) {
      change(target)
      await cli(renameArgs(target, to), context, TIMEOUTS.reboot, { machine: target.machineId, region: target.region })
      listing = undefined
    },

    async setLabels(target, labels, context) {
      change(target)
      // One call per label, in key order: `machine label set` takes one key and one value.
      for (const [key, value] of Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))) {
        await cli(labelSetArgs(target, key, value), context, CHANGE_MS, { machine: target.machineId, region: target.region })
      }
      listing = undefined
    },

    async renewLease(target, days, context) {
      change(target)
      await cli(leaseArgs(target, days), context, CHANGE_MS, { machine: target.machineId, region: target.region })
    },

    async setBackups(target, period, context) {
      change(target)
      await cli(backupsArgs(target, period), context, CHANGE_MS, { machine: target.machineId, region: target.region })
    },

    exec,

    async copyTo(target, localPath, guestPath, context) {
      // A read never uploads: only a target from checkOwned can be copied to.
      change(target)
      await cli(copyToArgs(target.region, target.name, localPath, guestPath), context, TIMEOUTS.cp, { machine: target.name, region: target.region })
    },

    async copyTree(target, localPath, guestPath, context) {
      change(target)
      await cli(copyTreeArgs(target.region, target.name, localPath, guestPath), context, TIMEOUTS.cp, { machine: target.name, region: target.region })
    },

    async copyStdinTo(target, guestPath, data, context) {
      change(target)
      await cli(copyStdinToArgs(target.region, target.name, guestPath), context, TIMEOUTS.cp, { machine: target.name, region: target.region }, undefined, false, data)
    },

    async copyFrom(target, guestPath, localPath, context) {
      const guard = readGuard(target)
      await cli(copyFromArgs(target.region, target.name, guestPath, localPath), context, TIMEOUTS.cp, { machine: target.name, region: target.region }, guard)
    },

    async machineLimit(context) {
      if (limits && now() - limits.at <= TIMEOUTS.machineLimitCacheMs) return limits.value
      return runner.join("boxd:machine-limit", context, async (flight) => {
        const result = await cli(machineLimitArgs(), flight, TIMEOUTS.cliRead)
        const answer = parseMachineLimit(parseJson(result.stdout, "boxd manage machine-limit"))
        // The org-wide answer is one limit that every region applies to its own machines (provisional until live
        // check L3): each region's use is counted from the listing, never taken from the org's total. The
        // organisation's limit is the one boxd stated, or the sum of the regions' own.
        const value: MachineLimit =
          "perRegion" in answer
            ? { org: answer.perRegion.reduce((sum, region) => sum + region.limit, 0), regions: answer.perRegion }
            : { org: answer.limit, regions: regionLimits(answer.limit, (await list({ maxAgeMs: TIMEOUTS.phaseListingMaxAgeMs }, flight)).machines) }
        limits = { at: now(), value }
        return value
      })
    },

    async usage(since, context) {
      try {
        const result = await cli(usageArgs(since), context, TIMEOUTS.cliRead)
        return parseUsage(parseJson(result.stdout, "boxd manage usage"), new Date(now()).toISOString())
      } catch (error) {
        if (error instanceof BoxdError && error.code === "BOXD_FAILED" && USAGE_REFUSED.test(error.what)) {
          return { available: false, reason: "boxd's machine usage is for organisation owners and admins." }
        }
        throw error
      }
    },

    async snapshots(context) {
      if (snapshots && now() - snapshots.at <= TIMEOUTS.snapshotsCacheMs) return snapshots.value
      return runner.join("boxd:snapshots", context, async (flight) => {
        const result = await cli(snapshotsArgs(), flight, TIMEOUTS.cliRead)
        const value = parseSnapshots(parseJson(result.stdout, "boxd snapshots list"))
        snapshots = { at: now(), value }
        return value
      })
    },

    async saveSnapshot(builder, name, context) {
      change(builder)
      await cli(saveSnapshotArgs(builder, name), context, TIMEOUTS.goldenStep, { machine: builder.machineId, region: builder.region })
      snapshots = undefined
    },

    async removeSnapshot(region, name, context) {
      await cli(removeSnapshotArgs(region, name), context, CHANGE_MS, { region })
      snapshots = undefined
    },

    async secrets(context) {
      const result = await cli(envListArgs(), context, TIMEOUTS.cliRead)
      return parseSecrets(parseJson(result.stdout, "boxd env list"))
    },
  }
}

/** Only `checkOwned` makes a target with `checkedAt`: the proof that the name was resolved to the id in this call. */
export function isChangeTarget(target: ReadTarget | ChangeTarget): target is ChangeTarget {
  return "checkedAt" in target && typeof (target as ChangeTarget).checkedAt === "number" && "machineId" in target && typeof target.machineId === "string" && !("listing" in target)
}

/**
 * The plugin's ownership labels (design §3.4 step 2): `owner=boxd` and `work=<id>`, whose `oc-<id>` is the
 * machine's name, or `shared=<name>`, whose `oc-shared-<name>` is the shared machine's name. A machine renamed by hand
 * keeps the label of the work it belonged to, so its name no longer matches and it gets no adoption target.
 */
export function ownsLabels(info: Pick<MachineInfo, "name" | "labels">): boolean {
  if (info.labels.owner !== WORK_LABELS.owner) return false
  const named = typeof info.labels.work === "string" && info.name === `oc-${info.labels.work}`
  const shared = typeof info.labels[SHARED_LABEL] === "string" && info.name === `oc-shared-${info.labels[SHARED_LABEL]}`
  return named || shared
}
