// A loopback fake of the guest OpenCode server: the few endpoints guest/guest.py uses. It answers in OpenCode's own
// envelope (`{ data: … }`), keeps sessions in memory, and lets a test mark a session idle or busy. Messages list as the
// real server lists them: newest first and 50 a page unless asked otherwise, optionally of one type.
export interface FakeSession {
  id: string
  parentID?: string
  busy: boolean
  /** The run stopped with the server: its busy stamp never got an idle one, and nothing runs. */
  interrupted?: boolean
  directory: string
  /** The transcript, oldest first. Each finished run ends with an idle message that carries its outcome. */
  messages: Array<FakeMessage>
  /** The session's last run, as OpenCode records it on the session and its last idle message. */
  outcome?: "succeeded" | "failed" | "interrupted"
  /** Prompts admitted while the session ran: they wait here until a run takes them. */
  inbox: Array<{ id: string; type: "user"; payload: { text: string } }>
  /** When the session last changed, in epoch milliseconds. */
  updated: number
}

export type FakeMessage = {
  type: string
  text?: string
  outcome?: "succeeded" | "failed"
  error?: { type: string; message: string }
  time?: { created: number }
  content?: Array<{ type: string; text: string }>
}

export interface FakeGuest {
  readonly url: string
  readonly port: number
  readonly sessions: Map<string, FakeSession>
  readonly prompts: Array<{ sessionID: string; text: string }>
  readonly imports: Array<{ id: string; parentID?: string }>
  /** Ways this server can misbehave: a test sets one to see a caller cope. */
  readonly quirks: { activeFails: boolean; ignoresTypeFilter: boolean }
  /** The next created session's id. */
  next(id: string): void
  idle(sessionID: string): void
  /** The guest server died mid-run: the session keeps a busy stamp later than its idle stamp, and nothing runs. */
  interrupt(sessionID: string): void
  /** The session's last run failed with this error, as a provider refusal does. */
  fail(sessionID: string, error: { type: string; message: string }): void
  /** The session's last run completed. */
  complete(sessionID: string): void
  /** The session's model wrote this text, as an assistant message at `at` (epoch milliseconds). */
  say(sessionID: string, text: string, at: number): void
  close(): Promise<void>
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

export function startFakeGuest(): FakeGuest {
  const sessions = new Map<string, FakeSession>()
  const prompts: Array<{ sessionID: string; text: string }> = []
  const imports: Array<{ id: string; parentID?: string }> = []
  let created = 0
  let nextId = "ses_guest_root"
  const quirks = { activeFails: false, ignoresTypeFilter: false }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname
      const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {}
      if (path === "/api/info") return json({ data: { ok: true } })
      if (path === "/api/session" && request.method === "GET") return json({ data: [...sessions.values()].map(({ id, parentID }) => ({ id, parentID })) })
      if (path === "/api/session" && request.method === "POST") {
        created += 1
        const id = created === 1 ? nextId : `${nextId}_${created}`
        sessions.set(id, { id, busy: false, directory: String((body.location as { directory?: string } | undefined)?.directory ?? ""), messages: [], inbox: [], updated: 1 })
        return json({ data: { id } })
      }
      if (path === "/api/session/active" && quirks.activeFails) return json({ error: "unavailable" }, 503)
      if (path === "/api/session/active") return json({ data: Object.fromEntries([...sessions.values()].filter((session) => session.busy).map((session) => [session.id, true])) })
      const single = /^\/api\/session\/(ses_[A-Za-z0-9_-]+)$/.exec(path)
      if (single) {
        const session = sessions.get(single[1]!)
        if (!session) return json({ error: "not found" }, 404)
        return json({
          data: {
            id: session.id,
            ...(session.outcome ? { outcome: session.outcome } : {}),
            time: session.interrupted
              ? { created: 1, updated: session.updated, busy: 2, idle: 1 }
              : { created: 1, updated: session.updated, busy: session.busy ? 2 : undefined, idle: session.busy ? undefined : 2 },
          },
        })
      }
      const messages = /^\/api\/session\/(ses_[A-Za-z0-9_-]+)\/message$/.exec(path)
      if (messages) {
        const session = sessions.get(messages[1]!)
        if (!session) return json({ error: "not found" }, 404)
        // The real server's defaults: newest first, 50 a page, every type unless `type` names one.
        const type = quirks.ignoresTypeFilter ? null : url.searchParams.get("type")
        const listed = session.messages.map((message, index) => ({ id: `msg_${index}`, ...message })).filter((message) => !type || message.type === type)
        const ordered = (url.searchParams.get("order") ?? "desc") === "desc" ? listed.reverse() : listed
        return json({ data: ordered.slice(0, Number(url.searchParams.get("limit") ?? 50)), cursor: {} })
      }
      const inbox = /^\/api\/session\/(ses_[A-Za-z0-9_-]+)\/inbox$/.exec(path)
      if (inbox) {
        const session = sessions.get(inbox[1]!)
        if (!session) return json({ error: "not found" }, 404)
        return json({ data: session.inbox })
      }
      const prompt = /^\/api\/session\/(ses_[A-Za-z0-9_-]+)\/prompt$/.exec(path)
      if (prompt && request.method === "POST") {
        const session = sessions.get(prompt[1]!)
        if (!session) return json({ error: "not found" }, 404)
        prompts.push({ sessionID: session.id, text: String(body.text ?? "") })
        // A running session keeps the prompt in its inbox until the run takes it.
        if (session.busy) {
          session.inbox.push({ id: `msg_inbox_${session.inbox.length}`, type: "user", payload: { text: String(body.text ?? "") } })
          return json({ data: { admitted: session.id } })
        }
        session.busy = true
        session.interrupted = false
        session.messages.push({ type: "user", text: String(body.text ?? "") })
        return json({ data: { admitted: session.id } })
      }
      const exported = /^\/api\/experimental\/session\/(ses_[A-Za-z0-9_-]+)\/export$/.exec(path)
      if (exported) {
        const session = sessions.get(exported[1]!)
        if (!session) return json({ error: "not found" }, 404)
        return json({
          data: {
            info: { id: session.id, ...(session.parentID ? { parentID: session.parentID } : {}), title: session.id, location: { directory: session.directory } },
            messages: session.messages,
          },
        })
      }
      if (path === "/api/experimental/session/import" && request.method === "POST") {
        const info = body.info as { id?: string; parentID?: string } | undefined
        if (!info?.id) return json({ error: "info is required" }, 400)
        if (sessions.has(info.id)) return json({ error: "conflict" }, 409)
        sessions.set(info.id, {
          id: info.id,
          ...(info.parentID ? { parentID: info.parentID } : {}),
          busy: false,
          inbox: [],
          updated: 1,
          directory: String((body.location as { directory?: string } | undefined)?.directory ?? ""),
          messages: Array.isArray(body.messages) ? (body.messages as FakeMessage[]) : [],
        })
        imports.push({ id: info.id, ...(info.parentID ? { parentID: info.parentID } : {}) })
        return json({ data: { id: info.id } })
      }
      return json({ error: `unhandled ${request.method} ${path}` }, 404)
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: Number(server.port),
    quirks,
    sessions,
    prompts,
    imports,
    next: (id: string) => void (nextId = id),
    idle: (sessionID: string) => {
      const session = sessions.get(sessionID)
      if (session) session.busy = false
    },
    interrupt: (sessionID: string) => {
      const session = sessions.get(sessionID)
      if (session) {
        session.busy = false
        session.interrupted = true
      }
    },
    fail: (sessionID: string, error: { type: string; message: string }) => {
      const session = sessions.get(sessionID)
      if (session) {
        session.busy = false
        session.outcome = "failed"
        session.messages.push({ type: "idle", outcome: "failed", error })
      }
    },
    complete: (sessionID: string) => {
      const session = sessions.get(sessionID)
      if (session) {
        session.busy = false
        session.outcome = "succeeded"
        session.messages.push({ type: "idle", outcome: "succeeded" })
      }
    },
    say: (sessionID: string, text: string, at: number) => {
      const session = sessions.get(sessionID)
      if (session) {
        session.messages.push({ type: "assistant", time: { created: at }, content: [{ type: "reasoning", text: "thinking" }, { type: "text", text }] })
        session.updated = at
      }
    },
    close: () => server.stop(true),
  }
}
