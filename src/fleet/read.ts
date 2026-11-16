/**
 * `boxd_read` (design §3.3): one file from a work's tree, or the tail of the guest's OpenCode server log, without a
 * harvest. A read, under the read rule of §4.1: it runs only on a machine a listing at most 2 s old shows `running`,
 * uses only the helper already on the machine, never uploads anything, takes no lock and never writes the ledger. A
 * hibernated machine answers `MACHINE_ASLEEP` and is not woken. The text is redacted and is the guest's data, never
 * instructions. One listing (shared) and one `read` exec. Package C2 owns this file.
 */
import { boxdError } from "../errors.js"
import { assertWorkPath } from "../paths.js"
import type { MachineName, OpContext } from "../ports.js"
import { redactBlock } from "../redact.js"
import type { ReadResult } from "../results.js"
import { assertWorkIdInput, listed, loadOpen, oneOf, optionalInteger, type Services } from "./sessions-common.js"

export const READ_DEFAULT_BYTES = 32_768

export interface ReadItem {
  readonly workId: string
  readonly path?: string
  readonly log?: "server"
  readonly tail?: number
  readonly maxBytes: number
}

export function checkRead(input: Record<string, unknown>): ReadItem {
  const workId = assertWorkIdInput(input.workId)
  const log = oneOf(input.log, ["server"] as const, "log")
  if ((input.path === undefined) === (log === undefined)) throw boxdError("NAME_INVALID", "Pass exactly one of path and log.", { field: input.path === undefined ? "path" : "log" })
  let path: string | undefined
  if (input.path !== undefined) {
    if (typeof input.path !== "string") throw boxdError("NAME_INVALID", "path must be a path inside the work tree.", { field: "path" })
    try {
      path = assertWorkPath(input.path)
    } catch {
      throw boxdError("NAME_INVALID", `path "${input.path}" is not a path inside the work tree: relative, with no "..".`, { field: "path" })
    }
  }
  const tail = optionalInteger(input.tail, "tail", 1, 2000)
  const maxBytes = optionalInteger(input.maxBytes, "maxBytes", 1, 262_144) ?? READ_DEFAULT_BYTES
  return { workId, maxBytes, ...(path ? { path } : {}), ...(log ? { log } : {}), ...(tail ? { tail } : {}) }
}

export async function readWork(services: Services, item: ReadItem, op: OpContext): Promise<ReadResult> {
  const record = await loadOpen(services, item.workId, op)
  if (record.region === null) throw boxdError("MACHINE_GONE", `${record.machine} was found in no region when this work was imported; nothing was read.`)
  if (record.guestHelper === "v0") {
    throw boxdError("GUEST_FAILED", `${record.machine} still runs the v0 guest helper, which has no read action; a read never uploads the new one.`)
  }
  const { listing, row } = await listed(services, record.region, record.machine, op)
  if (!row) throw boxdError("MACHINE_GONE", `${record.machine} is not in the ${record.region} listing; nothing was read. boxd_drop checks whether it is gone everywhere.`)
  if (row.status === "starting") throw boxdError("MACHINE_STARTING", `${record.machine} is still starting; nothing was read.`)
  if (row.status !== "running") throw boxdError("MACHINE_ASLEEP", `${record.machine} is ${row.status}, and a read never wakes a machine.`)
  const answer = await services.guest.read(
    { region: record.region, name: record.machine as MachineName, listing, machineId: record.machineId },
    { directory: record.guestDirectory, maxBytes: item.maxBytes, ...(item.path ? { path: item.path } : {}), ...(item.log ? { log: item.log } : {}), ...(item.tail ? { tail: item.tail } : {}) },
    op,
  )
  const path = item.log === "server" ? "server.log" : item.path!
  if (answer.binary) return { state: "read", workId: record.workId, path, binary: true, bytes: answer.bytes, sha256: answer.sha256 }
  return { state: "read", workId: record.workId, path, bytes: answer.bytes, truncated: answer.truncated, text: redactBlock(answer.text) }
}
