import { spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import { describe, expect, it } from "vitest"
import { fileURLToPath } from "node:url"

const helper = fileURLToPath(new URL("../guest/guest.py", import.meta.url))

describe("guest helper", () => {
  it("admits a prompt and exports a transcript over the local HTTP API", async () => {
    const seen: string[] = []
    const server = await listen(async (req, res) => {
      seen.push(`${req.method} ${req.url}`)
      const body = await read(req)
      if (req.url === "/api/info") return json(res, { data: { version: "2.2.6" } })
      if (req.url === "/api/session" && req.method === "GET") {
        return json(res, { data: [{ id: "ses_root", parentID: undefined }, { id: "ses_child", parentID: "ses_root" }], cursor: {} })
      }
      if (req.url === "/api/session/ses_root/prompt" && req.method === "POST") {
        expect(JSON.parse(body).text).toBe("Add a health check.")
        return json(res, { data: { id: "msg_1" } })
      }
      if (req.url === "/api/experimental/session/ses_root/export") {
        return json(res, { data: { info: { id: "ses_root" }, messages: [{ type: "user", text: "Add a health check." }] } })
      }
      if (req.url === "/api/experimental/session/import" && req.method === "POST" && body.includes("ses_already")) {
        res.writeHead(409, { "content-type": "application/json" })
        res.end(JSON.stringify({ message: "Session already exists: ses_already" }))
        return
      }
      if (req.url === "/api/experimental/session/import" && req.method === "POST") {
        const parsed = JSON.parse(body)
        expect(parsed.info.parentID).toBe("ses_local_parent")
        expect(parsed.location.directory).toBe("/home/boxd/work/review-api")
        return json(res, { data: { id: "ses_imported" } })
      }
      if (req.url === "/api/session/ses_root") return json(res, { data: { id: "ses_root", time: { created: 1, updated: 2, idle: 2 } } })
      if (req.url === "/api/session/active") return json(res, { data: {} })
      res.writeHead(404)
      res.end()
    })
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      const admitted = await guest({ action: "prompt", base, sessionID: "ses_root", text: "Add a health check." })
      expect(admitted.admitted).toBe("ses_root")
      const exported = await guest({ action: "export", base, sessionID: "ses_root" })
      expect(exported.export).toMatchObject({ data: { info: { id: "ses_root" } } })
      const imported = await guest({
        action: "import",
        base,
        directory: "/home/boxd/work/review-api",
        transfer: { info: { id: "ses_child", parentID: "ses_local_parent" }, messages: [] },
      })
      expect(imported.id).toBe("ses_imported")
      const again = await guest({
        action: "import",
        base,
        transfer: { info: { id: "ses_already" }, messages: [] },
      })
      expect(again.id).toBe("ses_already")
      const phase = await guest({ action: "phase", base, sessionID: "ses_root" })
      expect(phase.phase).toBe("idle")
      expect(seen.every((line) => line.startsWith("GET ") || line.startsWith("POST "))).toBe(true)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

function guest(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [helper], { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.on("close", (code) => {
      const line = stdout.trim().split("\n").at(-1) ?? ""
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (code !== 0) reject(new Error(JSON.stringify(parsed)))
      else resolve(parsed)
    })
    child.stdin.end(JSON.stringify(request))
  })
}

function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<void>): Promise<Server> {
  const server = createServer((req, res) => {
    void handler(req, res).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)))
}

function json(res: import("node:http").ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function read(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })
}
