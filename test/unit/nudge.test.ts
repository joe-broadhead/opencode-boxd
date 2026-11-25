// A write nudges every app through `call.bus`: the contract's `changed` event, naming the works capability and the
// local account. A failed write nudges nothing.
import { describe, expect, test } from "bun:test"
import type { MethodCall } from "@we-the-rebel-alliance/plugin-contract/register"
import { nudge } from "../../src/handlers/run.js"

function call(emitted: Array<{ event: string; data: unknown }>): MethodCall {
  return {
    sessionID: "ses_1",
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
    signal: new AbortController().signal,
    progress: async () => {},
    account: "default",
    bus: {
      name: "boxd",
      async emit(event: string, data: unknown) {
        emitted.push({ event, data })
        return { ok: true as const }
      },
    },
    unguardedAgents: async () => ({ ok: true, agents: [] }),
    door: "tool",
  }
}

describe("the changed nudge", () => {
  test("names the works capability, the local account and a short reason", async () => {
    const emitted: Array<{ event: string; data: unknown }> = []
    await nudge(call(emitted))
    expect(emitted).toEqual([{ event: "changed", data: { capability: "boxd.works", account: "default", reason: "write" } }])
  })
})
