/**
 * Package D's runs: `boxd_status` and `boxd_job` (design §3.1, §3.2). Package D owns this file, `src/fleet/status.ts`,
 * `src/fleet/job.ts` and `src/fleet/model.ts`.
 */
import type { FleetServices, ToolRuns } from "../services.js"
import { jobRun } from "./job.js"
import { fleetStatus, statusInput } from "./status.js"

export function viewRuns(services: FleetServices): Pick<ToolRuns, "boxd_status" | "boxd_job"> {
  return {
    // The model's status, and the tools RPC's without `list`. The works list snapshot is built by the RPC method itself
    // (src/tools.ts, ownedMethods), so this function has no list path at all.
    boxd_status: async (input, call) => fleetStatus(services, statusInput(input), { tag: { callId: call.id, source: "boxd_status" }, signal: call.signal, guestReads: true }),
    boxd_job: async (input, call) => jobRun(services, input, { tag: { callId: call.id, source: "boxd_job" }, signal: call.signal }),
  }
}
