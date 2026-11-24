/**
 * `boxd_drop` (design §3.9): destroy a work's machine, by its recorded id, and close the work. Destructive, so its
 * guard runs per work whatever asked (a tool call, a `select`, or `/boxd-cleanup`), and nothing automatic calls it.
 *
 * The guard: `saved: fresh` here, and for a v0-imported work a copy a v1 harvest verified; then, in one `git` exec on
 * the guest, a known git tree, no commit on a local ref or HEAD that no remote ref contains (`UNPUSHED`, #39), and a
 * count that must be known (`UNPUSHED_UNKNOWN`) rather than guessed, every
 * untracked or ignored path harvested at the digest the guest still has, tracked changes stored as the same patch, and
 * the guest's own session marks (last message id and message count per session, and no new session under the root)
 * equal to what the harvest stored (M3, L-d). Then `machine remove <id>`, after `oc-<id>` was resolved to the recorded
 * id (H2).
 *
 * A work whose machine is gone closes without destroying anything, but only on two checks made in this call: a fresh
 * all-region listing with no `oc-<id>`, and a not-found `machine get <id>` in every region. A failed or unclear answer
 * keeps the work open (`BOXD_FAILED`); a machine found under another name or region answers `NOT_OURS`. Package C2
 * owns this file.
 */
import { join } from "node:path"
import { BoxdError, boxdError } from "../errors.js"
import type { WorkRecord } from "../ledger/types.js"
import { digestFile } from "../paths.js"
import { REGIONS, type ChangeTarget, type GitAnswer, type MachineId, type MachineName, type OpContext } from "../ports.js"
import type { DropResult } from "../results.js"
import { adoptIfV0, assertWorkIdInput, nowIso, openRecord, optionalBoolean, type WorkContext, type Services } from "./sessions-common.js"

/** The most paths a refusal names for a program (`paths`); `count` has them all. */
const LISTED_PATHS = 20

export interface DropItem {
  readonly workId: string
  readonly confirmGone: boolean
}

export function checkDrop(input: Record<string, unknown>): DropItem {
  return { workId: assertWorkIdInput(input.workId), confirmGone: optionalBoolean(input.confirmGone, "confirmGone") ?? false }
}

/** Not-found, and only that: the gone rule's one fact per region. */
const notFound = (error: unknown) => error instanceof BoxdError && error.code === "BOXD_FAILED" && error.details.kind === "missing"

export async function dropWork(services: Services, item: DropItem, context: WorkContext): Promise<DropResult> {
  // Nothing automatic ever drops (design §C.3): a defence beside package E's own rule, not a refusal a person sees.
  if (context.by === "automation") throw new Error("boxd_drop is never run by automation.")
  const { op } = context
  const closed = await services.ledger.update(
    [item.workId],
    async (current) => {
      const record = openRecord(current.get(item.workId), item.workId)
      let machineId = record.machineId
      let gone = record.region === null
      if (!gone && machineId === null) {
        // An imported work whose `get` failed at import: the name is resolved now, or the gone rule decides.
        try {
          machineId = (await services.boxd.get(record.region!, record.machine, op)).id
        } catch (error) {
          if (!notFound(error)) throw error
          gone = true
        }
      }
      if (!gone) {
        const region = record.region!
        gone = await services.runner.withMachineLock({ id: machineId! }, op, async () => {
          let target: ChangeTarget
          try {
            target = (await services.boxd.checkOwned(region, record.machine as MachineName, machineId!, op)).target
          } catch (error) {
            if (error instanceof BoxdError && error.code === "BOXD_FAILED" && (error.details.kind === "missing" || error.details.kind === "elsewhere")) return true
            throw error
          }
          await guard(services, record, target, op)
          await services.boxd.remove(target, op)
          return false
        })
      }
      if (gone) await assertGone(services, record, machineId, item.confirmGone, op)
      const at = nowIso(services)
      const unsaved = record.lastSubmit !== undefined && services.ledger.saved(record) !== "fresh"
      const next: WorkRecord = { ...record, ...(machineId ? { machineId } : {}), state: "closed", closed: { at, how: gone ? "gone" : "dropped" } }
      const value: DropResult = {
        state: gone ? "closed" : "dropped",
        workId: record.workId,
        machine: record.machine,
        ...(gone && unsaved ? { lost: `the prompts after ${record.saved?.at ?? record.createdAt} were never harvested` } : {}),
      }
      return { write: [next], value }
    },
    op,
  )
  const from = services.watch.snapshot().works.find((work) => work.workId === item.workId)?.phase ?? null
  await services.ledger.appendEvent({ at: nowIso(services), workId: item.workId, from, to: "closed" }, op).catch((error) => {
    services.report("events", `The closed event for ${item.workId} was not recorded: ${error instanceof Error ? error.message : String(error)}`)
  })
  return closed
}

/**
 * The guard against this laptop and against the guest itself, in the one `git` exec, under the machine's lock: a
 * prompt admitted meanwhile holds the same lock, so it either lands before this read or finds the machine removed.
 */
async function guard(services: Services, record: WorkRecord, target: ChangeTarget, op: OpContext): Promise<void> {
  const saved = services.ledger.saved(record)
  if (saved !== "fresh") {
    throw boxdError("NOT_SAVED", saved === "none" ? "This laptop has no harvest of the work." : "The last harvest is older than the last prompt, or was partial.")
  }
  if (record.laptopCopy === "unverified") {
    // F1: v0 may have left an older transcript in this laptop's OpenCode; only a v1 harvest replaces and verifies it.
    throw boxdError("NOT_SAVED", "The work was imported from an earlier release, and no harvest since has verified the copy of its transcript here.")
  }
  await adoptIfV0(services, record, target, op)
  const rootId = record.session?.rootId
  const git = await services.guest.git(target, { directory: record.guestDirectory, ...(rootId ? { rootId } : {}) }, op)
  if (rootId) sessionsMatch(record, git)
  if (!git.known) throw boxdError("GIT_UNKNOWN", "The guest folder is not a git repository, so its files cannot be accounted for.")
  // #39: a commit on a local branch that no remote ref has exists only on this machine, and a harvest stores no commits.
  if (!git.unpushedKnown) throw boxdError("UNPUSHED_UNKNOWN", undefined, { unknown: true })
  if (git.unpushedCount > 0) {
    const named = git.unpushed.slice(0, 3).map((commit) => commit.slice(0, 60)).join("; ")
    const more = git.unpushedCount > 3 ? ` and ${git.unpushedCount - 3} more` : ""
    throw boxdError(
      "UNPUSHED",
      `The guest has ${git.unpushedCount} commit${git.unpushedCount === 1 ? "" : "s"} on a local branch, tag, stash or detached HEAD that no remote ref contains${named ? `: ${named}${more}` : ""}. Dropping ${record.machine} would lose ${git.unpushedCount === 1 ? "it" : "them"}.`,
      { count: git.unpushedCount, commits: git.unpushed.slice(0, LISTED_PATHS) },
    )
  }
  const folder = services.ledger.workFolder(record.workId)
  const out = new Map((record.files?.out ?? []).map((file) => [file.path, file.sha256]))
  const stored = async (path: string) => (record.gitState?.untrackedStored ? (await digestFile(join(folder, "untracked", path)).catch(() => undefined))?.sha256 : undefined)
  const harvested = async (file: { readonly path: string; readonly sha256: string }) => file.sha256 !== "" && (out.get(file.path) === file.sha256 || (await stored(file.path)) === file.sha256)
  for (const kind of ["untracked", "ignored"] as const) {
    const lost: string[] = []
    for (const file of git[kind]) if (!(await harvested(file))) lost.push(file.path)
    if (lost.length) {
      const named = lost.slice(0, 10).join(", ") + (lost.length > 10 ? ` and ${lost.length - 10} more` : "")
      throw boxdError("UNTRACKED", `The guest tree has ${lost.length} ${kind} path${lost.length === 1 ? "" : "s"} this laptop does not hold: ${named}.`, {
        kind,
        paths: lost.slice(0, LISTED_PATHS),
        count: lost.length,
      })
    }
  }
  if (git.dirty) {
    const patch = record.gitState?.patchStored ? await digestFile(join(folder, "patch.diff")).catch(() => undefined) : undefined
    if (!patch || !git.patch || patch.sha256 !== git.patch.sha256) {
      throw boxdError("DIRTY", patch ? "The guest's uncommitted work changed since the stored patch." : "The guest tree has uncommitted work and no patch on this laptop.")
    }
  }
}

/** Every guest session under the root has the marks the harvest stored, and none is new (M3); `updated` is a hint (L-d). */
function sessionsMatch(record: WorkRecord, git: GitAnswer): void {
  if (!git.sessions) throw boxdError("NOT_SAVED", "The guest did not list its sessions, so the harvest could not be checked against them.")
  const saved = new Map((record.saved?.sessions ?? []).map((session) => [session.id, session]))
  for (const session of git.sessions) {
    const stored = saved.get(session.id)
    if (!stored) throw boxdError("NOT_SAVED", `The guest has session ${session.id}, which the last harvest did not save.`)
    if (stored.lastMessageId !== session.lastMessageId || stored.messages !== session.messages) {
      throw boxdError("NOT_SAVED", `Session ${session.id} has ${session.messages} messages on the guest; the last harvest saved ${stored.messages}.`)
    }
  }
}

/**
 * The gone rule (design §3.9, H2), from this call's own reads, never a cache: no `oc-<id>` in a fresh all-region
 * listing, and boxd's exact not-found answer for the recorded id in every region. With no recorded id, only
 * `confirmGone: true` closes the work.
 */
async function assertGone(services: Services, record: WorkRecord, machineId: MachineId | null, confirmGone: boolean, op: OpContext): Promise<void> {
  const listing = await services.boxd.list({ maxAgeMs: 0 }, op)
  if (!listing.fresh) throw boxdError("BOXD_FAILED", "The machine listing was not fresh, so the work stays open.")
  const named = listing.machines.filter((row) => row.name === record.machine)
  if (named.length) {
    throw boxdError("NOT_OURS", `${record.machine} is in ${named.map((row) => row.region).join(" and ")}, but not as the recorded machine${machineId ? ` ${machineId}` : ""} in ${record.region ?? "any region"}. Nothing was removed.`)
  }
  if (machineId === null) {
    if (!confirmGone) {
      throw boxdError("MACHINE_GONE", `No region lists ${record.machine}, and this work has no recorded machine id to look up. Pass confirmGone: true to close it as gone.`)
    }
    return
  }
  for (const region of REGIONS) {
    try {
      const info = await services.boxd.get(region, machineId, op)
      throw boxdError("NOT_OURS", `The recorded machine ${machineId} is ${info.name} in ${region}. Nothing was removed.`)
    } catch (error) {
      if (notFound(error)) continue
      throw error
    }
  }
}
