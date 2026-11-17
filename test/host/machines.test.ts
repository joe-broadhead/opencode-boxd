// Package C1 on the public @opencode/sdk host (design §7.2), on every tested release: boxd_ensure, boxd_golden,
// boxd_resume and boxd_reassign run through the host's own executor (the model path) and the tools RPC (a script),
// against the fake boxd CLI and the fake guest. And, when asked for, the measurement of the longest call the host lets
// a tool run, which sets the list bound B (§4.2).
import { MEASURE_DEBUG, MEASURE_MINUTES as MEASURE } from "./measure-env.js"
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { join } from "node:path"
import { TOOLS_RPC_ID } from "../../src/tools-rpc.js"
import { attempt, cleanup, HOST_VERSION, session, startHost, until, type Host } from "./harness.js"

setDefaultTimeout(120_000)
afterAll(cleanup)

/** One tools RPC call, as a script makes it. */
const rpcCall = async (host: Host, method: string, sessionID: string, input: unknown) => {
  const rpc = host.client.rpc as unknown as { call: (request: object) => Promise<{ output: Record<string, any> }> }
  return (await rpc.call({ rpcID: TOOLS_RPC_ID, method, input: { sessionID, input }, location: host.location })).output
}

describe("package C1's tools on a stock host", () => {
  test("ensure creates, converges and adopts; golden answers present; resume wakes; reassign moves a machine by id", async () => {
    const host = await startHost()
    try {
      const build = await session(host)

      // A new work from the golden image the host's fake already has, on the model path, with no prompt.
      const made = await attempt(host, build, "build", "boxd_ensure", "reject", { workId: "review-api" })
      expect(made).toMatchObject({ asked: undefined, ok: true, output: { state: "ready", workId: "review-api", machine: "oc-review-api", region: "fra", created: true } })
      const create = host.boxd.calls().find((call) => call.startsWith("machine new oc-review-api"))!
      expect(create).toContain("--auto-suspend-timeout 0 --auto-hibernate-timeout 7200 --idle-ignore-outbound=off")
      const machineId = (made.output as { machineId: string }).machineId

      // The same call again converges and repeats nothing: no second create.
      const again = await rpcCall(host, "boxd_ensure", build, { workId: "review-api" })
      expect(again).toMatchObject({ state: "ready", created: false, machineId })
      expect(host.boxd.calls().filter((call) => call.startsWith("machine new oc-review-api"))).toHaveLength(1)

      // A labelled machine already in nyc is adopted rather than duplicated.
      host.boxd.seed("oc-found", { status: "running", region: "nyc", labels: { owner: "opencode-boxd", role: "session", work: "found" } })
      expect(await rpcCall(host, "boxd_ensure", build, { works: [{ workId: "found" }, { workId: "bad id" }] })).toMatchObject({ state: "refused", error: "NAME_INVALID", field: "works[1].workId" })
      const list = await rpcCall(host, "boxd_ensure", build, { works: [{ workId: "found" }] })
      expect(list).toMatchObject({ state: "done", counts: { ready: 1 }, results: [{ workId: "found", region: "nyc", adopted: true }] })

      expect(await rpcCall(host, "boxd_golden", build, { region: "fra" })).toMatchObject({ state: "present" })

      // Hibernated behind the plugin's back: resume wakes it by its id.
      host.boxd.fake.update((state) => void (state.machines.find((machine) => machine.id === machineId)!.status = "hibernated"))
      expect(await rpcCall(host, "boxd_resume", build, { works: ["review-api"] })).toMatchObject({ state: "done", results: [{ state: "ready", rebuilt: false }] })
      expect(host.boxd.calls()).toContain(`machine wake ${machineId} --region fra --json`)

      // An unstarted work's machine moves to a new id. The host's temp root is a git repository, and the fake machines'
      // disks sit inside it: git's discovery stops at the disks, as it stops at a real machine's root.
      process.env.GIT_CEILING_DIRECTORIES = join(host.boxd.fake.dir, "disks")
      const spare = await rpcCall(host, "boxd_ensure", build, { workId: "spare" })
      const moved = await rpcCall(host, "boxd_reassign", build, { from: "spare", to: "db-migration" })
      expect(moved).toMatchObject({ from: "spare", workId: "db-migration", machine: "oc-db-migration", machineId: spare.machineId, state: "ready" })
      expect(host.boxd.calls()).toContain(`machine rename ${spare.machineId} oc-db-migration -y --region fra --json`)
      expect(await rpcCall(host, "boxd_reassign", build, { from: "spare", to: "other" })).toMatchObject({ state: "refused", error: "NOT_OURS" })
    } finally {
      await host.close()
    }
  })

  test("at ask-changes ensure asks, and a decline creates nothing", async () => {
    const host = await startHost({ options: { access: "ask-changes" } })
    try {
      const build = await session(host)
      const declined = await attempt(host, build, "build", "boxd_ensure", "reject", { workId: "asked" })
      expect(declined).toMatchObject({ asked: "boxd_ensure", ok: false })
      expect(host.boxd.calls()).toEqual([])
      const allowed = await attempt(host, build, "build", "boxd_ensure", "once", { workId: "asked" })
      expect(allowed).toMatchObject({ asked: "boxd_ensure", ok: true, output: { state: "ready", created: true } })
    } finally {
      await host.close()
    }
  })
})

/**
 * The longest call a host lets a call run (§7.2), on both paths a coordinator uses: a model turn through Code Mode (the
 * model's path to plugin tools on these hosts) and a script's RPC call. A probe tool and a probe RPC method each sleep
 * on their signal for every duration, all at once, and each answer says whether it finished or the host ended it. The
 * shortest limit found, less 30 s, is the list bound B; with no limit B stays CALL_BOUND_MS. It takes as long as its
 * longest duration on every host, so it runs only when asked: BOXD_MEASURE_CALL_MINUTES="2,5,10".
 */
const MeasureRpc = {
  id: "boxd.host-test.measure",
  methods: {
    sleep: {
      input: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
      output: { type: "object", required: ["finished"], properties: { finished: { type: "boolean" } } },
    },
  },
  events: {},
} as const

/** Sleeps `ms`, or until `signal` stops it: true when it slept the whole time. */
const sleepOn = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), ms)
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve(false)), { once: true })
  })

describe.skipIf(MEASURE.length === 0)("the longest call the host allows (B)", () => {
  test("a call that sleeps on its signal finishes each duration, or the host ends it, from Code Mode and from the RPC", async () => {
    const host = await startHost({ model: true })
    try {
      const ctx = host.probe()
      await ctx.tool.transform((editor) => {
        editor.namespace({ name: "measure", description: "A probe that sleeps, to measure how long a call may run." })
        editor.add({
          name: "sleep",
          options: { namespace: "measure" },
          description: "Sleeps for the given milliseconds, or until the call is stopped.",
          input: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
          output: { type: "object" },
          execute: async (value, context) => {
            const finished = await sleepOn((value as { ms: number }).ms, context.signal)
            return { output: { finished }, content: finished ? "measure:finished" : "measure:stopped" }
          },
        })
      })
      await (ctx.rpc.register as unknown as (definition: object, handlers: object) => Promise<unknown>)(MeasureRpc, {
        sleep: async (input: { ms: number }, call: { signal?: AbortSignal }) => ({ finished: await sleepOn(input.ms, call?.signal) }),
      })
      const rpc = (host.client.rpc as unknown as (definition: object) => { sleep: (input: object, options: object) => Promise<{ finished: boolean }> })(MeasureRpc)

      const codeMode = async (minutes: number) => {
        const ms = Math.round(minutes * 60_000)
        const turn = await host.client.session.create({ location: { directory: host.location.directory }, agent: "build" })
        const started = Date.now()
        const program = `const r = await tools.measure.sleep({ ms: ${ms} }); return r.finished ? "measure:finished" : "measure:stopped"`
        await host.client.session.prompt({ sessionID: turn.id, text: `[[mock:tool:execute:${JSON.stringify({ code: program })}]]` })
        const text = await until(
          "the measured call ends",
          async () => {
            const context = (await host.probe().session.context({ sessionID: turn.id })) as { content?: { text?: string }[] }[]
            const value = context.flatMap((message) => message.content ?? []).map((part) => part.text ?? "").join("\n")
            const ended = (await host.client.session.get({ sessionID: turn.id })).outcome !== undefined
            return value.includes("after-tool:") || ended ? value : undefined
          },
          ms + 5 * 60_000,
        )
        if (MEASURE_DEBUG) console.log(text)
        return { path: "code-mode", minutes, finished: text.includes("measure:finished"), ms: Date.now() - started }
      }
      const script = async (minutes: number) => {
        const ms = Math.round(minutes * 60_000)
        const started = Date.now()
        const finished = await rpc.sleep({ ms }, { location: host.location }).then(
          (answer) => answer.finished === true,
          (error: unknown) => (MEASURE_DEBUG && console.log(error), false),
        )
        return { path: "rpc", minutes, finished, ms: Date.now() - started }
      }
      const findings = await Promise.all(MEASURE.flatMap((minutes) => [codeMode(minutes), script(minutes)]))
      console.log(`[measure] ${HOST_VERSION} ${JSON.stringify(findings)}`)
      expect(findings).toHaveLength(MEASURE.length * 2)
    } finally {
      await host.close()
    }
  }, 3 * 60 * 60_000)
})
