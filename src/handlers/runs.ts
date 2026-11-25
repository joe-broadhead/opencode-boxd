/** The runs, the selectors and the in-process actions, assembled once from the fleet services. */
import type { FleetServices, FleetActions, Selectors, ToolRuns } from "../services.js"
import { machineRuns } from "../fleet/machines.js"
import { sessionRuns } from "../fleet/sessions.js"
import { viewRuns } from "../fleet/view.js"

export interface Runs {
  readonly runs: ToolRuns
  readonly selectors: Selectors
  readonly actions: FleetActions
}

export function createRuns(services: FleetServices): Runs {
  const machines = machineRuns(services)
  const sessions = sessionRuns(services)
  const view = viewRuns(services)
  return {
    runs: { ...view, ...machines, ...sessions.runs },
    selectors: sessions.selectors,
    actions: sessions.actions,
  }
}
