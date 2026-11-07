import { homedir } from "node:os"
import { join } from "node:path"
import { assertSnapshot } from "./names.js"

export type Options = {
  snapshot: string
  ledger: string
  boxd: string
  allowUntestedHost: boolean
}

export function loadOptions(raw: unknown): Options {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const snapshot = typeof record.snapshot === "string" ? record.snapshot : "opencode-claude-final"
  assertSnapshot(snapshot)
  return {
    snapshot,
    ledger: typeof record.ledger === "string" ? record.ledger : join(homedir(), ".local", "share", "opencode-boxd"),
    boxd: typeof record.boxd === "string" ? record.boxd : "boxd",
    allowUntestedHost: record.allowUntestedHost === true,
  }
}
