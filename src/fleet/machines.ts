/**
 * Package C1's runs: `boxd_ensure`, `boxd_resume`, `boxd_reassign` and `boxd_golden` (design §3.4, §3.8, §3.10,
 * §3.11). Package C1 owns this file and `src/fleet/{ensure,golden,regions,reassign,resume,list}.ts`.
 */
import { notBuiltRun, type FleetServices, type ToolRuns } from "../services.js"

export function machineRuns(_services: FleetServices): Pick<ToolRuns, "boxd_ensure" | "boxd_resume" | "boxd_reassign" | "boxd_golden"> {
  return { boxd_ensure: notBuiltRun("C1"), boxd_resume: notBuiltRun("C1"), boxd_reassign: notBuiltRun("C1"), boxd_golden: notBuiltRun("C1") }
}
