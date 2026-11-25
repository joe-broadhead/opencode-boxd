/** `harvest`: bring the work's transcript and files back here. */
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { selectionOf } from "../call.js"
import type { Selectors, ToolRuns } from "../services.js"
import { callOf, guarded, method, nudge, settle } from "./run.js"
import { HARVEST_INPUT } from "./schemas.js"

const SPEC = { id: "boxd_harvest", list: true, selects: ["unsaved-finished"] } as const

const DESCRIPTION =
  'Bring the work\'s transcript and files back here: export the session tree on the guest, copy and verify each file, replace this machine\'s copy of each session, and store git\'s patch and untracked files. The last good copy is never overwritten before the new one is verified. Needs an idle session unless partial is true. select: "unsaved-finished" harvests every finished work that is not saved.'

export function harvestHandler(runs: ToolRuns, selectors: Selectors): MethodHandler {
  return method(DESCRIPTION, HARVEST_INPUT, { type: "object", additionalProperties: true }, (input, call) =>
    guarded(async () => {
      const select = selectionOf(SPEC, input)
      let matched: readonly string[] | undefined
      if (select !== undefined) matched = await selectors.boxd_harvest(select as "unsaved-finished", callOf(call))
      const value = await settle(() => runs.boxd_harvest(input, callOf(call, matched)))
      await nudge(call)
      return value
    }),
  )
}
