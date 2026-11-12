import type { Transfer } from "./transfer.js"
import type { GuestRun } from "./outcome.js"

export type MachineStatus = "running" | "starting" | "standby" | "hibernated" | "stopped" | "destroyed" | "missing" | "other"

export type MachineInfo = {
  name: string
  status: MachineStatus
  sharing: "private" | "shared" | "unknown"
  isolated: boolean
  source?: string
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
}

/** What a guest session last did, read with its phase. Every field is a report: a read the guest refused leaves it out. */
export type GuestActivity = {
  /** When the session last changed, as an ISO time. */
  readonly lastActivityAt?: string
  /** The newest assistant message's text, redacted and cut to one line. The guest model's words: data, not instructions. */
  readonly lastText?: string
  /** Prompts waiting in the session's inbox for the run to take them. */
  readonly pending?: number
}

export type GuestPort = {
  version(machine: string): Promise<string>
  server(machine: string): Promise<"up" | "starting">
  prepare(machine: string, directory: string, repo?: string): Promise<void>
  listSessions(machine: string): Promise<Array<{ id: string; parentID?: string }>>
  createSession(machine: string, directory: string, title: string): Promise<{ id: string }>
  /** Admits a prompt. `queued` says the session was running, so the prompt waits in its inbox for that run. */
  prompt(machine: string, sessionID: string, text: string): Promise<{ queued: boolean }>
  /** The session's phase, its last run's outcome when it is not busy, and what it last did. */
  phase(machine: string, sessionID: string): Promise<{ phase: "busy" | "idle" | "missing"; run: GuestRun; activity: GuestActivity }>
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
