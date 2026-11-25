/** `status`: the contract's status answer, and the `boxd.works.list` snapshot a consumer reads with `{ list: "works" }`. */
import { NO_ACCOUNTS, STATUS_SCHEMA, statusAnswer } from "@we-the-rebel-alliance/plugin-contract/accounts"
import type { JsonSchema } from "@we-the-rebel-alliance/plugin-contract/manifest"
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { manifest, VERSION } from "../manifest.js"
import type { StatusResult } from "../results.js"
import { worksSnapshot } from "../status.js"
import { STATUS_INPUT } from "./schemas.js"

/** What the status handler knows at setup: the installed host and its problems. */
export interface StatusDeps {
  readonly hostVersion: string
  readonly problems: () => readonly string[]
  /** One fleet read for the status answer: the listing's sign-in state. */
  readonly fleet: () => Promise<StatusResult>
  /** One fleet read for the works list snapshot: every work, newest activity first. */
  readonly works: () => Promise<StatusResult>
}

const LIST: JsonSchema = {
  type: "object",
  properties: {
    data: {
      type: "object",
      properties: {
        items: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: { id: { type: "string", maxLength: 128 }, text: { type: "string", maxLength: 200 }, note: { type: "string", maxLength: 200 } },
            required: ["id", "text"],
            additionalProperties: false,
          },
        },
        editable: { type: "boolean", enum: [false] },
      },
      required: ["items", "editable"],
      additionalProperties: false,
    },
    asOf: { type: "string", minLength: 1 },
    trust: { type: "string", enum: ["untrusted"] },
  },
  required: ["data", "asOf", "trust"],
  additionalProperties: false,
}

const OUTPUT: JsonSchema = { anyOf: [STATUS_SCHEMA, LIST] }

const DESCRIPTION =
  "The plugin's own state: its host range, its problems, the agents that lack its access rules, and the one next step. It holds no account or credential; sign in with the boxd CLI, and use probe for the local machine identity. It never reads a guest, so it never wakes a machine. Pass list: \"works\" for the works list (id and phase) a consumer binds as the boxd.works.list snapshot. For the fleet's counts, cost and per-work next calls, a person runs /boxd and an agent uses boxd_job or boxd_events_list."

/** The status handler. */
export function statusHandler(deps: StatusDeps): MethodHandler {
  return {
    description: DESCRIPTION,
    input: STATUS_INPUT,
    output: OUTPUT,
    async run(input, call) {
      if (input.list === "works") {
        const works = await deps.works().then(
          (value) => ({ value }) as const,
          () => ({ error: true }) as const,
        )
        return worksSnapshot("value" in works ? works.value : null)
      }
      const fleet = await deps.fleet().then(
        (value) => ({ value }) as const,
        (error: unknown) => ({ error }) as const,
      )
      const problems = [...deps.problems()]
      if ("error" in fleet) problems.push(`the boxd CLI could not answer its machine listing: ${fleet.error instanceof Error ? fleet.error.message.split("\n", 1)[0] : String(fleet.error)}`)
      else if (!fleet.value.cli.signedIn) problems.push("the boxd CLI is not signed in; run boxd auth login, then read status again.")
      return statusAnswer({ manifest, version: VERSION, hostVersion: deps.hostVersion, accounts: NO_ACCOUNTS, problems, unguardedAgents: await call.unguardedAgents() })
    },
  }
}
