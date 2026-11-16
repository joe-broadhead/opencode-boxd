/**
 * `boxd_exec` (design §3.12): one command on a work's machine, with a timeout, for what the other tools do not cover.
 *
 * - **Its own pool** (M4): the command runs in the runner's `exec` pool (cap 4), outside the 12 shared slots, and holds
 *   neither the work's ledger lock nor the machine's lock while it runs. A ten-minute `gh pr checks --watch` blocks
 *   neither the work's `submit` (`interrupt` included), nor its reads, nor the watcher, nor other works.
 * - **By id:** the name is resolved to the recorded id first (`checkOwned`); only the wake takes the machine's lock.
 * - **Quoting** (L2): each argument is single-quoted for the remote shell, `'` written as `'\''`, so the argv means
 *   exactly what it says. Without `--json`, so stdout and stderr stay apart.
 * - It refuses a hibernated machine unless `wake: true`, and a reached `budget` with `action: "refuse"` refuses that
 *   wake. boxd kills the remote command at `timeout` (`machine exec --timeout`).
 *
 * Package C2 owns this file.
 */
import { boxdError } from "../errors.js"
import type { MachineId, MachineName, OpContext } from "../ports.js"
import { redactBlock } from "../redact.js"
import type { ExecResult } from "../results.js"
import { asleep, assertWorkIdInput, loadOpen, machineOf, untilRunning, nowIso, optionalBoolean, optionalInteger, withTarget, type ItemContext, type Services } from "./sessions-common.js"

/** The tail of each stream an answer keeps. */
const STDOUT_TAIL = 32 * 1024
const STDERR_TAIL = 8 * 1024
/** boxd's own update notice, which `machine exec` prints before the command's output (upstream ask 3). */
const BANNER = /^.*\bboxd\b.*\b(?:update|upgrade|new (?:version|release)|is available)\b.*$/i

export interface ExecItem {
  readonly workId: string
  readonly command: readonly string[]
  readonly timeout: number
  readonly wake: boolean
}

export function checkExec(input: Record<string, unknown>): ExecItem {
  const workId = assertWorkIdInput(input.workId)
  const command = input.command
  if (!Array.isArray(command) || command.length === 0 || !command.every((arg) => typeof arg === "string") || command[0] === "") {
    throw boxdError("NAME_INVALID", 'command must be a list of strings, the command first, such as ["git", "status"].', { field: "command" })
  }
  if (command.some((arg: string) => arg.includes("\u0000"))) throw boxdError("NAME_INVALID", "command must not hold a NUL character.", { field: "command" })
  return { workId, command, timeout: optionalInteger(input.timeout, "timeout", 1, 600) ?? 60, wake: optionalBoolean(input.wake, "wake") ?? false }
}

/** One argument for the remote shell: single-quoted, with `'` written as `'\''`. */
export const quote = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`

export async function execWork(services: Services, item: ExecItem, context: ItemContext): Promise<ExecResult> {
  const op: OpContext = context.op
  const record = await loadOpen(services, item.workId, op)
  const machine = await machineOf(services, record, op)
  // The by-id check, which also shows the status; only a wake takes the machine's lock, never the command.
  let { target, status } = await services.boxd.checkOwned(machine.region, record.machine as MachineName, machine.machineId, op)
  if (asleep(status)) {
    if (!item.wake) throw boxdError("MACHINE_ASLEEP", `${record.machine} is ${status}, and boxd_exec wakes it only with wake: true.`)
    await services.cost.assertBudget(op.call)
    target = await withTarget(services, record, machine, op, async (owned) => {
      if (asleep(owned.status)) await services.boxd.wake(owned.target, op)
      await untilRunning(services, owned.target, op)
      return owned.target
    })
    status = "running"
  }
  if (status === "starting") throw boxdError("MACHINE_STARTING", `${record.machine} is still starting.`)
  const result = await services.boxd.exec(target, item.command.map(quote).join(" "), { timeoutSeconds: item.timeout, json: false }, { ...op, pool: "exec" })
  await touch(services, item.workId, machine.machineId, op)
  const stdout = tail(withoutBanner(result.stdout), STDOUT_TAIL)
  const stderr = tail(withoutBanner(result.stderr), STDERR_TAIL)
  return { state: "ran", workId: item.workId, exitCode: result.code, stdout: redactBlock(stdout.text), stderr: redactBlock(stderr.text), truncated: stdout.cut || stderr.cut }
}

/** When a plugin call last touched the work, for automation's `orphanHours`; a short write after the command. */
async function touch(services: Services, workId: string, machineId: MachineId, op: OpContext): Promise<void> {
  await services.ledger
    .update(
      [workId],
      async (current) => {
        const record = current.get(workId)
        return { write: record && record.state === "open" ? [{ ...record, machineId, touchedAt: nowIso(services) }] : [], value: undefined }
      },
      { call: op.call },
    )
    .catch((error) => services.report("ledger", `boxd_exec could not record that it touched ${workId}: ${error instanceof Error ? error.message : String(error)}`))
}

const withoutBanner = (text: string) => {
  const lines = text.split("\n")
  let skip = 0
  while (skip < Math.min(3, lines.length) && BANNER.test(lines[skip]!)) skip++
  return lines.slice(skip).join("\n")
}

/** The last `limit` bytes of a stream, cut on a character boundary. */
function tail(text: string, limit: number): { readonly text: string; readonly cut: boolean } {
  const bytes = Buffer.from(text, "utf8")
  if (bytes.byteLength <= limit) return { text, cut: false }
  return { text: bytes.subarray(bytes.byteLength - limit).toString("utf8").replace(/^�+/, ""), cut: true }
}
