import { assertDirectory, assertSessionId, assertSnapshot, assertWorkId, machineName } from "./names.js"

/** Argv for the boxd binary. Never a shell string. Never --shared or --isolated. */

export function createArgs(workId: string, snapshot: string): string[] {
  assertWorkId(workId)
  assertSnapshot(snapshot)
  return [
    "machine",
    "new",
    machineName(workId),
    "--from-snapshot",
    snapshot,
    "--label",
    "role=session",
    "--label",
    `work=${workId}`,
    "--json",
  ]
}

/** Bound, not zero. Zero never sleeps, so a crashed agent leaves a bill running. */
export const AWAKE_SECONDS = "1800"
const SLEEP_SECONDS = "14400"

export function getArgs(name: string): string[] {
  return ["machine", "get", name, "--json"]
}

export function listArgs(): string[] {
  return ["machine", "list", "--json"]
}

export function hibernateArgs(name: string): string[] {
  return ["machine", "hibernate", name, "--json"]
}

export function wakeArgs(name: string): string[] {
  return ["machine", "wake", name, "--json"]
}

export function removeArgs(name: string): string[] {
  return ["machine", "remove", name, "-y"]
}

export function holdAwakeArgs(name: string): string[] {
  return ["machine", "config", "set", name, "auto-hibernate.timeout", AWAKE_SECONDS]
}

export function allowSleepArgs(name: string): string[] {
  return ["machine", "config", "set", name, "auto-hibernate.timeout", SLEEP_SECONDS]
}

export function outboundArgs(name: string, value: "on" | "off"): string[] {
  return ["machine", "config", "set", name, "idle.ignore-outbound", value]
}

export function saveSnapshotArgs(machine: string, snapshot: string): string[] {
  assertSnapshot(snapshot)
  return ["snapshots", "save", machine, snapshot, "--json"]
}

export function listSnapshotArgs(): string[] {
  return ["snapshots", "list", "--json"]
}

export function execArgs(machine: string): string[] {
  return ["machine", "exec", machine, "--", "python3", "/tmp/opencode-boxd/guest.py"]
}

export function copyToGuestArgs(machine: string, remote: string): string[] {
  assertDirectory(remote)
  return ["machine", "cp", "-", `${machine}:${remote}`]
}

/** The other direction: the guest's file to this process's stdout, unchanged. */
export function copyFromGuestArgs(machine: string, remote: string): string[] {
  assertDirectory(remote)
  return ["machine", "cp", `${machine}:${remote}`, "-"]
}

export function guestRequest(action: string, fields: Record<string, unknown>): string {
  if (typeof fields.sessionID === "string") assertSessionId(fields.sessionID)
  if (typeof fields.directory === "string") assertDirectory(fields.directory)
  return JSON.stringify({ action, ...fields })
}
