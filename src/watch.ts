/**
 * Package D's watcher and notices (design §3.13): the sweep, `events.jsonl`, the notices to each work's root
 * coordinator, and the event stream package E consumes. Package D owns this file. `src/plugin.ts` calls `createWatch`
 * once and disposes it with the plugin.
 */
import type { FleetWatch } from "./ports.js"
import type { CoreServices, Dispose } from "./services.js"

export function createWatch(_core: CoreServices): { readonly watch: FleetWatch; readonly dispose: Dispose } {
  return {
    watch: { subscribe: () => () => {}, snapshot: () => ({ asOf: new Date(0).toISOString(), works: [] }), sessionGone: () => {} },
    dispose: async () => {},
  }
}
