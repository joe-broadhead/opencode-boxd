/**
 * Package D's run for `boxd_job` (design §3.2). The status method reads `fleetStatus` directly in `src/index.ts` and
 * `src/handlers/status.ts`, so this file holds only the live per-work read.
 */
import type { FleetServices, ToolRuns } from "../services.js"
import { jobRun } from "./job.js"

export function viewRuns(services: FleetServices): Pick<ToolRuns, "boxd_job"> {
  return {
    boxd_job: async (input, call) => jobRun(services, input, { tag: { callId: call.id, source: "boxd_job" }, signal: call.signal }),
  }
}
