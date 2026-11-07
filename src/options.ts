import { boxdError } from "./errors.js"
import { assertSnapshot } from "./names.js"

export interface Options {
  /** The golden snapshot every new machine boots from. */
  readonly snapshot: string
  /** Run on an OpenCode version outside the supported range, with a warning in status. */
  readonly allowUntestedHost: boolean
}

const EXAMPLE = `"plugins": [{ "package": "@joe-broadhead/opencode-boxd", "options": { "snapshot": "opencode-golden" } }]`
const ACCEPTED = {
  snapshot: "a lowercase boxd snapshot name (opencode-claude-final by default)",
  allowUntestedHost: "true or false (the default)",
} as const

const invalid = (problem: string) => boxdError("OPTIONS_INVALID", `${problem}. Fix the plugin options, for example ${EXAMPLE}`)

/** Validates the plugin options from opencode.json. Every option is optional. */
export function parseOptions(raw: unknown): Options {
  if (raw === undefined || raw === null) return { snapshot: assertSnapshot("opencode-claude-final"), allowUntestedHost: false }
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid(`The plugin options must be an object, found ${describe(raw)}`)
  const input = raw as Record<string, unknown>
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(ACCEPTED, key)) throw invalid(`Unknown option "${key}". Accepted options: ${Object.keys(ACCEPTED).map((name) => `"${name}"`).join(", ")}`)
  }
  const { snapshot = "opencode-claude-final", allowUntestedHost = false } = input
  if (typeof allowUntestedHost !== "boolean") throw invalid(`The option "allowUntestedHost" must be ${ACCEPTED.allowUntestedHost}, found ${describe(allowUntestedHost)}`)
  if (typeof snapshot !== "string") throw invalid(`The option "snapshot" must be ${ACCEPTED.snapshot}, found ${describe(snapshot)}`)
  try {
    assertSnapshot(snapshot)
  } catch {
    throw invalid(`The option "snapshot" must be ${ACCEPTED.snapshot}, found ${describe(snapshot)}`)
  }
  return { snapshot, allowUntestedHost }
}

const describe = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "an array" : typeof value === "string" ? JSON.stringify(value) : typeof value === "object" ? "an object" : String(value)
