/**
 * boxd's part of the tools RPC (`boxd.machines.tools`): the plugin value and the method table that the source contract's
 * `tools-rpc` module takes. The module (`@we-the-rebel-alliance/source-contract/tools-rpc`, bundled into
 * `dist/index.js`) is the transport the plugin family shares:
 *
 *   POST /api/rpc/boxd.machines.tools/<method>
 *   { "input": { "sessionID": "<session>", "input": <the method's input> } }
 *
 * A script runs as a session and the agent it names; the rule for the method's permission action is resolved before
 * dispatch, and only `allow` runs. boxd has no MCP server, so every method is the plugin's own: the twelve tools
 * (`ownedMethods` in `src/tools.ts`) and the `boxd.works` source's `events_list` and `probe` (`src/sources.ts`).
 */
import { toolsRpcId, type Failure, type McpResult, type MethodSpec, type NextSteps, type ShapeCall, type ToolsRpcPlugin } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { PLUGIN_ID } from "./constants.js"

export { PLUGIN_ID }

/** The RPC's id: the plugin's id and `.tools`. Scripts call it by name, so it never changes. */
export const TOOLS_RPC_ID = toolsRpcId(PLUGIN_ID)

/**
 * boxd has no MCP server, so no method comes from one. Every method is plugin-owned and built where it has the plugin's
 * context (its own `permission.assert`): the tools in `ownedMethods`, and the source's reads in `sourceMethods`.
 */
export const METHODS: readonly MethodSpec[] = []

/** The model path has no MCP call to reshape; an owned method's input is its own tool input. */
export function shapeInput(_method: string, input: unknown, _call: ShapeCall): unknown {
  return input
}

/** Nothing on the model path reshapes a result either. */
export function shapeResult(_method: string, result: McpResult, _call: ShapeCall): McpResult {
  return result
}

/**
 * The next step for each code. boxd has no MCP methods, so the MCP-only steps are unused here; they stay because this
 * value is also the fixture the family's shared suites run against, and a code's text must not drift.
 */
export const NEXT_STEPS: NextSteps = {
  SESSION_UNKNOWN: `Create a session in the location you mean, such as POST /api/session with {"agent":"build"} sent with the header "x-opencode-directory: <dir>" or the location[directory] query, and pass its id.`,
  SESSION_AGENT_REQUIRED: `Create a session that names an agent this project has, with its project as the location, such as POST /api/session with {"agent":"build","location":{"directory":"/path/to/project"}}, and pass its id.`,
  PERMISSION_DENIED:
    "A script cannot answer an approval prompt: add an allow rule for the method to the session's agent, then call it again.",
  SERVER_CONFLICT: `Remove your own server from opencode.json so that the plugin manages it, then run "opencode reload".`,
  AUTH_REQUIRED: "Run /connect and choose the plugin's account to connect it.",
  CONNECTING: "Wait a few seconds, then call the method again.",
  CONNECTION_FAILED: "Run /boxd-status and follow its next step.",
  DISABLED: `Enable the plugin's server in /mcps, or remove "disabled": true from its entry in opencode.json.`,
  NOT_REGISTERED: "Run /boxd-status and follow its next step.",
  TOOL_UNAVAILABLE: "Call describe to see which methods OpenCode lists now, and run /boxd-status.",
  UPSTREAM_ERROR: "Check the input against the method's schema from describe, and run /boxd-status if it keeps failing.",
  CANCELLED: "Call the method again if you still need the result.",
}

/** A boxd error, thrown by one of the plugin's own methods, as the script's code, what happened and the next step. */
export function pluginError(error: unknown): Failure | undefined {
  if (!(error instanceof Error)) return undefined
  const { code, next } = error as { readonly code?: unknown; readonly next?: unknown }
  if (typeof code !== "string" || typeof next !== "string") return undefined
  // Strip the code and the next step from the message: the envelope carries them separately.
  const message = error.message.startsWith(`${code}: `) ? error.message.slice(code.length + 2) : error.message
  const what = message.split(" Next step: ")[0] ?? message
  return { code, what: what.replace(/[.\s]+$/, ""), next }
}

/** The plugin value the transport takes. */
export const PLUGIN: ToolsRpcPlugin = { id: PLUGIN_ID, nextSteps: NEXT_STEPS, shapeInput, shapeResult, pluginError }
