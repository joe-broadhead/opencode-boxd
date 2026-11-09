/**
 * The nine `boxd_*` tools, and the same nine as the tools RPC's methods: one schema each, one description, one class
 * and one run, so the model, a script and the status model cannot disagree.
 *
 * Every tool is allowed by default, reads and machine changes alike; `access` decides whether a change asks or is
 * denied. `boxd_drop` is allowed rather than denied: its own guard (a fresh laptop import, and a clean tree or a stored
 * patch) makes data loss impossible, and a deny would leave a machine billing with no way to clear it from the session.
 */
import type { Plugin } from "@opencode/plugin"
import { boxdError, BoxdError } from "./errors.js"
import type { createFleet } from "./fleet.js"
import { NAMESPACE } from "./constants.js"
import type { PluginMethod } from "./host/tools-rpc.js"

type Fleet = ReturnType<typeof createFleet>
export type MethodClass = "read" | "write" | "export" | "destructive"

export type ToolName = "status" | "job" | "ensure" | "submit" | "harvest" | "sleep" | "resume" | "image" | "drop"

/** A JSON Schema object, kept structural: nothing here uses zod, so both bundles stay small. */
export type JsonSchema = Record<string, unknown>

type StringField = { readonly type: "string"; readonly description?: string }

const object = (properties: Record<string, JsonSchema>, required: readonly string[]): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

const WORK: StringField = { type: "string", description: 'A short lowercase work id, such as "review-api". The machine is named oc-<id>.' }
const DIRECTORY: StringField = {
  type: "string",
  description: "A laptop folder for the work, inside the project or an allowed root. The guest always works in /home/boxd/work/<work id>.",
}
const REPO: StringField = { type: "string", description: 'An https://github.com/owner/repo URL to clone on the machine, if the directory is not a checkout already.' }
const TITLE: StringField = { type: "string", description: "The guest session's title; the work id by default." }
const LOCAL: StringField = {
  type: "string",
  description: "The laptop folder that receives the transcript and the harvested files; the work's own folder by default. It must be inside the project or an allowed root.",
}
const FILES_IN = {
  type: "array",
  description: "Files to copy to the machine before the prompt, from a laptop path to a path inside the work tree. 8 MiB each, 32 MiB together.",
  items: {
    type: "object",
    required: ["from", "to"],
    properties: {
      from: { type: "string", description: "A laptop file inside the project or an allowed root; no symlinks." },
      to: { type: "string", description: 'A path inside the work tree, such as "data/bookmarks.json".' },
    },
    additionalProperties: false,
  },
} satisfies JsonSchema
const FILES_OUT = {
  type: "array",
  description: "Paths inside the work tree to copy back after the transcript import, such as SUMMARY.md. 8 MiB each, 32 MiB together.",
  items: { type: "string" },
} satisfies JsonSchema
const TEXT: StringField = { type: "string", description: "The prompt to admit on the guest OpenCode." }
const MACHINE: StringField = { type: "string", description: 'The machine name, oc-<work id>, owned by an open work.' }
const SNAPSHOT: StringField = { type: "string", description: "A new lowercase snapshot name. Snapshots are immutable." }

interface ToolSpec {
  readonly name: ToolName
  /** The tool's id, its permission action and its method name in the tools RPC: `boxd_<name>`. */
  readonly id: string
  /** The worst thing the tool can do; it never decides whether a call runs. */
  readonly class: MethodClass
  readonly description: string
  readonly input: JsonSchema
  readonly run: (fleet: Fleet, input: Record<string, unknown>) => Promise<unknown>
}

const text = (input: Record<string, unknown>, key: string, field: string): string => {
  const value = input[key]
  if (typeof value !== "string" || value === "") throw boxdError("NAME_INVALID", `${field} must be a non-empty string.`)
  return value
}

const optional = (input: Record<string, unknown>, key: string): string | undefined => {
  const value = input[key]
  return typeof value === "string" && value ? value : undefined
}

/**
 * The one table. Order is the order status and `describe` list them: the reads first, then the changes, then the
 * destructive one.
 */
export const TOOLS: readonly ToolSpec[] = [
  {
    name: "status",
    id: "boxd_status",
    class: "read",
    description: "Read the ledger and each open work's machine state. Starts, wakes and runs nothing.",
    input: object({}, []),
    run: (fleet) => fleet.status(),
  },
  {
    name: "job",
    id: "boxd_job",
    class: "read",
    description: "Read whether the guest session is busy or idle, once. It does not wait, and it never wakes a hibernated machine.",
    input: object({ workId: WORK }, ["workId"]),
    run: (fleet, input) => fleet.job({ workId: text(input, "workId", "workId") }),
  },
  {
    name: "ensure",
    id: "boxd_ensure",
    class: "write",
    description: "Get a private machine from the golden snapshot for a work id, and record the work. The guest works in /home/boxd/work/<work id>. Returns starting when it is not up yet. It does not wait.",
    input: object({ workId: WORK, directory: DIRECTORY, repo: REPO, title: TITLE }, ["workId"]),
    run: (fleet, input) =>
      fleet.ensure({
        workId: text(input, "workId", "workId"),
        ...(optional(input, "directory") ? { directory: optional(input, "directory")! } : {}),
        ...(optional(input, "repo") ? { repo: optional(input, "repo")! } : {}),
        ...(optional(input, "title") ? { title: optional(input, "title")! } : {}),
      }),
  },
  {
    name: "submit",
    id: "boxd_submit",
    class: "write",
    description: "Admit a prompt on the guest OpenCode, after copying any files it needs to the machine. Returns when the prompt is admitted, not when the model finishes.",
    input: object({ workId: WORK, text: TEXT, title: TITLE, files: FILES_IN }, ["workId", "text"]),
    run: (fleet, input) =>
      fleet.submit({
        workId: text(input, "workId", "workId"),
        text: text(input, "text", "text"),
        ...(optional(input, "title") ? { title: optional(input, "title")! } : {}),
        ...(input.files ? { files: input.files as Array<{ from: string; to: string }> } : {}),
      }),
  },
  {
    name: "harvest",
    id: "boxd_harvest",
    class: "export",
    description: "Export the session tree, import it on this laptop, and record git; copy back any files the work produced. Refuses while the session is busy.",
    input: object({ workId: WORK, localDirectory: LOCAL, files: FILES_OUT, to: LOCAL }, ["workId"]),
    run: (fleet, input) =>
      fleet.harvest({
        workId: text(input, "workId", "workId"),
        ...(optional(input, "localDirectory") ? { localDirectory: optional(input, "localDirectory")! } : {}),
        ...(Array.isArray(input.files) ? { files: input.files.filter((path): path is string => typeof path === "string") } : {}),
        ...(optional(input, "to") ? { to: optional(input, "to")! } : {}),
      }),
  },
  {
    name: "sleep",
    id: "boxd_sleep",
    class: "write",
    description: "Hibernate the machine, which keeps its disk, and let it stay down. Works even when the guest cannot be harvested; it records a warning when the last prompt is not.",
    input: object({ workId: WORK }, ["workId"]),
    run: (fleet, input) => fleet.sleep({ workId: text(input, "workId", "workId") }),
  },
  {
    name: "resume",
    id: "boxd_resume",
    class: "write",
    description: "Wake a hibernated machine, or rebuild a destroyed one from the golden snapshot and the proven transcript.",
    input: object({ workId: WORK }, ["workId"]),
    run: (fleet, input) => fleet.resume({ workId: text(input, "workId", "workId") }),
  },
  {
    name: "image",
    id: "boxd_image",
    class: "write",
    description: "Save a new immutable snapshot of a machine this plugin owns. Refuses if any work on that machine lacks a fresh export. Not a session backup.",
    input: object({ machine: MACHINE, name: SNAPSHOT }, ["machine", "name"]),
    run: (fleet, input) => fleet.image({ machine: text(input, "machine", "machine"), name: text(input, "name", "name") }),
  },
  {
    name: "drop",
    id: "boxd_drop",
    class: "destructive",
    description: "Destroy the machine and close the work. Refuses unless the laptop import is fresh, the guest is a git repository, and every untracked or ignored path was harvested at the digest the guest still has.",
    input: object({ workId: WORK }, ["workId"]),
    run: (fleet, input) => fleet.drop({ workId: text(input, "workId", "workId") }),
  },
]

export const toolSpec = (name: ToolName): ToolSpec => TOOLS.find((tool) => tool.name === name)!

/** The reads, which the default rules allow and which run without asking. */
export const READ_TOOLS = TOOLS.filter((tool) => tool.class === "read").map((tool) => tool.id)
/** Every tool that changes a machine, spends money or writes the laptop: `access` decides whether these ask. */
export const CHANGING_TOOLS = TOOLS.filter((tool) => tool.class !== "read").map((tool) => tool.id)

/** The tool's answer as the model reads it: the result's JSON, or the coded error with its next step. */
interface ToolAnswer {
  readonly output: unknown
  readonly text: string
}

export async function runTool(name: ToolName, fleet: Fleet, input: Record<string, unknown>): Promise<ToolAnswer> {
  try {
    const output = await toolSpec(name).run(fleet, input)
    return { output, text: JSON.stringify(output) }
  } catch (error) {
    if (error instanceof BoxdError) return { output: { error: error.code, next: error.next }, text: error.message }
    throw error
  }
}

/** A tool call's source, as the host passes it, and the permission check the tool asserts with. */
export interface ToolCall {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
}

/**
 * The tool transform. It is synchronous and replayed on every rebuild. `options.permission` is the tool's own action, so
 * the host hides a denied tool; the assert below is what makes an ask actually ask, because the host asserts nothing for
 * a plugin tool by itself.
 */
export function toolTransform(fleet: Fleet, assert: Plugin.Context["permission"]["assert"]) {
  return (editor: Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]) => {
    editor.namespace({ name: NAMESPACE, description: "Run an OpenCode session on a private boxd machine and keep the transcript on this laptop" })
    for (const spec of TOOLS) {
      editor.add({
        // The namespace prefixes the tool's id: `status` becomes `boxd_status`.
        name: spec.name,
        description: spec.description,
        input: spec.input,
        output: { type: "object" },
        options: { namespace: NAMESPACE, permission: spec.id },
        execute: async (value, context) => {
          const input = (value ?? {}) as Record<string, unknown>
          await assertTool(assert, spec, input, {
            sessionID: context.sessionID,
            agent: context.agent,
            messageID: context.messageID,
            id: context.id,
          })
          const answer = await runTool(spec.name, fleet, input)
          return { output: answer.output, content: answer.text }
        },
      })
    }
  }
}

/**
 * A read runs; every other class asserts its own action first, with the call's own source, so the prompt is the call and
 * an unattended script's ask can be told apart and refused. The model path and the tools RPC both use this.
 */
async function assertTool(
  assert: Plugin.Context["permission"]["assert"],
  spec: ToolSpec,
  input: Record<string, unknown>,
  call: ToolCall,
): Promise<void> {
  if (spec.class === "read") return
  // The resource names the work or the machine, so a prompt says what the call will change.
  const work = typeof input.workId === "string" ? input.workId : typeof input.machine === "string" ? input.machine : ""
  await assert({
    sessionID: call.sessionID,
    agent: call.agent,
    action: spec.id,
    resources: work ? [work] : ["*"],
    source: { type: "tool", messageID: call.messageID, id: call.id },
  })
}

/**
 * The tools RPC's methods: the same table, the same schema, the same run and the same action, so a script and the model
 * get one answer. A write still asserts inside its run, so a script's ask is refused rather than left waiting.
 */
export function ownedMethods(fleet: Fleet, assert: Plugin.Context["permission"]["assert"]): readonly PluginMethod[] {
  return TOOLS.map((spec) => ({
    kind: "plugin",
    class: spec.class,
    name: spec.id,
    action: spec.id,
    description: spec.description,
    input: spec.input,
    output: { type: "object" } as const,
    run: async (value: unknown, call: ToolCall) => {
      const input = (value ?? {}) as Record<string, unknown>
      await assertTool(assert, spec, input, { sessionID: call.sessionID, agent: call.agent, messageID: call.messageID, id: call.id })
      return (await runTool(spec.name, fleet, input)).output
    },
  }))
}
