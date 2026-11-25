/** `resume`: wake a hibernated machine, or rebuild a destroyed one and import its saved transcript. */
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { selectionOf } from "../call.js"
import type { ToolRuns } from "../services.js"
import { callOf, guarded, method, nudge, settle } from "./run.js"
import { RESUME_INPUT } from "./schemas.js"

const SPEC = { id: "boxd_resume", list: true } as const

const DESCRIPTION = "Wake a hibernated machine, or rebuild a destroyed one from its recorded image and import the saved transcript into it."

export function resumeHandler(runs: ToolRuns): MethodHandler {
  return method(DESCRIPTION, RESUME_INPUT, { type: "object", additionalProperties: true }, (input, call) =>
    guarded(async () => {
      selectionOf(SPEC, input)
      const value = await settle(() => runs.boxd_resume(input, callOf(call)))
      await nudge(call)
      return value
    }),
  )
}
