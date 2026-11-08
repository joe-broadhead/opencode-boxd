// A scriptable OpenAI-compatible model on loopback, for the Code Mode host test: the answer is chosen by a directive in
// the last user message, so one turn can be a tool call and the next the answer. It never leaves 127.0.0.1.
//   [[mock:tool:NAME:JSON]]   one tool call, then "after-tool: …" once the tool result arrives
//   [[mock:text:SOME TEXT]]   a plain answer
export interface MockModel {
  readonly baseURL: string
  stop(): void
}

type Message = { role: string; content?: unknown }
const text = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : ""

const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "m1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

const answer = (value: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        const send = (line: string) => controller.enqueue(encoder.encode(line))
        send(chunk({ role: "assistant", content: "" }))
        send(chunk({ content: value }))
        send(chunk({}, "stop"))
        send("data: [DONE]\n\n")
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
  )

const toolCall = (name: string, args: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        const send = (line: string) => controller.enqueue(encoder.encode(line))
        send(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: "" } }] }))
        send(chunk({ tool_calls: [{ index: 0, function: { arguments: args || "{}" } }] }))
        send(chunk({}, "tool_calls"))
        send("data: [DONE]\n\n")
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
  )

export function startMockModel(): MockModel {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "m1", object: "model", owned_by: "mock" }] })
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await request.json()) as { messages?: Message[]; tools?: { function: { name: string } }[] }
      const messages = body.messages ?? []
      const last = messages[messages.length - 1]
      if ((body.tools ?? []).length === 0) return answer("Mock title")
      // After the tool result, a short answer that carries what the tool said, so the test can read it back.
      if (last?.role === "tool") return answer(`after-tool: ${text(last.content).slice(0, 400)}`)
      const prompt = text([...messages].reverse().find((message) => message.role === "user")?.content)
      const directive = /\[\[mock:tool:([^:\]]+):?([^\]]*)\]\]/.exec(prompt)
      if (directive) return toolCall(directive[1]!, directive[2] ?? "{}")
      return answer("ok")
    },
  })
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, stop: () => void server.stop(true) }
}
