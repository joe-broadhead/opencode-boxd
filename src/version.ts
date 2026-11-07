import { BoxdError } from "./errors.js"

/** The only OpenCode release this package is built against. Guest and host must match it. */
export const OPENCODE_VERSION = "2.2.6"
export const HOST_RANGE = ">=2.2.6 <2.3.0"
export const TESTED_HOSTS = ["2.2.6"] as const

const LOWEST = [2, 2, 6] as const
const ABOVE = [2, 3, 0] as const

type Version = readonly [number, number, number]

export function parseVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1]
}

export function checkHost(version: string, allowUntested: boolean): string | undefined {
  if (inRange(version)) return undefined
  const message = `OpenCode ${version} is outside ${HOST_RANGE}. This plugin targets ${OPENCODE_VERSION}.`
  if (!allowUntested) {
    throw new BoxdError("HOST_UNTESTED", message, "Upgrade OpenCode to 2.2.6, or set allowUntestedHost only if you accept the drift.")
  }
  return `${message} Loaded because allowUntestedHost is set. The guest must still be ${OPENCODE_VERSION}.`
}

export function checkGuest(reported: string): void {
  const parsed = parseVersion(reported)
  if (parsed === OPENCODE_VERSION) return
  throw new BoxdError(
    "GUEST_VERSION",
    `The machine is running OpenCode ${reported.trim() || "unknown"}, not ${OPENCODE_VERSION}.`,
    "Boot from an image that has OpenCode 2.2.6. Do not start a session on a mismatched disk.",
  )
}

export function inRange(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return false
  const parsed: Version = [Number(match[1]), Number(match[2]), Number(match[3])]
  return compare(parsed, LOWEST) >= 0 && compare(parsed, ABOVE) < 0
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!
  }
  return 0
}
