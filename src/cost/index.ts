/**
 * Package E's cost service (design §C.4, §C.5): rates, the per-hour estimate, today, the cleanup suggestions, the
 * budget and the automation state, for D's status and C1's and C2's budget checks. Package E owns `src/cost/*`.
 */
import type { FleetWatch } from "../ports.js"
import type { CoreServices, CostPort } from "../services.js"
import { notBuilt } from "../services.js"

export function createCost(_core: CoreServices & { readonly watch: FleetWatch }): CostPort {
  return notBuilt<CostPort>("cost")
}
