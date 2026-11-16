/**
 * Package C1's runs: `boxd_ensure`, `boxd_resume`, `boxd_reassign` and `boxd_golden` (design §3.4, §3.8, §3.10,
 * §3.11). Package C1 owns this file and `src/fleet/{ensure,golden,regions,reassign,resume,list}.ts`.
 *
 * The four runs share one state per plugin: this process's creates in flight per region (for `auto`), the golden
 * builds in flight (one per region and image, every caller joins it), and when the plugin last created, resized or
 * renamed each machine (the VM agent rule).
 */
import type { MachineId } from "../ports.js"
import type { FleetServices, ToolRuns } from "../services.js"
import { runEnsure, type Machines } from "./ensure.js"
import { createGolden } from "./golden.js"
import { finishRename, runReassign } from "./reassign.js"
import { InFlight } from "./regions.js"
import { runResume } from "./resume.js"

/** What a test may set: the call bound `B`, the poll interval and the clock. */
export interface MachineSeam {
  readonly boundMs?: number
  readonly intervalMs?: number
  readonly now?: () => number
}

export function machineRuns(services: FleetServices, seam: MachineSeam = {}): Pick<ToolRuns, "boxd_ensure" | "boxd_resume" | "boxd_reassign" | "boxd_golden"> {
  const now = seam.now ?? (() => services.clock.now().getTime())
  const machines: Machines = {
    services,
    inFlight: new InFlight(),
    golden: createGolden(services, { ...(seam.boundMs !== undefined ? { boundMs: seam.boundMs } : {}), now }),
    changed: new Map<MachineId, number>(),
    now,
    ...(seam.boundMs !== undefined ? { boundMs: seam.boundMs } : {}),
    ...(seam.intervalMs !== undefined ? { intervalMs: seam.intervalMs } : {}),
  }
  return {
    boxd_ensure: (input, call) => runEnsure(machines, input, call, (record, op) => finishRename(machines, record, op)),
    boxd_resume: (input, call) => runResume(machines, input, call),
    boxd_reassign: (input, call) => runReassign(machines, input, call),
    boxd_golden: (input, call) => machines.golden.run(input, call),
  }
}
