// The Code Mode path on the stock host: a model turn runs a program through the host's `execute` tool, which is how a
// model reaches a plugin's tools. A read and a change run by default, a change asks under an agent that asks and runs
// nothing when declined, and an unknown method is denied. The tools RPC path is `boxd.test.ts`; this file is the other half of that proof.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { startHost, until } from "./harness.js"

setDefaultTimeout(120_000)
afterAll(async () => {
  // The harness's `close` stops the mock model and the fake guest; the temp root is removed by the isolate module.
})

/** One turn in its own session: the program runs inside Code Mode, and the model's answer is returned. */
async function code(host: Awaited<ReturnType<typeof startHost>>, program: string, expected: string, permissions?: { action: string; resource: string; effect: "allow" | "ask" | "deny" }[]) {
  const session = await host.client.session.create({ location: { directory: host.location.directory }, agent: "build", ...(permissions ? { permissions } : {}) })
  await host.client.session.prompt({ sessionID: session.id, text: `[[mock:tool:execute:${JSON.stringify({ code: program })}]]` })
  const text = await until("the Code Mode program answers", async () => {
    const context = (await host.probe().session.context({ sessionID: session.id })) as { content?: { type?: string; text?: string }[] }[]
    const value = context.flatMap((message) => message.content ?? []).map((part) => part.text ?? "").join("\n")
    // The mock echoes the tool result, so the marker and the expected text together mean this turn's answer arrived.
    return value.includes("after-tool:") && value.includes(expected) ? value : undefined
  }, 60_000)
  return { sessionID: session.id, text }
}

describe("the Code Mode path", () => {
  test("a read and a change run inside a program by default, and a change asks under an agent that asks", async () => {
    const host = await startHost({ model: true })
    try {
      const read = await code(host, "const r = await tools.boxd.status({}); return JSON.stringify(r)", "NOT_IMPLEMENTED")
      expect(read.text).toContain("after-tool:")
      expect(await host.probe().permission.list({ sessionID: read.sessionID })).toEqual([])

      // A change is allowed by default too, so the program reaches the tool with no prompt.
      const wrote = await code(host, `const r = await tools.boxd.ensure({ workId: "review-api" }); return "ensure:" + r.state`, "ensure:ready")
      expect(wrote.text).toContain("after-tool:")
      expect(await host.probe().permission.list({ sessionID: wrote.sessionID })).toEqual([])
      const before = host.boxd.calls().length

      // An agent that asks for the tool still asks, and a decline runs nothing.
      const asking = await host.client.session.create({ location: { directory: host.location.directory }, agent: "build", permissions: [{ action: "boxd_drop", resource: "*", effect: "ask" }] })
      await host.client.session.prompt({
        sessionID: asking.id,
        text: `[[mock:tool:execute:${JSON.stringify({ code: 'return await tools.boxd.drop({ workId: "review-api" })' })}]]`,
      })
      const question = await until("the drop asks", async () => (await host.probe().permission.list({ sessionID: asking.id })).find((entry) => entry.action === "boxd_drop"), 30_000)
      await host.probe().permission.reply({ sessionID: asking.id, requestID: question.id, decision: "reject", message: "not now" })
      await until("the turn ends", async () => (await host.client.session.get({ sessionID: asking.id })).outcome !== undefined, 30_000)
      expect(host.boxd.calls().slice(before)).toEqual([])
    } finally {
      await host.close()
    }
  })

  test("an unknown method is denied, and nothing is dispatched", async () => {
    const host = await startHost({ model: true })
    try {
      const before = host.boxd.calls().length
      const answer = await code(host, "try { await tools.boxd.no_such_tool({}); return 'ran' } catch (error) { return 'refused: ' + String(error.message).slice(0, 80) }", "refused")
      expect(answer.text).toContain("after-tool: refused")
      expect(host.boxd.calls().slice(before)).toEqual([])
    } finally {
      await host.close()
    }
  })
})
