/** `submit`: admit a prompt on the work's guest, after copying the files it needs. */
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { selectionOf } from "../call.js"
import type { ToolRuns } from "../services.js"
import { callOf, guarded, method, nudge, settle } from "./run.js"
import { SUBMIT_INPUT } from "./schemas.js"

const SPEC = { id: "boxd_submit", list: true } as const

const DESCRIPTION =
  'Admit a prompt on the work\'s guest OpenCode, after copying any files it needs. Returns when the prompt is admitted, not when the model finishes. mode "steer" (default) lands at the running session\'s next step boundary, "queue" after the run ends, and "interrupt" stops the run first. A hibernated machine is woken.'

export function submitHandler(runs: ToolRuns): MethodHandler {
  return method(DESCRIPTION, SUBMIT_INPUT, { type: "object", additionalProperties: true }, (input, call) =>
    guarded(async () => {
      selectionOf(SPEC, input)
      const value = await settle(() => runs.boxd_submit(input, callOf(call)))
      await nudge(call)
      return value
    }),
  )
}
