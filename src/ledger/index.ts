/**
 * Package B's entry for the ledger, format 1 (design §2.2). Package B owns `src/ledger/*` (the types file included,
 * whose shapes every package reads). `src/plugin.ts` calls `createLedger` once, after the import.
 */
import type { ImportV0Port, LedgerPort } from "../ports.js"
import { notBuilt, type HostServices, type Runtime } from "../services.js"

export function createLedger(_core: HostServices & Runtime & { readonly importV0: ImportV0Port }): LedgerPort {
  return notBuilt<LedgerPort>("ledger")
}
