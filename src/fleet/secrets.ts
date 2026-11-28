/**
 * A work's own secrets (boxd-plugin#146): the commands in the plugin option `workSecrets` mint one value per secret when
 * a work first exists, and revoke it when the work is dropped.
 *
 * The value goes from the mint command's standard output straight to `machine cp` on standard input, mode 600, under
 * the helper's own folder. It is never written here, put in the ledger, an event, a log line, a tool's output or an
 * argv. Only the secret's name is recorded, so an ensure mints each secret once and a drop can revoke every configured
 * secret by the work id.
 */
import { BoxdError, boxdError } from "../errors.js"
import type { WorkRecord } from "../ledger/types.js"
import type { WorkSecret } from "../options.js"
import { TIMEOUTS, type ChangeTarget, type OpContext, type SpawnResult } from "../ports.js"
import type { FleetServices } from "../services.js"

/** A secret is small; this stops a mint that prints a file from filling the helper's folder. */
const SECRET_MAX_BYTES = 64 * 1024

/** Where a work's secret file lives on its machine: the helper's own folder, or its slot's. */
export const secretFolder = (record: WorkRecord): string =>
  record.slot === true ? `/home/boxd/.boxd-plugin/slots/${record.workId}/secrets` : "/home/boxd/.boxd-plugin/secrets"

export const secretPath = (record: WorkRecord, name: string): string => `${secretFolder(record)}/${name}`

/** Runs one mint or revoke here, with the work id appended; its standard output is the minted value. */
async function runSecretCommand(services: FleetServices, verb: "mint" | "revoke", entry: WorkSecret, workId: string, op: OpContext): Promise<string> {
  const command = verb === "mint" ? entry.mint : entry.revoke
  if (!command) return ""
  const [bin, ...args] = command
  if (!bin) throw boxdError("SECRET_FAILED", `The ${verb} command for ${entry.name} has no program to run.`, { secret: entry.name })
  let result: SpawnResult
  try {
    result = await services.runner.spawn({ ...op, bin, args: [...args, workId], timeoutMs: TIMEOUTS.workSecret, stdoutCap: SECRET_MAX_BYTES })
  } catch (error) {
    if (error instanceof BoxdError && error.code === "CANCELLED") {
      throw boxdError("CANCELLED", `The call was stopped while the ${verb} command for ${entry.name} ran.`, { uncertain: true })
    }
    // Never the command, its output or its arguments: a mint may print the value, and an argv may hold one.
    throw boxdError("SECRET_FAILED", `The ${verb} command for ${entry.name} did not finish within ${TIMEOUTS.workSecret / 1000} s or could not run.`, { secret: entry.name })
  }
  if (result.code !== 0) throw boxdError("SECRET_FAILED", `The ${verb} command for ${entry.name} exited ${result.code}.`, { secret: entry.name })
  if (verb === "revoke") return ""
  const value = result.stdout.replace(/\r?\n$/, "")
  if (value === "") throw boxdError("SECRET_FAILED", `The mint command for ${entry.name} printed no value.`, { secret: entry.name })
  return value
}

/**
 * Mints every configured secret this work has no record of and copies it to the machine. A work whose session already
 * started is left as it is: its server's environment is not changed under a run. The work lock covers the mint and the
 * copy, so two calls for one work mint one value.
 */
export async function mintWorkSecrets(services: FleetServices, target: ChangeTarget, record: WorkRecord, op: OpContext): Promise<WorkRecord> {
  const configured = services.options.workSecrets
  if (configured.length === 0 || record.session?.rootId !== undefined) return record
  const wanted = configured.map((entry) => entry.name)
  const complete = (current: WorkRecord) => current.state !== "open" || current.session?.rootId !== undefined || wanted.every((name) => (current.secrets ?? []).includes(name))
  if (complete(record)) return record
  let current = record
  for (;;) {
    current = await services.ledger.update<WorkRecord>(
      [record.workId],
      async (records) => {
        const now = records.get(record.workId) ?? current
        if (complete(now)) return { write: [], value: now }
        const entry = configured.find((candidate) => !(now.secrets ?? []).includes(candidate.name))
        if (!entry) return { write: [], value: now }
        const value = await runSecretCommand(services, "mint", entry, now.workId, op)
        try {
          await services.runner.withMachineLock({ id: target.machineId }, op, () => services.boxd.copyStdinTo(target, secretPath(now, entry.name), value, op))
        } catch (error) {
          if (error instanceof BoxdError && error.code === "CANCELLED") throw error
          throw boxdError("SECRET_FAILED", `The value of ${entry.name} could not be copied to ${target.name}.`, { secret: entry.name })
        }
        const names = [...new Set([...(now.secrets ?? []), entry.name])].sort()
        const next: WorkRecord = { ...now, secrets: names }
        return { write: [next], value: next }
      },
      op,
    )
    if (complete(current)) return current
  }
}

/** Revokes every configured secret by the work id. A failure keeps the work open, so a drop removes no machine first. */
export async function revokeWorkSecrets(services: FleetServices, record: WorkRecord, op: OpContext): Promise<void> {
  for (const entry of services.options.workSecrets) {
    if (entry.revoke) await runSecretCommand(services, "revoke", entry, record.workId, op)
  }
}

/** A rebuilt machine has no secret files: revoke the old values, forget the names, then mint and copy new ones. */
export async function rotateWorkSecrets(services: FleetServices, target: ChangeTarget, record: WorkRecord, op: OpContext): Promise<WorkRecord> {
  if (services.options.workSecrets.length === 0) return record
  await revokeWorkSecrets(services, record, op)
  const cleared = await services.ledger.update<WorkRecord>(
    [record.workId],
    async (current) => {
      const now = current.get(record.workId) ?? record
      const { secrets: _old, ...rest } = now
      return { write: [rest], value: rest }
    },
    op,
  )
  return mintWorkSecrets(services, target, cleared, op)
}
