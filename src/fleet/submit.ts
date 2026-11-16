/**
 * `boxd_submit` (design §3.5): admit a prompt on the work's guest OpenCode and return once it is admitted, not when the
 * model finishes. `mode` chooses how it reaches a running session: `steer` (the default) at its next step boundary,
 * `queue` after the run ends, `interrupt` after stopping the run, so it also reaches a session blocked in one long tool
 * call. A starting machine is waited for up to 45 s; a hibernated one is woken, because a submit is a decision to spend
 * (and a reached `budget` with `action: "refuse"` answers `BUDGET_REACHED` first). Package C2 owns this file.
 *
 * Steady state: one listing (at most 2 s old, shared), the by-id `machine get`, and one `prompt` exec; one `machine cp`
 * per file.
 */
import { randomBytes } from "node:crypto"
import { BoxdError, boxdError } from "../errors.js"
import type { MovedFile, WorkRecord } from "../ledger/types.js"
import { assertModel } from "../names.js"
import { assertTotal, assertWorkPath, laptopFile, rootsOf } from "../paths.js"
import { POLL_INTERVAL_MS, TIMEOUTS, type Delivery, type MachineStatus, type OpContext } from "../ports.js"
import type { SubmitResult } from "../results.js"
import type { CallContext } from "../tools.js"
import {
  adoptIfV0,
  assertWorkIdInput,
  checkStop,
  listed,
  machineOf,
  nowIso,
  oneOf,
  openRecord,
  optionalString,
  pause,
  withTarget,
  type ItemContext,
  type Services,
} from "./sessions-common.js"

const SESSION = /^ses_[A-Za-z0-9_-]{1,80}$/
/** Where a file waits on the guest until the `prompt` exec moves it into the work tree. */
const STAGING = "/home/boxd/.opencode-boxd/staging"
/** The most `parentID` steps the root walk takes (design §3.5). */
const ROOT_WALK = 16

export interface SubmitItem {
  readonly workId: string
  readonly text: string
  readonly mode: Delivery
  readonly model?: string
  readonly files: ReadonlyArray<{ readonly from: string; readonly to: string }>
  readonly title?: string
  /** true: the caller's root; false: none; a session id: that session's root; undefined: the path's default. */
  readonly notify?: boolean | string
}

/** One submit item, checked before anything runs. */
export function checkSubmit(input: Record<string, unknown>): SubmitItem {
  const workId = assertWorkIdInput(input.workId)
  if (typeof input.text !== "string" || input.text.trim() === "") throw boxdError("NAME_INVALID", "text must be the prompt, a non-empty string.", { field: "text" })
  const mode = oneOf(input.mode, ["steer", "queue", "interrupt"] as const, "mode") ?? "steer"
  const model = input.model === undefined ? undefined : assertModelField(input.model)
  const title = optionalString(input.title, "title", 200)
  if (input.notify !== undefined && typeof input.notify !== "boolean" && !(typeof input.notify === "string" && SESSION.test(input.notify))) {
    throw boxdError("NAME_INVALID", "notify must be true, false or a session id (ses_…).", { field: "notify" })
  }
  if (input.files !== undefined && !Array.isArray(input.files)) throw boxdError("NAME_INVALID", "files must be a list of { from, to }.", { field: "files" })
  const files = ((input.files as unknown[] | undefined) ?? []).map((raw, index) => {
    const item = raw as Record<string, unknown> | null
    if (!item || typeof item.from !== "string" || item.from === "" || typeof item.to !== "string") {
      throw boxdError("NAME_INVALID", `files[${index}] must be { from, to }, two paths.`, { field: `files[${index}]` })
    }
    try {
      return { from: item.from, to: assertWorkPath(item.to) }
    } catch {
      throw boxdError("NAME_INVALID", `files[${index}].to "${item.to}" is not a path inside the work tree.`, { field: `files[${index}].to` })
    }
  })
  return { workId, text: input.text, mode, files, ...(model ? { model } : {}), ...(title ? { title } : {}), ...(input.notify !== undefined ? { notify: input.notify as boolean | string } : {}) }
}

function assertModelField(value: unknown): string {
  if (typeof value !== "string") throw boxdError("NAME_INVALID", "model must be a model reference such as anthropic/claude-sonnet-4-5.", { field: "model" })
  try {
    return assertModel(value)
  } catch (error) {
    if (error instanceof BoxdError) throw new BoxdError(error.code, error.what, { field: "model" })
    throw error
  }
}

export async function submitWork(services: Services, item: SubmitItem, context: ItemContext): Promise<SubmitResult> {
  const { op } = context
  const first = openRecord(await services.ledger.get(item.workId, op), item.workId)
  // Laptop files are read and checked before the guest is touched: a refused path changes nothing.
  const roots = [...rootsOf(services.projectDirectory, services.options.allowedRoots), first.laptopDirectory]
  const files = await Promise.all(
    item.files.map(async (file, index) => {
      try {
        return { ...(await laptopFile(file.from, roots)), to: file.to }
      } catch (error) {
        if (error instanceof BoxdError) throw new BoxdError(error.code, `files[${index}].from: ${error.what}`, { ...error.details, field: `files[${index}].from` })
        throw error
      }
    }),
  )
  assertTotal(files)
  const notify = await subscription(services, first, item, context.call)

  // The machine must be up: a starting one is waited for, and a hibernated one is woken.
  const machine = await machineOf(services, first, op)
  const wake = await waitUntilUp(services, first, machine.region, op)
  if (wake) await services.cost.assertBudget(op.call)

  return services.ledger.update(
    [item.workId],
    async (current) => {
      const record = openRecord(current.get(item.workId), item.workId)
      checkStop(op.signal, false)
      const { answer, adopted } = await withTarget(services, record, machine, op, async (target) => {
        if (wake) await services.boxd.wake(target, op)
        const adopted = await adoptIfV0(services, record, target, op)
        const staged = []
        for (const [index, file] of files.entries()) {
          const guestPath = `${STAGING}/${randomBytes(6).toString("hex")}-${index}`
          await services.boxd.copyTo(target, file.path, guestPath, op)
          staged.push({ staged: guestPath, to: file.to })
        }
        const answer = await services.guest.prompt(
          target,
          {
            directory: record.guestDirectory,
            sessionId: record.session?.rootId ?? null,
            title: item.title ?? record.title ?? record.workId,
            text: item.text,
            delivery: item.mode,
            ...(item.model ? { model: item.model } : record.session?.rootId || !record.model ? {} : { model: record.model }),
            ...(staged.length ? { files: staged } : {}),
          },
          op,
        )
        return { answer, adopted }
      })
      const at = nowIso(services)
      const moved: MovedFile[] = files.map((file) => ({ path: file.to, bytes: file.bytes, sha256: file.sha256, at }))
      const session = { ...record.session, rootId: answer.sessionId, ...(notify.value ? { notify: notify.value } : {}) }
      if (notify.clear) delete (session as { notify?: string }).notify
      const next: WorkRecord = {
        ...record,
        machineId: machine.machineId,
        session,
        lastSubmit: { at, delivery: item.mode, ...(context.call ? { by: context.call.sessionID } : {}) },
        touchedAt: at,
        ...(adopted ? { guestHelper: "v1" as const } : {}),
        ...(moved.length ? { files: { in: [...(record.files?.in ?? []).filter((file) => !moved.some((item) => item.path === file.path)), ...moved], out: record.files?.out ?? [] } } : {}),
      }
      const result: SubmitResult = {
        state: "admitted",
        workId: record.workId,
        sessionId: answer.sessionId,
        delivery: answer.delivery,
        ...(answer.interrupted ? { interrupted: true as const } : {}),
        inboxId: answer.inboxId,
        waitingBefore: answer.waitingBefore,
        ...(answer.model ? { model: answer.model } : {}),
        ...(moved.length ? { files: moved.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) } : {}),
        next: nextAfter(record.workId, answer.delivery),
      }
      return { write: [next], value: result }
    },
    op,
  ).then(async (result) => {
    if (result.delivery === "started") await recordBusy(services, item.workId, op)
    return result
  })
}

const nextAfter = (workId: string, delivery: SubmitResult["delivery"]) =>
  delivery === "queue"
    ? `The prompt waits until the current run ends. boxd_job({ workId: "${workId}" }) shows it waiting; a notice says when the work goes idle.`
    : `A notice says when the work goes idle; boxd_job({ workId: "${workId}" }) reads it now. Then boxd_harvest({ workId: "${workId}" }).`

/**
 * Waits until the machine is up (design §3.5): a listing at most 2 s old, then every 3 s while it is starting, for at
 * most 45 s, probed fresh once before the refusal. Returns true when it is hibernated and must be woken. A machine the
 * listing does not show goes on to the by-id check, which says what boxd found.
 */
async function waitUntilUp(services: Services, record: WorkRecord, region: NonNullable<WorkRecord["region"]>, op: OpContext): Promise<boolean> {
  const deadline = Date.now() + TIMEOUTS.submitStarting
  let fresh = false
  for (;;) {
    const status: MachineStatus | undefined = fresh
      ? (await services.boxd.list({ maxAgeMs: 0 }, op)).machines.find((row) => row.name === record.machine && row.region === region)?.status
      : (await listed(services, region, record.machine, op)).row?.status
    if (status === undefined || status === "running") return false
    if (status === "hibernated" || status === "standby" || status === "stopped") return true
    if (status === "destroyed") return false
    if (fresh) throw boxdError("MACHINE_STARTING", `${record.machine} is still ${status} after ${TIMEOUTS.submitStarting / 1000} s.`)
    checkStop(op.signal, false)
    if (Date.now() >= deadline) {
      fresh = true
      continue
    }
    await pause(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), op.signal)
  }
}

/**
 * Who gets this work's notices (design §3.5, round 2 M-b): the root of the calling session on the model path, Code Mode
 * included; no change from a script unless it says; `false` clears; a named session is resolved to its root. A session
 * the host cannot read keeps the earlier subscription, and status records why.
 */
async function subscription(services: Services, record: WorkRecord, item: SubmitItem, call: CallContext | undefined): Promise<{ readonly value?: string; readonly clear?: true }> {
  if (item.notify === false) return { clear: true }
  const from = typeof item.notify === "string" ? item.notify : item.notify === true || call?.via === "model" ? call?.sessionID : undefined
  if (!from) return {}
  try {
    return { value: await rootOf(services, from) }
  } catch (error) {
    services.report("notices", `boxd_submit for ${record.workId} kept its earlier notice target: session ${from} could not be read (${error instanceof Error ? error.message : String(error)}).`)
    return {}
  }
}

/** The session at the top of `sessionID`'s tree, at most 16 `parentID` steps up. */
export async function rootOf(services: Pick<Services, "sessions">, sessionID: string): Promise<string> {
  const get = services.sessions.get as unknown as (input: { readonly sessionID: string }) => Promise<{ readonly id?: string; readonly parentID?: string | null } | undefined>
  let id = sessionID
  for (let step = 0; step <= ROOT_WALK; step++) {
    const info = await get({ sessionID: id })
    if (!info) throw new Error(`session ${id} was not found`)
    if (!info.parentID) return id
    id = info.parentID
  }
  throw new Error(`session ${sessionID} is more than ${ROOT_WALK} levels deep`)
}

/** An idle work that started a run is busy now: recorded, so the watcher reads it again. */
async function recordBusy(services: Services, workId: string, op: OpContext): Promise<void> {
  const from = services.watch.snapshot().works.find((work) => work.workId === workId)?.phase ?? null
  if (from === "busy") return
  await services.ledger.appendEvent({ at: nowIso(services), workId, from, to: "busy" }, op).catch((error) => {
    services.report("events", `The busy event for ${workId} was not recorded: ${error instanceof Error ? error.message : String(error)}`)
  })
}
