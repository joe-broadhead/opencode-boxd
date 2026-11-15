/**
 * Package C2's runs: `boxd_submit`, `boxd_harvest`, `boxd_sleep`, `boxd_drop`, `boxd_exec` and `boxd_read` (design
 * §3.3, §3.5–§3.7, §3.9, §3.12), the selectors of §C.4, and the in-process `FleetActions` package E uses. Package C2
 * owns this file and `src/fleet/{submit,harvest,sleep,drop,exec,read}.ts`.
 */
import { notBuilt, notBuiltRun, type FleetActions, type FleetServices, type Selectors, type ToolRuns } from "../services.js"

type SessionRuns = Pick<ToolRuns, "boxd_submit" | "boxd_harvest" | "boxd_sleep" | "boxd_drop" | "boxd_exec" | "boxd_read">

export function sessionRuns(_services: FleetServices): { readonly runs: SessionRuns; readonly selectors: Selectors; readonly actions: FleetActions } {
  const none = async () => [] as readonly string[]
  return {
    runs: {
      boxd_submit: notBuiltRun("C2"),
      boxd_harvest: notBuiltRun("C2"),
      boxd_sleep: notBuiltRun("C2"),
      boxd_drop: notBuiltRun("C2"),
      boxd_exec: notBuiltRun("C2"),
      boxd_read: notBuiltRun("C2"),
    },
    // Until C2 resolves them, a selector matches nothing; the registry still asserts the call.
    selectors: { boxd_sleep: none, boxd_harvest: none, boxd_drop: none },
    actions: notBuilt<FleetActions>("actions"),
  }
}
