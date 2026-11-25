/**
 * `boxd_submit` (design §3.5): admit a prompt on the work's guest OpenCode and return once it is admitted, not when the
 * model finishes. `mode` chooses how it reaches a running session: `steer` (the default) at its next step boundary,
 * `queue` after the run ends, `interrupt` after stopping the run, so it also reaches a session blocked in one long tool
 * call. A starting machine is waited for up to 45 s; a hibernated one is woken, because a submit is a decision to spend
 * (and a reached `budget` with `action: "refuse"` answers `BUDGET_REACHED` first). A woken machine is listed running
 * before its VM agent and guest OpenCode answer, so the same call waits for one `serve` read to say the server is up
 * before it sends the prompt. Package C2 owns this file.
 *
 * Steady state: one listing (at most 2 s old, shared), the by-id `machine get`, and one `prompt` exec; one `machine cp`
 * per file. A wake adds `machine wake` and, until the guest's OpenCode is up, one `serve` read a second.
 */
import { randomBytes } from "node:crypto"
import { BoxdError, boxdError } from "../errors.js"
import type { MovedFile, WorkRecord } from "../ledger/types.js"
import { assertModel } from "../names.js"
import { assertTotal, assertWorkPath, laptopFile, rootsOf } from "../paths.js"
import { POLL_INTERVAL_MS, TIMEOUTS, type ChangeTarget, type Delivery, type MachineStatus, type OpContext } from "../ports.js"
import type { SubmitResult } from "../results.js"
import type { CallContext } from "../call.js"
import {
  asleep,
  assertWorkIdInput,
  checkStop,
  listed,
  machineOf,
  nowIso,
  oneOf,
  openRecord,
  optionalString,
  pause,
  untilRunning,
  withTarget,
  type WorkContext,
  type Services,
} from "./sessions-common.js"

const SESSION = /^ses_[A-Za-z0-9_-]{1,80}$/
/** Where a file waits on the guest until the `prompt` exec moves it into the work tree. */
const STAGING = "/home/boxd/.opencode-boxd/staging"
/** The most `parentID` steps the root walk takes (design §3.5). */
const ROOT_WALK = 16
/** How often a woken machine's guest is read while its OpenCode starts: the second `untilRunning` polls at. */
const WAKE_POLL_MS = 1_000

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

export async function submitWork(services: Services, item: SubmitItem, context: WorkContext): Promise<SubmitResult> {
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

  // The machine must be up: a starting one is waited for here, and a hibernated one is woken under its lock.
  const machine = await machineOf(services, first, op)
  await waitUntilUp(services, first, machine.region, op)

  return services.ledger.update(
    [item.workId],
    async (current) => {
      const record = openRecord(current.get(item.workId), item.workId)
      checkStop(op.signal, false)
      const lastSubmit = { at: nowIso(services), delivery: item.mode, ...(context.call ? { by: context.call.sessionID } : {}) }
      const { answer } = await withTarget(services, record, machine, op, async ({ target, status }) => {
        const woke = asleep(status)
        let deadline = 0
        if (woke) {
          // A submit is a decision to spend: a reached refuse budget wakes nothing.
          await services.cost.assertBudget(op.call)
          deadline = Date.now() + TIMEOUTS.submitStarting
          await services.boxd.wake(target, op)
          await untilRunning(services, target, op)
        }
        // A woken machine shows running before its guest's OpenCode answers; the prompt waits for it in this call.
        if (woke) await untilServing(services, record, target, op, deadline)
        const staged = []
        for (const [index, file] of files.entries()) {
          const guestPath = `${STAGING}/${randomBytes(6).toString("hex")}-${index}`
          await services.boxd.copyTo(target, file.path, guestPath, op)
          staged.push({ staged: guestPath, to: file.to })
        }
        // The prompt is recorded before it is sent (L-1): a call stopped or failed after the guest admitted it still
        // leaves the work not saved, so status, the selectors and sleep's warning never take it for saved.
        await services.ledger.update([record.workId], async (now) => ({ write: [{ ...openRecord(now.get(record.workId), record.workId), lastSubmit }], value: undefined }), op)
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
        return { answer }
      })
      const at = lastSubmit.at
      const moved: MovedFile[] = files.map((file) => ({ path: file.to, bytes: file.bytes, sha256: file.sha256, at }))
      const session = { ...record.session, rootId: answer.sessionId, ...(notify.value ? { notify: notify.value } : {}) }
      if (notify.clear) delete (session as { notify?: string }).notify
      const next: WorkRecord = {
        ...record,
        machineId: machine.machineId,
        session,
        lastSubmit,
        touchedAt: nowIso(services),
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
 * Waits while the machine is starting (design §3.5): a listing at most 2 s old, then every 3 s, for at most 45 s,
 * probed fresh once before the refusal. Any other state goes on to the by-id check, whose own answer decides a wake.
 */
async function waitUntilUp(services: Services, record: WorkRecord, region: NonNullable<WorkRecord["region"]>, op: OpContext): Promise<void> {
  const deadline = Date.now() + TIMEOUTS.submitStarting
  let fresh = false
  for (;;) {
    const status: MachineStatus | undefined = fresh
      ? (await services.boxd.list({ maxAgeMs: 0 }, op)).machines.find((row) => row.name === record.machine && row.region === region)?.status
      : (await listed(services, region, record.machine, op)).row?.status
    if (status === undefined || status === "running" || status === "destroyed" || asleep(status)) return
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
 * After a wake, boxd lists the machine running before its VM agent and guest OpenCode answer: a prompt sent then
 * answers `GUEST_SERVER_DOWN` or `AGENT_UNREACHABLE`, a state a coordinator cannot use while the work is up. Reads one
 * `serve` a second, through the read rule, until the server is up or the submit's deadline passes. A read the read rule
 * did not make is not an answer, so the next tick reads again; a guest that never comes up names why.
 */
async function untilServing(services: Services, record: WorkRecord, target: ChangeTarget, op: OpContext, deadline: number): Promise<void> {
  let last: "starting" | "down" = "starting"
  for (;;) {
    try {
      const { listing, row } = await listed(services, target.region, target.name, op)
      if (row?.status === "running") {
        const served = await services.guest.serve({ region: target.region, name: target.name, listing, machineId: target.machineId }, { directory: record.guestDirectory }, op)
        if (served.server === "up") return
        last = served.server === "down" ? "down" : "starting"
      }
    } catch (error) {
      if (!(error instanceof BoxdError)) throw error
      if (error.code === "GUEST_SERVER_DOWN") last = "down"
      // The change path owns the helper: a read never uploads, and the prompt's own change installs one or refuses it.
      else if (error.code === "GUEST_FAILED") return
      else if (
        !(
          error.code === "AGENT_UNREACHABLE" ||
          error.code === "TIMEOUT" ||
          error.code === "MACHINE_ASLEEP" ||
          error.details.kind === "not-readable" ||
          error.details.kind === "listing-stale" ||
          error.details.kind === "listing-failed" ||
          error.details.rule === "listing-age"
        )
      ) {
        throw error
      }
    }
    checkStop(op.signal, true)
    if (Date.now() >= deadline) {
      throw last === "down"
        ? boxdError("GUEST_SERVER_DOWN", `${target.name} was woken, and nothing listens on its OpenCode port after ${TIMEOUTS.submitStarting / 1000} s.`)
        : boxdError("MACHINE_STARTING", `${target.name} was woken, and its guest did not answer after ${TIMEOUTS.submitStarting / 1000} s.`)
    }
    await pause(WAKE_POLL_MS, op.signal)
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
