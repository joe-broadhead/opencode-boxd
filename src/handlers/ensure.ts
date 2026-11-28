/** `ensure`: make a work exist, set up and ready, and converge an existing work to the input. */
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { selectionOf } from "../call.js"
import type { ToolRuns } from "../services.js"
import { callOf, guarded, method, nudge, settle } from "./run.js"
import { ENSURE_INPUT } from "./schemas.js"

const SPEC = { id: "boxd_ensure", list: true, selects: ["orphans"] } as const

const DESCRIPTION =
  "Make a work exist, set up and ready, in one call, and converge an existing work to the input. Creates oc-<id> from the golden image for its region and size (building the image first when it is missing), clones repo, sets the git identity, and waits for the guest's OpenCode. New machines go only to the regions the plugin option \"regions\" allows; an existing work keeps its own. Adopts an oc-<id> that carries the plugin's labels, or any with adopt: true. select: \"orphans\" adopts every actionable orphan that boxd_status lists: it reads the guest's describe, writes a record and sets this ledger's labels, changing nothing on the machine's tree, OpenCode or sessions. Each machine bills until it is dropped."

export function ensureHandler(runs: ToolRuns): MethodHandler {
  return method(DESCRIPTION, ENSURE_INPUT, { type: "object", additionalProperties: true }, (input, call) =>
    guarded(async () => {
      selectionOf(SPEC, input)
      const value = await settle(() => runs.boxd_ensure(input, callOf(call)))
      await nudge(call)
      return value
    }),
  )
}
