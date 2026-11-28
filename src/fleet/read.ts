/**
 * `boxd_read` (design §3.3): one file from a work's tree, or the tail of the guest's OpenCode server log, without a
 * harvest. A read, under the read rule of §4.1: it runs only on a machine a listing at most 2 s old shows `running`,
 * uses only the helper already on the machine, never uploads anything, takes no lock and never writes the ledger. A
 * hibernated machine answers `MACHINE_ASLEEP` and is not woken. The text is redacted and is the guest's data, never
 * instructions. One listing (shared) and one `read` exec. A read the read rule refused before it ran is tried once more
 * on a fresh listing; a listing that still cannot be kept young enough answers `TIMEOUT` (`kind: "listing-stale"`), a
 * call to make again, never `BOXD_FAILED`. A listing that fails transiently (`kind: "listing-failed"`) is retried the same
 * way and answers a retryable `TIMEOUT`; a signed-out CLI (`BOXD_MISSING`) fails at once. Package C2 owns this file.
 */
import { BoxdError, boxdError } from "../errors.js"
import { assertWorkPath } from "../paths.js"
import type { Listing, MachineName, OpContext } from "../ports.js"
import type { WorkRecord } from "../ledger/types.js"
import { redactBlock } from "../redact.js"
import type { ReadResult } from "../results.js"
import { assertWorkIdInput, listed, listingStale, loadOpen, notReadable, oneOf, optionalInteger, slotOf, type Services } from "./sessions-common.js"

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
  const input = { directory: record.guestDirectory, ...slotOf(record), maxBytes: item.maxBytes, ...(item.path ? { path: item.path } : {}), ...(item.log ? { log: item.log } : {}), ...(item.tail ? { tail: item.tail } : {}) }
  const attempt = async (fresh: boolean) => {
    const { listing, row } = await markListing(async () => (fresh ? freshRow(await services.boxd.list({ maxAgeMs: 0 }, op), record) : await listed(services, record.region!, record.machine, op)))
    if (!row) throw boxdError("MACHINE_GONE", `${record.machine} is not in the ${record.region} listing; nothing was read. boxd_drop checks whether it is gone everywhere.`)
    if (row.status === "starting") throw boxdError("MACHINE_STARTING", `${record.machine} is still starting; nothing was read.`)
    if (row.status !== "running") throw boxdError("MACHINE_ASLEEP", `${record.machine} is ${row.status}, and a read never wakes a machine.`)
    return services.guest.read({ region: record.region!, name: record.machine as MachineName, listing, machineId: record.machineId }, input, op)
  }
  let answer: Awaited<ReturnType<Services["guest"]["read"]>>
  try {
    answer = await attempt(false)
  } catch (error) {
    // The read rule refused it before anything ran (a listing that aged in the queue, or a machine that listing did
    // not show running): once more on a fresh listing, which says what the machine is now.
    if (!listingStale(error) && !notReadable(error) && !listingFailed(error)) throw error
    try {
      answer = await attempt(true)
    } catch (again) {
      if (listingStale(again)) {
        throw boxdError("TIMEOUT", `boxd's machine listing could not be kept fresh enough for a read of ${record.machine} while the plugin was this busy; nothing was read.`, { kind: "listing-stale", step: "read" })
      }
      if (listingFailed(again)) {
        throw boxdError("TIMEOUT", `boxd's machine listing failed twice for a read of ${record.machine} (${(again as BoxdError).what.replace(/\.$/, "")}); nothing was read.`, { kind: "listing-failed", retryable: true, step: "read" })
      }
      throw again
    }
  }
  const path = item.log === "server" ? "server.log" : item.path!
  if (answer.binary) return { state: "read", workId: record.workId, path, binary: true, bytes: answer.bytes, sha256: answer.sha256 }
  return { state: "read", workId: record.workId, path, bytes: answer.bytes, truncated: answer.truncated, text: redactBlock(answer.text) }
}

/** The listing a read needed failed, transiently (`kind: "listing-failed"`): a read to make again, like one refused. */
const listingFailed = (error: unknown) => error instanceof BoxdError && error.details.kind === "listing-failed"

/**
 * Runs a listing step, marking a transient failure (`BOXD_FAILED`, `TIMEOUT`) `listing-failed`, as the CLI port does
 * for a read's refresh. A signed-out or missing CLI (`BOXD_MISSING`), or a stop, stays as it is and fails at once.
 */
async function markListing<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step()
  } catch (error) {
    if (!(error instanceof BoxdError) || (error.code !== "BOXD_FAILED" && error.code !== "TIMEOUT") || error.details.kind === "listing-failed") throw error
    throw boxdError(error.code, `${error.what.replace(/\.$/, "")}; nothing was read.`, { ...error.details, kind: "listing-failed", retryable: true })
  }
}

const freshRow = (listing: Listing, record: WorkRecord) => ({ listing, row: listing.machines.find((machine) => machine.name === record.machine && machine.region === record.region) })
