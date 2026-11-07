// A loopback fake of the guest OpenCode server: the few endpoints guest/guest.py uses. It answers in OpenCode's own
// envelope (`{ data: … }`), keeps sessions in memory, and lets a test mark a session idle or busy.
export interface FakeSession {
  id: string
  parentID?: string
  busy: boolean
  directory: string
  messages: Array<{ type: string; text: string }>
}

export interface FakeGuest {
  readonly url: string
  readonly port: number
  readonly sessions: Map<string, FakeSession>
  readonly prompts: Array<{ sessionID: string; text: string }>
  readonly imports: Array<{ id: string; parentID?: string }>
  /** The next created session's id. */
  next(id: string): void
  idle(sessionID: string): void
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
        sessions.set(id, { id, busy: false, directory: String((body.location as { directory?: string } | undefined)?.directory ?? ""), messages: [] })
        return json({ data: { id } })
      }
      if (path === "/api/session/active") return json({ data: Object.fromEntries([...sessions.values()].filter((session) => session.busy).map((session) => [session.id, true])) })
      const single = /^\/api\/session\/(ses_[A-Za-z0-9_-]+)$/.exec(path)
      if (single) {
        const session = sessions.get(single[1]!)
        if (!session) return json({ error: "not found" }, 404)
        return json({ data: { id: session.id, time: { created: 1, busy: session.busy ? 2 : undefined, idle: session.busy ? undefined : 2 } } })
      }
      const prompt = /^\/api\/session\/(ses_[A-Za-z0-9_-]+)\/prompt$/.exec(path)
      if (prompt && request.method === "POST") {
        const session = sessions.get(prompt[1]!)
        if (!session) return json({ error: "not found" }, 404)
        prompts.push({ sessionID: session.id, text: String(body.text ?? "") })
        session.busy = true
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
          directory: String((body.location as { directory?: string } | undefined)?.directory ?? ""),
          messages: Array.isArray(body.messages) ? (body.messages as Array<{ type: string; text: string }>) : [],
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
    sessions,
    prompts,
    imports,
    next: (id: string) => void (nextId = id),
    idle: (sessionID: string) => {
      const session = sessions.get(sessionID)
      if (session) session.busy = false
    },
    close: () => server.stop(true),
  }
}
