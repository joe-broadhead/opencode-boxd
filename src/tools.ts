import type { Plugin } from "@opencode/plugin"
import { BoxdError } from "./errors.js"
import type { createFleet } from "./fleet.js"

type Fleet = ReturnType<typeof createFleet>
type ToolContext = { sessionID: string; agent?: string; messageID: string; id: string }

const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

export async function registerTools(
  ctx: Plugin.Context,
  fleet: Fleet,
): Promise<{ dispose(): Promise<void> }> {
  return ctx.tool.transform((editor) => {
    editor.namespace({
      name: "boxd",
      description: "Run OpenCode on a private boxd machine and keep the session on this laptop. A snapshot is an image, not a session.",
    })
    const add = (name: string, description: string, required: string[], properties: Record<string, unknown>, run: (input: Record<string, unknown>) => Promise<unknown>) => {
      editor.add({
        name,
        description,
        input: object(properties, required),
        options: { namespace: "boxd", codemode: false },
        execute: async (input, context) => {
          await ctx.permission.assert({
            sessionID: (context as ToolContext).sessionID,
            agent: (context as ToolContext).agent,
            action: `boxd_${name}`,
            resources: [name],
            source: { type: "tool", messageID: (context as ToolContext).messageID, id: (context as ToolContext).id },
          })
          try {
            return { content: JSON.stringify(await run(input as Record<string, unknown>)) }
          } catch (error) {
            if (error instanceof BoxdError) {
              return { content: JSON.stringify({ error: error.code, message: error.message, next: error.next }) }
            }
            throw error
          }
        },
      })
    }

    add("status", "List boxd works, machines, and snapshots. Read only.", [], {}, () => fleet.status())
    add(
      "ensure",
      "Get a private machine from the golden snapshot for a work id. Returns starting if it is not up. Does not wait.",
      ["workId"],
      { workId: { type: "string" }, directory: { type: "string" }, repo: { type: "string" }, title: { type: "string" } },
      (input) => fleet.ensure({ workId: String(input.workId), directory: optional(input.directory), repo: optional(input.repo), title: optional(input.title) }),
    )
    add(
      "submit",
      "Admit a prompt on the guest OpenCode. Returns when the prompt is admitted, not when the model finishes.",
      ["workId", "text"],
      { workId: { type: "string" }, text: { type: "string" }, title: { type: "string" } },
      (input) => fleet.submit({ workId: String(input.workId), text: String(input.text), title: optional(input.title) }),
    )
    add("job", "Read whether the guest session is busy or idle. One check. Does not wait.", ["workId"], { workId: { type: "string" } }, (input) =>
      fleet.job({ workId: String(input.workId) }),
    )
    add(
      "harvest",
      "Export the session tree, import it on this laptop, and record git. Refuses while the session is busy.",
      ["workId", "localDirectory"],
      { workId: { type: "string" }, localDirectory: { type: "string" } },
      (input) => fleet.harvest({ workId: String(input.workId), localDirectory: String(input.localDirectory) }),
    )
    add("sleep", "Hibernate the machine. Refuses without a fresh laptop import.", ["workId"], { workId: { type: "string" } }, (input) =>
      fleet.sleep({ workId: String(input.workId) }),
    )
    add("drop", "Destroy the machine. Refuses unless the laptop import is fresh and git is clean or patched.", ["workId"], { workId: { type: "string" } }, (input) =>
      fleet.drop({ workId: String(input.workId) }),
    )
    add(
      "resume",
      "Wake a hibernated machine, or import the proven transcript onto a new machine from the golden snapshot.",
      ["workId"],
      { workId: { type: "string" } },
      (input) => fleet.resume({ workId: String(input.workId) }),
    )
    add(
      "image",
      "Save a new immutable snapshot. Refuses if any work on that machine lacks a fresh export. Not a session backup.",
      ["machine", "name"],
      { machine: { type: "string" }, name: { type: "string" } },
      (input) => fleet.image({ machine: String(input.machine), name: String(input.name) }),
    )
  })
}

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}
