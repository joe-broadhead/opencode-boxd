import { createHash } from "node:crypto"
import { BoxdError } from "./errors.js"
import { assertSessionId } from "./names.js"

export type Transfer = {
  info: {
    id: string
    parentID?: string
    [key: string]: unknown
  }
  messages: unknown[]
}

export function parseExport(payload: unknown): Transfer {
  const body = unwrap(payload)
  if (!body || typeof body !== "object") invalid("export is not an object")
  const record = body as { info?: unknown; messages?: unknown }
  if (!record.info || typeof record.info !== "object" || !Array.isArray(record.messages)) {
    invalid("export needs info and messages")
  }
  const info = record.info as Transfer["info"]
  assertSessionId(String(info.id ?? ""))
  if (info.parentID !== undefined) assertSessionId(String(info.parentID))
  return { info: { ...info, id: String(info.id) }, messages: record.messages }
}

/** Parents before children. A parent that is not in the set cannot be imported onto a fresh machine. */
export function order(transfers: readonly Transfer[]): Transfer[] {
  const byId = new Map(transfers.map((transfer) => [transfer.info.id, transfer]))
  if (byId.size !== transfers.length) invalid("duplicate session id in the export set")
  const pending = new Map(byId)
  const ordered: Transfer[] = []
  while (pending.size) {
    const ready = [...pending.values()].filter((transfer) => {
      const parent = transfer.info.parentID
      return !parent || !pending.has(parent)
    })
    if (!ready.length) invalid("session tree has a cycle")
    for (const transfer of ready.sort((a, b) => a.info.id.localeCompare(b.info.id))) {
      const parent = transfer.info.parentID
      if (parent && !byId.has(parent)) {
        throw new BoxdError(
          "PARENT_MISSING",
          `Session ${transfer.info.id} names parent ${parent}, which was not exported.`,
          "Export the parent before the child, and import in that order.",
        )
      }
      pending.delete(transfer.info.id)
      ordered.push(transfer)
    }
  }
  return ordered
}

export function rewrite(transfer: Transfer, imported: ReadonlyMap<string, string>): Transfer {
  const copy = structuredClone(transfer) as Transfer
  const parent = copy.info.parentID
  if (!parent) return copy
  const mapped = imported.get(parent)
  if (!mapped) {
    throw new BoxdError(
      "PARENT_MISSING",
      `Cannot import ${copy.info.id} until parent ${parent} has an id on the destination.`,
      "Import parents before children.",
    )
  }
  copy.info.parentID = mapped
  return copy
}

export function digest(transfer: Transfer): string {
  return createHash("sha256").update(JSON.stringify(transfer)).digest("hex")
}

function unwrap(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload
  const record = payload as { data?: unknown; info?: unknown }
  if (record.info) return payload
  return record.data ?? payload
}

function invalid(message: string): never {
  throw new BoxdError("EXPORT_INVALID", message, "Export again from the guest. Do not invent a transcript.")
}
