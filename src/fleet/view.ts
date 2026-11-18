/**
 * Package D's runs: `boxd_status` and `boxd_job` (design §3.1, §3.2). Package D owns this file, `src/fleet/status.ts`,
 * `src/fleet/job.ts` and `src/fleet/model.ts`.
 */
import { hostname } from "node:os"
import { SourceError } from "@we-the-rebel-alliance/source-contract/events"
import type { FleetServices, ToolRuns } from "../services.js"
import { jobRun } from "./job.js"
import { fleetStatus, statusInput, workList } from "./status.js"

/** This computer's account, the same host slug `probe` names. Kept here so the fleet path does not import the events source. */
function localAccount(): string {
  const host = hostname().replace(/\.local\.?$/i, "")
  return (host || "local").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 63) || "local"
}

export function viewRuns(services: FleetServices): Pick<ToolRuns, "boxd_status" | "boxd_job"> {
  return {
    boxd_status: async (input, call) => {
      // boxd.works.list: every work, as the contract's list output. The model path does not pass list.
      if (input["list"] === "works") {
        const account = typeof input["account"] === "string" ? input["account"] : undefined
        const mine = localAccount()
        if (account !== undefined && account !== mine) {
          throw new SourceError({
            code: "ACCOUNT_MISMATCH",
            what: "boxd lists only this computer's works, and that account is another computer's.",
            next: "Call probe, then pass this computer's account.",
          })
        }
        const status = await fleetStatus(services, statusInput({ view: "all", limit: 50 }), {
          tag: { callId: call.id, source: "boxd_status" },
          signal: call.signal,
          guestReads: true,
        })
        // The registry's run type is the status object. This path answers the contract's list shape instead; the model
        // path does not pass list, so it still gets the status object.
        return workList(status.works ?? [], account, status.asOf) as unknown as Awaited<ReturnType<typeof fleetStatus>>
      }
      return fleetStatus(services, statusInput(input), { tag: { callId: call.id, source: "boxd_status" }, signal: call.signal, guestReads: true })
    },
    boxd_job: async (input, call) => jobRun(services, input, { tag: { callId: call.id, source: "boxd_job" }, signal: call.signal }),
  }
}
