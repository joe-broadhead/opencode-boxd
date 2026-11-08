import { boxdError } from "./errors.js"
import { assertSnapshot } from "./names.js"
import { ACCESS_VALUES, type Access } from "./permissions.js"

export interface Options {
  /** The golden snapshot every new machine boots from. */
  readonly snapshot: string
  /** Run on an OpenCode version outside the supported range, with a warning in status. */
  readonly allowUntestedHost: boolean
  /** What the plugin's own tools may do without asking: everything, ask for changes, or reads only. */
  readonly access: Access
}

const EXAMPLE = `"plugins": [{ "package": "@joe-broadhead/opencode-boxd", "options": { "snapshot": "opencode-golden" } }]`
const ACCEPTED = {
  snapshot: "a lowercase boxd snapshot name (opencode-golden by default)",
  allowUntestedHost: "true or false (the default)",
  access: '"all" (the default), "ask-changes" or "read-only"',
} as const

const invalid = (problem: string) => boxdError("OPTIONS_INVALID", `${problem}. Fix the plugin options, for example ${EXAMPLE}`)

/** Validates the plugin options from opencode.json. Every option is optional. */
export function parseOptions(raw: unknown): Options {
  if (raw === undefined || raw === null) return { snapshot: assertSnapshot("opencode-golden"), allowUntestedHost: false, access: "all" }
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid(`The plugin options must be an object, found ${describe(raw)}`)
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(ACCEPTED, key)) throw invalid(`Unknown option "${key}". Accepted options: ${Object.keys(ACCEPTED).map((name) => `"${name}"`).join(", ")}`)
  }
  const { snapshot = "opencode-golden", allowUntestedHost = false, access = "all" } = input
  if (typeof allowUntestedHost !== "boolean") throw invalid(`The option "allowUntestedHost" must be ${ACCEPTED.allowUntestedHost}, found ${describe(allowUntestedHost)}`)
  if (typeof snapshot !== "string") throw invalid(`The option "snapshot" must be ${ACCEPTED.snapshot}, found ${describe(snapshot)}`)
  try {
    assertSnapshot(snapshot)
  } catch {
    throw invalid(`The option "snapshot" must be ${ACCEPTED.snapshot}, found ${describe(snapshot)}`)
  }
  if (typeof access !== "string" || !(ACCESS_VALUES as readonly string[]).includes(access)) throw invalid(`The option "access" must be ${ACCEPTED.access}, found ${describe(access)}`)
  return { snapshot, allowUntestedHost, access: access as Access }
}

const describe = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "an array" : typeof value === "string" ? JSON.stringify(value) : typeof value === "object" ? "an object" : String(value)
