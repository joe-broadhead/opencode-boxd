import { SUPPORTED_HOST, TESTED_HOSTS } from "./constants.js"
import { boxdError } from "./errors.js"

/** OpenCode's version as status reports it: the `host` fields every plugin of this family shares. */
export interface HostCheck {
  /** OpenCode's version, or null when it reports none. */
  readonly version: string | null
  /** The supported range, `opencode.host` in package.json. */
  readonly range: string
  /** True only for a release every check runs on (TESTED_HOSTS). */
  readonly tested: boolean
}

const RELEASE = /(?:^|v)(\d+)\.(\d+)\.(\d+)$/

/** A release's three numbers, or undefined for a prerelease, a dev build or anything unparsable. */
export function parseVersion(version: string): readonly [number, number, number] | undefined {
  const match = RELEASE.exec(version.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

const [LOWEST, ABOVE] = SUPPORTED_HOST.split(" ").map((bound) => parseVersion(bound.replace(/^[<>]=?/, ""))!)
const compare = (a: readonly number[], b: readonly number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!

/** True for a release inside the supported range. Prereleases, dev builds and unparsable versions are outside it. */
export function isSupportedHost(version: string) {
  const parts = parseVersion(version)
  return parts !== undefined && compare(parts, LOWEST!) >= 0 && compare(parts, ABOVE!) < 0
}

/** True only for a release every check runs on. */
export const isTestedHost = (version: string) => TESTED_HOSTS.includes(version)

/**
 * Starts on any release inside the supported range; status calls only the tested ones "tested". Refuses a host outside
 * the range unless the user opted in, in which case status says so.
 */
export function checkHost(version: string, allowUntestedHost: boolean): HostCheck {
  if (!isSupportedHost(version) && !allowUntestedHost) {
    throw boxdError("HOST_UNTESTED", `This plugin supports OpenCode ${SUPPORTED_HOST}, found ${version || "no version"}.`)
  }
  return { version: version === "" ? null : version, range: SUPPORTED_HOST, tested: isTestedHost(version) }
}

/**
 * The guest must run the same OpenCode as the laptop: the export and import formats are the host's, and a session is
 * moved from one to the other. The version comes from `opencode --version` on the machine.
 */
export function checkGuest(reported: string, hostVersion: string | null): void {
  const guest = parseVersion(reported)
  const host = hostVersion === null ? undefined : parseVersion(hostVersion)
  if (guest === undefined || host === undefined) {
    throw boxdError("GUEST_VERSION", `The machine reports OpenCode ${reported.trim() || "no version"}, and this laptop reports ${hostVersion ?? "none"}.`)
  }
  if (compare(guest, host) !== 0) {
    throw boxdError("GUEST_VERSION", `The machine runs OpenCode ${reported.trim()}, and this laptop runs ${hostVersion}.`)
  }
}
