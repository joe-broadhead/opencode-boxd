/**
 * `boxd_sleep` (design §3.7, §C.3): hibernate a work's machine, by its recorded id. It always works, saved or not: a
 * work that cannot be harvested must still have an exit from billing. An unsaved last prompt is recorded as
 * `UNHARVESTED_SLEEP`. One `machine get` (the by-id check) and one `machine hibernate`; no config write, because the
 * platform bounds were set at creation. Package C2 owns this file.
 */
import { BoxdError } from "../errors.js"
import type { SleptBy, WorkRecord } from "../ledger/types.js"
import type { ChangeTarget, OpContext } from "../ports.js"
import type { SleepResult } from "../results.js"
import { machineOf, nowIso, openRecord, withTarget, withWarning, type WorkContext, type Services } from "./sessions-common.js"

export interface SleepItem {
  readonly workId: string
}

export async function sleepWork(services: Services, item: SleepItem, context: WorkContext): Promise<SleepResult> {
  const { op } = context
  const by: SleptBy = context.by === "automation" ? "automation" : "boxd_sleep"
  return services.ledger.update(
    [item.workId],
    async (current) => {
      const record = openRecord(current.get(item.workId), item.workId)
      const machine = await machineOf(services, record, op)
      // A machine the by-id check already shows hibernated is slept: no second hibernate.
      await withTarget(services, record, machine, op, async (owned) => (owned.status === "hibernated" ? undefined : hibernate(services, owned.target, op)))
      const at = nowIso(services)
      const unsaved = record.lastSubmit !== undefined && services.ledger.saved(record) !== "fresh"
      const next: WorkRecord = {
        ...record,
        machineId: machine.machineId,
        slept: { at, by },
        touchedAt: at,
        ...(unsaved ? { warnings: withWarning(record.warnings, "UNHARVESTED_SLEEP", at) } : {}),
      }
      const result: SleepResult = {
        state: "asleep",
        workId: record.workId,
        machine: record.machine,
        region: machine.region,
        ...(unsaved ? { warning: "UNHARVESTED_SLEEP" as const } : {}),
        next: unsaved
          ? `The last prompt is not saved on this laptop. When you need it: boxd_resume({ workId: "${record.workId}" }), then boxd_harvest({ workId: "${record.workId}" }).`
          : `It keeps its disk, memory and session; boxd_submit({ workId: "${record.workId}", text }) wakes it, and boxd_drop({ workId: "${record.workId}" }) destroys it.`,
      }
      return { write: [next], value: result }
    },
    op,
  ).then(async (result) => {
    await recordAsleep(services, item.workId, by, op)
    return result
  })
}

/**
 * Hibernates. A machine that is already hibernated may refuse a second hibernate: a refusal is read back with one
 * `machine get`, and a machine that is hibernated counts as slept.
 */
async function hibernate(services: Services, target: ChangeTarget, op: OpContext): Promise<void> {
  try {
    await services.boxd.hibernate(target, op)
  } catch (error) {
    if (!(error instanceof BoxdError) || error.code !== "BOXD_FAILED") throw error
    const info = await services.boxd.get(target.region, target.machineId, op).catch(() => undefined)
    if (info?.status !== "hibernated") throw error
  }
}

/** The phase change, in the event log: an idle work's phase changes only by a change tool, which records it. */
async function recordAsleep(services: Services, workId: string, by: SleptBy, op: OpContext): Promise<void> {
  const from = services.watch.snapshot().works.find((work) => work.workId === workId)?.phase ?? null
  if (from === "asleep") return
  await services.ledger.appendEvent({ at: nowIso(services), workId, from, to: "asleep", asleepBy: by }, op).catch((error) => {
    services.report("events", `The asleep event for ${workId} was not recorded: ${error instanceof Error ? error.message : String(error)}`)
  })
}
