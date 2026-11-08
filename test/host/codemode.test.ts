// The Code Mode path on the stock host: a model turn runs a program through the host's `execute` tool, which is how a
// model reaches a plugin's tools. A read runs, an inner write asks and is refused when declined, and an unknown method
// is denied. The tools RPC path is `boxd.test.ts`; this file is the other half R2 asks for.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { startHost, until } from "./harness.js"

setDefaultTimeout(120_000)
afterAll(async () => {
  // The harness's `close` stops the mock model and the fake guest; the temp root is removed by the isolate module.
})

/** One turn that runs `program` inside Code Mode, and the text the model sees afterwards. */
async function code(host: Awaited<ReturnType<typeof startHost>>, sessionID: string, program: string) {
  await host.client.session.prompt({ sessionID, text: `[[mock:tool:execute:${JSON.stringify({ code: program })}]]` })
  return until("the Code Mode program answers", async () => {
    const context = (await host.probe().session.context({ sessionID })) as { content?: { type?: string; text?: string }[] }[]
    const text = context.flatMap((message) => message.content ?? []).map((part) => part.text ?? "").join("\n")
    return text.includes("after-tool:") ? text : undefined
  }, 60_000)
}

describe("the Code Mode path", () => {
  test("a read runs inside a program, and an inner write asks and is refused when declined", async () => {
    const host = await startHost({ model: true })
    try {
      const session = await host.client.session.create({ location: { directory: host.location.directory }, agent: "build" })
      const before = host.boxd.calls().length

      const read = await code(host, session.id, "const r = await tools.boxd.status({}); return JSON.stringify(r)")
      expect(read).toContain("after-tool:")
      expect(host.boxd.calls().slice(before).filter((line) => line.startsWith("machine new"))).toEqual([])

      // The write asks: the turn leaves a request waiting, and declining it runs nothing.
      await host.client.session.prompt({
        sessionID: session.id,
        text: `[[mock:tool:execute:${JSON.stringify({ code: 'return await tools.boxd.ensure({ workId: "review-api", directory: "' + host.location.directory + '" })' })}]]`,
      })
      const asked = await until("the write asks", async () => (await host.probe().permission.list({ sessionID: session.id })).find((entry) => entry.action === "boxd_ensure"), 30_000)
      expect(asked.action).toBe("boxd_ensure")
      await host.probe().permission.reply({ sessionID: session.id, requestID: asked.id, decision: "reject", message: "not now" })
      await until("the turn ends", async () => (await host.client.session.get({ sessionID: session.id })).outcome !== undefined, 30_000)
      expect(host.boxd.calls().slice(before).filter((line) => line.startsWith("machine new"))).toEqual([])
      expect(host.boxd.machines()).toEqual({})
    } finally {
      await host.close()
    }
  })

  test("an unknown method is denied, and nothing is dispatched", async () => {
    const host = await startHost({ model: true })
    try {
      const session = await host.client.session.create({ location: { directory: host.location.directory }, agent: "build" })
      const before = host.boxd.calls().length
      const answer = await code(host, session.id, "try { await tools.boxd.no_such_tool({}); return 'ran' } catch (error) { return 'refused: ' + String(error.message).slice(0, 80) }")
      expect(answer).toContain("after-tool: refused")
      expect(host.boxd.calls().slice(before)).toEqual([])
    } finally {
      await host.close()
    }
  })
})
