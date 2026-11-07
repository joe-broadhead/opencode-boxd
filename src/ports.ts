import type { Transfer } from "./transfer.js"

export type MachineStatus = "running" | "starting" | "standby" | "hibernated" | "stopped" | "destroyed" | "missing" | "other"

export type MachineInfo = {
  name: string
  status: MachineStatus
  sharing: "private" | "shared" | "unknown"
  isolated: boolean
  source?: string
}

export type GitState = {
  remote: string | null
  branch: string | null
  sha: string | null
  dirty: boolean
  patch?: string
}

export type BoxdPort = {
  get(name: string): Promise<MachineInfo>
  create(input: { name: string; snapshot: string; workId: string }): Promise<MachineInfo>
  hibernate(name: string): Promise<void>
  wake(name: string): Promise<void>
  remove(name: string): Promise<void>
  saveSnapshot(machine: string, snapshot: string): Promise<void>
  listSnapshots(): Promise<Array<{ name: string; storage: string; status: string }>>
  holdAwake(name: string): Promise<void>
  allowSleep(name: string): Promise<void>
}

export type GuestPort = {
  version(machine: string): Promise<string>
  server(machine: string): Promise<"up" | "starting">
  prepare(machine: string, directory: string, repo?: string): Promise<void>
  listSessions(machine: string): Promise<Array<{ id: string; parentID?: string }>>
  createSession(machine: string, directory: string, title: string): Promise<{ id: string }>
  prompt(machine: string, sessionID: string, text: string): Promise<void>
  phase(machine: string, sessionID: string): Promise<"busy" | "idle" | "missing">
  exportSession(machine: string, sessionID: string): Promise<unknown>
  importSession(machine: string, transfer: Transfer, directory: string): Promise<{ id: string }>
  git(machine: string, directory: string): Promise<GitState>
}

export type Prover = {
  importTransfer(transfer: Transfer, directory: string): Promise<{ id: string }>
}
