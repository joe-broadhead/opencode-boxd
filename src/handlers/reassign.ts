/** `reassign`: move an unstarted work's machine to another work id. */
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import type { ToolRuns } from "../services.js"
import { callOf, guarded, method, nudge, settle } from "./run.js"
import { REASSIGN_INPUT } from "./schemas.js"

const DESCRIPTION =
  "Move an unstarted work's machine to another work id, renaming and relabelling it by its machine id, so capacity at the limit is reused without a destroy and a create. Refused unless from has no session, no uploaded files and a clean tree, and to is not an open work. The rename reboots the machine."

export function reassignHandler(runs: ToolRuns): MethodHandler {
  return method(DESCRIPTION, REASSIGN_INPUT, { type: "object", additionalProperties: true }, (input, call) =>
    guarded(async () => {
      const value = await settle(() => runs.boxd_reassign(input, callOf(call)))
      await nudge(call)
      return value
    }),
  )
}
