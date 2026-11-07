// The guest session's last run, and what the plugin says about it. An idle session that failed is not a finished job:
// `boxd_job` and `boxd_harvest` report the outcome, and a harvest keeps the transcript while warning that the run failed.
import { describe, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { errorLine, isCredentialFailure, mapOutcome, nextStepFor, readRun } from "../../src/outcome.js"
import { world } from "./fake.js"

const AUTH_ERROR = {
  type: "provider.auth",
  message: "Go Teams covers workspace members, not service accounts. Use a personal API key to call Go models.",
}

const local = () => mkdtemp(join(tmpdir(), "boxd-local-"))

describe("reading a run", () => {
  test("maps OpenCode's three words, and nothing else", () => {
    expect(mapOutcome("succeeded")).toBe("completed")
    expect(mapOutcome("failed")).toBe("failed")
    expect(mapOutcome("interrupted")).toBe("aborted")
    expect(mapOutcome("running")).toBeNull()
    expect(mapOutcome(undefined)).toBeNull()
  })

  test("the session's own outcome wins, and the last idle message carries the error", () => {
    const run = readRun({ outcome: "failed" }, [{ type: "idle", outcome: "failed", error: AUTH_ERROR }])
    expect(run).toEqual({ outcome: "failed", error: "provider.auth: Go Teams covers workspace members, not service accounts. Use a personal API key to call Go models" })
  })

  test("a failure's line is redacted and cut, and its response body is never read", () => {
    const line = errorLine({ type: "provider.auth", message: "denied for key=sk-live-0123456789abcdef", response: { body: "secret-body" } })
    expect(line).toBe("provider.auth: denied for key=[redacted]")
    expect(line).not.toContain("sk-live")
    expect(line).not.toContain("secret-body")
    expect(errorLine({ type: "provider.other", message: "" })).toBeUndefined()
  })

  test("a credential failure has its own next step", () => {
    const run = { outcome: "failed" as const, error: "provider.auth: nope" }
    expect(isCredentialFailure(run)).toBe(true)
    expect(nextStepFor(run)).toContain("docs/golden-image.md")
    expect(nextStepFor({ outcome: "failed", error: "tool.timeout: took too long" })).toBe("Read the transcript, then boxd_submit again.")
    expect(nextStepFor({ outcome: "completed" })).toBe("Read the transcript, then boxd_submit again.")
  })
})

describe("a failed run is reported, never hidden", () => {
  /** A work admitted once, with the guest's export and phase carrying the given run. */
  async function ran(run: { outcome: "completed" | "failed" | "aborted"; error?: unknown }) {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api", directory: "/work/example" })
    await w.fleet.submit({ workId: "review-api", text: "Reply with OK." })
    w.guest.phaseById.set("ses_root_review-api", "idle")
    w.guest.runById.set("ses_root_review-api", { outcome: run.outcome, ...(run.error ? { error: errorLine(run.error) } : {}) })
    // The export the guest hands over: the same session info and an idle message with the error.
    w.guest.exportOverride.set("ses_root_review-api", {
      info: { id: "ses_root_review-api", title: "review-api", outcome: run.outcome === "completed" ? "succeeded" : run.outcome === "aborted" ? "interrupted" : "failed" },
      messages: [{ type: "user", text: "Reply with OK." }, { type: "idle", outcome: run.outcome === "completed" ? "succeeded" : "failed", ...(run.error ? { error: run.error } : {}) }],
    })
    const harvested = await w.fleet.harvest({ workId: "review-api", localDirectory: await local() })
    return { w, harvested }
  }

  test("a failed run still proves the transcript, and warns with the redacted line", async () => {
    const { w, harvested } = await ran({ outcome: "failed", error: AUTH_ERROR })
    expect(harvested).toMatchObject({ state: "proven", outcome: "failed", warning: "GUEST_RUN_FAILED" })
    expect(String(harvested.error)).toBe("provider.auth: Go Teams covers workspace members, not service accounts. Use a personal API key to call Go models")
    expect(String(harvested.next)).toContain("Fix the guest's model credentials")
    // The transcript is imported and on disk.
    const saved = await w.ledger.load("review-api")
    expect(saved?.lastOutcome).toMatchObject({ state: "failed" })
    expect(saved?.proof).toBeDefined()
  })

  test("a completed run carries no warning and no error", async () => {
    const { w, harvested } = await ran({ outcome: "completed" })
    expect(harvested).toMatchObject({ state: "proven", outcome: "completed" })
    expect(harvested).not.toHaveProperty("warning")
    expect(harvested).not.toHaveProperty("error")
    expect((await w.ledger.load("review-api"))?.lastOutcome).toMatchObject({ state: "completed" })
  })

  test("an aborted run is reported as aborted", async () => {
    const { harvested } = await ran({ outcome: "aborted" })
    expect(harvested).toMatchObject({ state: "proven", outcome: "aborted" })
    expect(harvested).not.toHaveProperty("warning")
  })

  test("a non-credential failure gets the generic next step", async () => {
    const { harvested } = await ran({ outcome: "failed", error: { type: "tool.timeout", message: "the tool took too long" } })
    expect(String(harvested.next)).toContain("Read the transcript, then boxd_submit again.")
    expect(String(harvested.next)).not.toContain("golden-image")
  })

  test("boxd_job reports the outcome of an idle session", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api", directory: "/work/example" })
    await w.fleet.submit({ workId: "review-api", text: "Reply with OK." })
    w.guest.phaseById.set("ses_root_review-api", "idle")
    w.guest.runById.set("ses_root_review-api", { outcome: "failed", error: "provider.auth: Go Teams covers workspace members" })
    const job = await w.fleet.job({ workId: "review-api" })
    expect(job).toMatchObject({ state: "idle", outcome: "failed", error: "provider.auth: Go Teams covers workspace members" })
    expect(String(job.next)).toContain("Fix the guest's model credentials")
    // A job is a read and records nothing.
    expect((await w.ledger.load("review-api"))?.lastOutcome).toBeUndefined()
  })

  test("boxd_job reports completed, and keeps its harvest advice", async () => {
    const w = await world()
    await w.fleet.ensure({ workId: "review-api", directory: "/work/example" })
    await w.fleet.submit({ workId: "review-api", text: "Reply with OK." })
    w.guest.phaseById.set("ses_root_review-api", "idle")
    w.guest.runById.set("ses_root_review-api", { outcome: "completed" })
    expect(await w.fleet.job({ workId: "review-api" })).toMatchObject({ state: "idle", outcome: "completed" })
    expect(String((await w.fleet.job({ workId: "review-api" })).next)).toContain("boxd_harvest")
  })

  test("status names the failed work, with the error and the next step", async () => {
    const { w } = await ran({ outcome: "failed", error: AUTH_ERROR })
    const status = await w.fleet.status()
    expect(status.works[0]).toMatchObject({ workId: "review-api", outcome: "failed" })
    expect(status.works[0]?.error).toContain("provider.auth")
  })
})
