/**
 * Package B's v0 import (design §6), the only v0-aware module (AGENTS.md's exception, removed in v0.2.0): the
 * one-time import into `v1/`, the read of a v0 guest through its own helper, and `adopt`. Package B owns this file.
 * `src/plugin.ts` calls `createImportV0` once, before the ledger.
 */
import type { ImportV0Port } from "./ports.js"
import { notBuilt, type HostServices, type Runtime } from "./services.js"

export function createImportV0(_core: HostServices & Runtime): ImportV0Port {
  return notBuilt<ImportV0Port>("importV0")
}
