/** `sleep`: hibernate the work's machine. */
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { selectionOf } from "../call.js"
import type { Selectors, ToolRuns } from "../services.js"
import { callOf, guarded, method, nudge, settle } from "./run.js"
import { SLEEP_INPUT } from "./schemas.js"

const SPEC = { id: "boxd_sleep", list: true, selects: ["idle", "finished"] } as const

const DESCRIPTION =
  'Hibernate the work\'s machine: it keeps its disk, memory and session, bills only for disk, and the next boxd_submit wakes it. Always works, saved or not, and records a warning when the last prompt is not saved. select: "finished" sleeps every idle work whose last run ended, and "idle" every running idle work.'

export function sleepHandler(runs: ToolRuns, selectors: Selectors): MethodHandler {
  return method(DESCRIPTION, SLEEP_INPUT, { type: "object", additionalProperties: true }, (input, call) =>
    guarded(async () => {
      const select = selectionOf(SPEC, input)
      let matched: readonly string[] | undefined
      if (select !== undefined) matched = await selectors.boxd_sleep(select as "idle" | "finished", callOf(call))
      const value = await settle(() => runs.boxd_sleep(input, callOf(call, matched)))
      await nudge(call)
      return value
    }),
  )
}
