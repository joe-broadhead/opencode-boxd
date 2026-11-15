/**
 * Package D's runs: `boxd_status` and `boxd_job` (design §3.1, §3.2). Package D owns this file, `src/fleet/status.ts`
 * and `src/fleet/job.ts`.
 */
import { notBuiltRun, type FleetServices, type ToolRuns } from "../services.js"

export function viewRuns(_services: FleetServices): Pick<ToolRuns, "boxd_status" | "boxd_job"> {
  return { boxd_status: notBuiltRun("D"), boxd_job: notBuiltRun("D") }
}
