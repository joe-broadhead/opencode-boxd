/** `drop`: destroy the work's machine and close the work, behind the whole data-safety guard. */
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { selectionOf } from "../call.js"
import type { Selectors, ToolRuns } from "../services.js"
import { callOf, guarded, method, nudge, settle } from "./run.js"
import { DROP_INPUT } from "./schemas.js"

const SPEC = { id: "boxd_drop", list: true, selects: ["saved-finished"] } as const

const DESCRIPTION =
  "Destroy the work's machine, by its recorded machine id, and close the work. Refuses unless the work is saved (a fresh harvest that the guest's own sessions still match), its git tree is known, every untracked or ignored path was harvested, and no commit on a local branch, tag, stash or detached HEAD is missing from every remote ref: push first, then drop. A work whose machine is gone everywhere closes without destroying anything; with no recorded machine id it needs confirmGone. select: \"saved-finished\" drops every saved, completed work that passes the guard; the plugin never drops anything by itself."

export function dropHandler(runs: ToolRuns, selectors: Selectors): MethodHandler {
  return method(DESCRIPTION, DROP_INPUT, { type: "object", additionalProperties: true }, (input, call) =>
    guarded(async () => {
      const select = selectionOf(SPEC, input)
      let matched: readonly string[] | undefined
      if (select !== undefined) matched = await selectors.boxd_drop(select as "saved-finished", callOf(call))
      const value = await settle(() => runs.boxd_drop(input, callOf(call, matched)))
      await nudge(call)
      return value
    }),
  )
}
