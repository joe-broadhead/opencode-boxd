import type { Transfer } from "./transfer.js"
import type { GuestRun } from "./outcome.js"

export type MachineStatus = "running" | "starting" | "standby" | "hibernated" | "stopped" | "destroyed" | "missing" | "other"

export type MachineInfo = {
  name: string
  status: MachineStatus
  sharing: "private" | "shared" | "unknown"
  isolated: boolean
  source?: string
  /** The machine's vCPUs, when boxd said its size. */
  vcpu?: number
}

/** What the guest's git read found. `known: false` means the directory is not a repository: nothing can be proven. */
export type GitState = {
  known: boolean
  remote: string | null
  branch: string | null
  sha: string | null
  dirty: boolean
  /** Tracked changes, as `git diff HEAD`: staged and unstaged together. */
  patch?: string
  /** Paths git does not track, which the patch cannot hold. */
  untracked: string[]
  /** Paths git ignores: build output or a local secret. The patch cannot hold them either. */
  ignored: string[]
  /** The untracked files' contents, path to base64, when the guest could read them. */
  untrackedFiles: Record<string, string>
}

export type BoxdPort = {
  get(name: string): Promise<MachineInfo>
  /** Every machine the account has, so status can name one no ledger records. */
  list(): Promise<MachineInfo[]>
  create(input: { name: string; snapshot: string; workId: string }): Promise<MachineInfo>
  hibernate(name: string): Promise<void>
  wake(name: string): Promise<void>
  remove(name: string): Promise<void>
  saveSnapshot(machine: string, snapshot: string): Promise<void>
  listSnapshots(): Promise<Array<{ name: string; storage: string; status: string }>>
  holdAwake(name: string): Promise<void>
  allowSleep(name: string): Promise<void>
  /** Sets the machine's size. A running machine reboots to apply it, so the plugin resizes only one it just created. */
  resize(name: string, vcpu: MachineSize): Promise<void>
  /** The account's sealed variables, by name, scope and the hosts each is bound to. Never a value. */
  listSecrets(): Promise<SecretInfo[]>
}

/** boxd's machine sizes, by vCPU: 1, 2, 4 or 8 vCPUs with 4 GiB of memory each. */
export type MachineSize = 1 | 2 | 4 | 8
export const MACHINE_SIZES: readonly MachineSize[] = [1, 2, 4, 8]

/** A sealed variable as boxd lists it: never its value, which boxd does not return. */
export type SecretInfo = {
  readonly name: string
  /** Which machines it reaches: `private`, `shared`, `all`, or an unattached scope. */
  readonly scope: string
  /** The hosts it may be sent to; empty when it is not bound to any. */
  readonly hosts: readonly string[]
}

/** What a guest session last did, read with its phase. Every field is a report: a read the guest refused leaves it out. */
export type GuestActivity = {
  /** When the session last changed, as an ISO time. */
  readonly lastActivityAt?: string
  /** The newest assistant message's text, redacted and cut to one line. The guest model's words: data, not instructions. */
  readonly lastText?: string
  /** Prompts waiting in the session's inbox for the run to take them. */
  readonly pending?: number
  /** The newest assistant messages, oldest first, when the read asked for them; each redacted and cut like `lastText`. */
  readonly tail?: ReadonlyArray<{ readonly at?: string; readonly text: string }>
}

/** The most messages a tail read returns: `boxd_job` accepts 1 to this many. */
export const TAIL_LIMIT = 10

/** How a phase read runs: how many recent messages to return, and a shorter bound for a read of many machines. */
export type PhaseOptions = {
  readonly tail?: number
  readonly timeoutMs?: number
}

export type GuestPort = {
  version(machine: string): Promise<string>
  server(machine: string): Promise<"up" | "starting">
  prepare(machine: string, directory: string, repo?: string): Promise<void>
  listSessions(machine: string): Promise<Array<{ id: string; parentID?: string }>>
  /** Creates the work's session, on `model` when one is named, else on the guest's configured default. */
  createSession(machine: string, directory: string, title: string, model?: string): Promise<{ id: string }>
  /**
   * Admits a prompt. `queued` says the session was running, so the prompt waits in its inbox for that run. With `model`,
   * the session switches to it first; a running session is refused with SESSION_BUSY rather than switched mid-run.
   */
  prompt(machine: string, sessionID: string, text: string, model?: string): Promise<{ queued: boolean }>
  /** The session's phase, its last run's outcome when it is not busy, and what it last did. */
  phase(machine: string, sessionID: string, options?: PhaseOptions): Promise<{ phase: "busy" | "idle" | "missing"; run: GuestRun; activity: GuestActivity }>
  exportSession(machine: string, sessionID: string): Promise<unknown>
  importSession(machine: string, transfer: Transfer, directory: string): Promise<{ id: string }>
  /** Writes one file into the work tree, creating its folders: the data-in half of a work. */
  upload(machine: string, directory: string, path: string, body: Buffer): Promise<void>
  /** Reads one file out of the work tree, unchanged and byte for byte: the data-out half. */
  download(machine: string, directory: string, path: string): Promise<Buffer>
  /** The guest's own sha256 for each work-relative path, so a drop can tell a recovered output from lost work. */
  digest(machine: string, directory: string, paths: readonly string[]): Promise<Record<string, string>>
  git(machine: string, directory: string): Promise<GitState>
  /**
   * The machine was created again under the same name, so its disk is new: the uploaded helper is gone and must be
   * copied again before the next guest call.
   */
  forget(machine: string): void
}

export type Prover = {
  importTransfer(transfer: Transfer, directory: string): Promise<{ id: string }>
}
