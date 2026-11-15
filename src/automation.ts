/**
 * Package E's automation loop (design §C.3): auto-harvest then auto-sleep of finished and orphaned works, lease
 * renewal, under `automation.lock`, never a drop. It acts only through `services.actions` (C2's code) and the boxd port.
 * Package E owns this file. `src/plugin.ts` starts it once and disposes it with the plugin.
 */
import type { CostServices, Dispose } from "./services.js"

export function startAutomation(_services: CostServices): Dispose {
  return async () => {}
}
