// The plugin wired end to end on each stock host, as `src/plugin.ts` builds it: `boxd_status` reads package E's real
// cost service (the watcher's snapshot and the fake boxd CLI's `manage usage`), the TUI's cleanup command reads E's real
// view through `CleanupViewRpc` on the host's own RPC, and the cost hooks and the session-event stream are registered
// once and stopped when the host disposes the plugin.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { COST_HOOKS, SESSION_GONE_EVENTS } from "../../src/hooks.js"
import { CleanupViewRpc, type CleanupView } from "../../src/services.js"
import tui, { cleanupText } from "../../src/tui.js"
import { attempt, cleanup, HOST_VERSION, session, startHost, until, type Host } from "./harness.js"

setDefaultTimeout(120_000)
afterAll(cleanup)

/** What the plugin registered through its context, and what it stopped again. */
function registrations() {
  const hooks: Array<{ readonly name: string; disposed: number }> = []
  const streams: Array<{ readonly types: readonly string[]; ended: boolean }> = []
  const wrap = (ctx: Plugin.Context): Plugin.Context => {
    const session = new Proxy(ctx.session, {
      get(target, member, receiver) {
        if (member !== "hook") return Reflect.get(target, member, receiver)
        return async (name: string, fn: unknown) => {
          const registration = await (target.hook as (name: string, fn: unknown) => Promise<{ dispose(): Promise<void> }>)(name, fn)
          const entry = { name, disposed: 0 }
          hooks.push(entry)
          return {
            ...registration,
            dispose: async () => {
              entry.disposed++
              await registration.dispose()
            },
          }
        }
      },
    })
    const event = new Proxy(ctx.event, {
      get(target, member, receiver) {
        if (member !== "subscribe") return Reflect.get(target, member, receiver)
        return (input: { readonly types: readonly string[] }) => {
          const entry = { types: [...input.types], ended: false }
          streams.push(entry)
          const inner = (target.subscribe as (input: unknown) => AsyncIterable<unknown>)(input)
          return (async function* () {
            try {
              yield* inner
            } finally {
              entry.ended = true
            }
          })()
        }
      },
    })
    return { ...ctx, session, event } as Plugin.Context
  }
  return { hooks, streams, wrap }
}

/** The TUI part, set up on the host's own client: the commands it adds, and what its dialogs show. */
function tuiOn(host: Host) {
  const commands: Array<{ readonly id: string; readonly run?: () => unknown }> = []
  const alerts: string[] = []
  const context = {
    location: host.location,
    client: host.client,
    data: { on: () => () => {} },
    ui: {
      dialog: {
        alert: async (input: { message: string }) => void alerts.push(input.message),
        confirm: async () => false,
        set: () => {},
        clear: () => {},
      },
      router: { current: () => ({ type: "home" }) },
    },
    keymap: { layer: (layer: () => { commands: typeof commands }) => void commands.push(...layer().commands) },
  }
  const stop = (tui as unknown as { setup: (context: unknown) => (() => void) | undefined }).setup(context)
  return { commands, alerts, stop }
}

describe(`the plugin wired end to end on @opencode/sdk ${HOST_VERSION}`, () => {
  test("status and the TUI's cleanup view read E's real cost; the hooks register once and stop with the plugin", async () => {
    const seen = registrations()
    const host = await startHost({ wrap: seen.wrap })
    let closed = false
    try {
      // An owner's usage: today's machine cost and the organisation's rates come from `manage usage`.
      host.boxd.fake.update((state) => {
        state.usage = { currency: "EUR", complete: true, rates: { vcpu_hour_micro: 47_000, ram_gib_hour_micro: 14_000, disk_gib_hour_micro: 96 }, machines: [{ id: "vm_0000", cost_micro: 1_250_000 }] }
      })
      const sessionID = await session(host)
      const made = await attempt(host, sessionID, "build", "boxd_ensure", "once", { workId: "wired" })
      expect(made.output).toMatchObject({ state: "ready", workId: "wired" })

      // boxd_status: the cost block is E's, from the watcher's snapshot (the running work) and boxd's usage.
      const status = await until("status counts the running work in its cost", async () => {
        const answer = await attempt(host, sessionID, "build", "boxd_status", "once", { include: ["cost"] })
        const cost = answer.output?.cost as { perHour?: { running?: number } } | undefined
        return (cost?.perHour?.running ?? 0) >= 1 ? answer.output : undefined
      })
      expect(status.cost).toMatchObject({ currency: "EUR", perHour: { running: 1, ratesSource: "usage" }, today: { machines: 1.25, complete: true } })
      const perHour = (status.cost as { perHour: { estimate: number } }).perHour.estimate
      expect(perHour).toBeGreaterThan(0)
      expect((status.cost as { works?: Array<{ workId: string }> }).works?.map((work) => work.workId)).toEqual(["wired"])

      // The cleanup view on the host's RPC, as the TUI asks for it: the same estimate, and the running work.
      const rpc = host.client.rpc as unknown as (definition: typeof CleanupViewRpc) => { view: (input: object, options: object) => Promise<CleanupView> }
      const view = await rpc(CleanupViewRpc).view({}, { location: host.location })
      expect(view).toMatchObject({ state: "ok", currency: "EUR", perHour, confirm: "cleanup-action", command: "/boxd-cleanup" })
      expect(view.works.map((work) => work.workId)).toEqual(["wired"])

      // The TUI's own cleanup command renders that view.
      const ui = tuiOn(host)
      const command = ui.commands.find((entry) => entry.id.endsWith(".cleanup"))
      expect(command).toBeDefined()
      await command!.run!()
      const shown = await until("the TUI shows the cleanup view", async () => ui.alerts[0])
      expect(shown.startsWith(cleanupText(view))).toBe(true)
      expect(shown).toContain("- wired: ")
      ui.stop?.()

      // Registered once each, however many calls ran.
      expect(seen.hooks.map((hook) => hook.name).sort()).toEqual([...COST_HOOKS].sort())
      expect(seen.streams.map((stream) => stream.types)).toEqual([[...SESSION_GONE_EVENTS]])
      expect(seen.hooks.every((hook) => hook.disposed === 0)).toBe(true)
      expect(seen.streams.every((stream) => !stream.ended)).toBe(true)

      await host.close()
      closed = true
      // The host disposed the plugin: every hook stopped once, and the event stream ended.
      expect(seen.hooks.map((hook) => [hook.name, hook.disposed])).toEqual(seen.hooks.map((hook) => [hook.name, 1]))
      expect(seen.streams.every((stream) => stream.ended)).toBe(true)
    } finally {
      if (!closed) await host.close()
    }
  })
})
