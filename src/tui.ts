import { Plugin } from "@opencode/plugin/tui"
import { shortReason } from "./redact.js"
import { createSignal } from "solid-js"
import { COMMAND_STEM, DISPLAY_NAME, errorText, PLUGIN_ID } from "./constants.js"
import { formatStatus, StatusRpc, type Status } from "./status.js"
import { CLEANUP_COMMAND, CleanupViewRpc, type CleanupView } from "./services.js"

const TITLE = `${DISPLAY_NAME} status`
const KEYS = "r refresh · esc close"

type Context = Plugin.Context

/** The view's text: the /boxd-status report without its heading, which the dialog title carries, and the keys. */
function viewMessage(result: { readonly status: Status } | { readonly error: unknown }) {
  return `${reportOf(result)}\n\n${KEYS}`
}

function reportOf(result: { readonly status: Status } | { readonly error: unknown }) {
  if ("status" in result) return formatStatus(result.status).split("\n").slice(1).join("\n")
  const { error } = result
  const type = typeof error === "object" && error !== null && "type" in error ? error.type : undefined
  // The server part could not read the status; it says why and what to do.
  if (type === "unavailable") {
    const { message, data } = error as { message?: unknown; data?: { nextStep?: unknown } }
    if (typeof message === "string" && typeof data?.nextStep === "string") return `${message} Next step: ${data.nextStep}`
  }
  // No server part answers: the plugin did not start there, and the host's plugin list says why.
  if (type === "rpc.unavailable" || type === "rpc.method_not_found") {
    return errorText("STATUS_UNAVAILABLE", "The boxd plugin is not running on this OpenCode server.", "Run /plugins to see why it did not start.")
  }
  const reason = shortReason(typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error))
  return errorText("STATUS_UNAVAILABLE", `Could not read boxd's status${reason ? ` (${reason})` : ""}.`, "Restart OpenCode, then run /boxd again.")
}

/** The members of the TUI context the view uses. */
interface ViewContext {
  readonly location: Context["location"]
  readonly client: Pick<Context["client"], "rpc"> & { readonly session: Pick<Context["client"]["session"], "command"> }
  readonly data: Pick<Context["data"], "on">
  readonly ui: { readonly dialog: Pick<Context["ui"]["dialog"], "alert" | "confirm" | "set" | "clear">; readonly router: Pick<Context["ui"]["router"], "current"> }
  readonly keymap: Pick<Context["keymap"], "layer">
}

const CLEANUP_TITLE = `${DISPLAY_NAME} cleanup`
const SYMBOLS: Readonly<Record<string, string>> = { EUR: "€", USD: "$", GBP: "£" }
const money = (amount: number | null, currency: string | null) =>
  amount === null ? "not estimated" : currency && SYMBOLS[currency] ? `${SYMBOLS[currency]}${amount.toFixed(2)}` : `${amount.toFixed(2)}${currency ? ` ${currency}` : ""}`

/**
 * Package E's cleanup view as text: what costs money now, each running work's cost, idle time and `saved`, and the
 * cleanup actions with their savings. Counts, costs, ids and phases only: it approves nothing. Package D renders it.
 */
export function cleanupText(view: CleanupView): string {
  if (view.state === "unavailable") return `The cleanup view is not available${view.note ? `: ${shortReason(view.note) ?? ""}` : ""}.`
  const works = view.works.length
    ? view.works
        .slice(0, 20)
        .map((work) => `- ${work.workId}: ${work.phase}, ${work.saved === "fresh" ? "saved" : "not saved"}, ${money(work.perHour, view.currency)}/h${work.idleMinutes !== null ? `, idle ${work.idleMinutes} min` : ""}`)
        .join("\n")
    : "- no running work"
  const more = view.works.length > 20 ? `\n- and ${view.works.length - 20} more` : ""
  const actions = view.actions.length
    ? view.actions
        .map((action) => {
          const saves = action.savesPerHour !== undefined ? `, saves ~${money(action.savesPerHour, view.currency)}/h` : action.savesPerDay !== undefined ? `, saves ~${money(action.savesPerDay, view.currency)}/day` : ""
          return `- ${action.action} ${action.works} ${action.works === 1 ? "work" : "works"} (${action.select})${saves}`
        })
        .join("\n")
    : "- nothing to clean up"
  const confirm =
    view.confirm === "report-only"
      ? "Access is read-only: /boxd-cleanup only reports."
      : `/${view.command.replace(/^\//, "")} asks you to confirm each action with a permission prompt.`
  return [`Running now: ~${money(view.perHour, view.currency)}/h (an estimate); automation: ${view.automation}`, works + more, "", "Cleanup actions:", actions, "", confirm].join("\n")
}

function setupView(context: ViewContext) {
  let open: number | undefined
  let latest = 0
  /** The event listeners, held only while the view is open. */
  let stops: (() => void)[] = []
  const unsubscribe = () => {
    for (const stop of stops.splice(0)) stop()
  }
  const subscribe = () => {
    if (stops.length) return
    stops = [
      // The ledger and the agents change from outside the dialog: a harvest, a rule edit, a plugin rebuild.
      context.data.on("server.connected", refresh),
      context.data.on("agent.updated", refresh),
    ]
  }
  // The refresh key is live only while the view is open, so `r` never reaches it from anywhere else.
  const [shown, setShown] = createSignal(false)
  /** Opens the view; with `refresh`, redraws it only while it is open. A new dialog replaces the shown one. */
  const show = async (refresh: boolean) => {
    if (refresh && open === undefined) return
    const request = ++latest
    const location = context.location
    const result = await context.client
      .rpc(StatusRpc)
      .status({}, location ? { location } : {})
      // The host validates the output against the contract's schema before it answers.
      .then((status) => ({ status: status as Status }), (error: unknown) => ({ error }))
    // The newest request wins, and a refresh never reopens a view the user closed meanwhile.
    if (request !== latest || (refresh && open === undefined)) return
    open = request
    setShown(true)
    subscribe()
    // The alert closes on Esc; replacing it with a newer one closes it too.
    void context.ui.dialog.alert({ title: TITLE, message: viewMessage(result) }).then(() => {
      if (open !== request) return
      open = undefined
      setShown(false)
      unsubscribe()
    })
    // Showing resets the size; the rule list in the agent fix reads better wide.
    context.ui.dialog.set({ size: "large" })
  }
  const refresh = () => void show(true)

  /** The cleanup view: E's report, and in a session a button that runs `/boxd-cleanup`, whose prompts confirm each action. */
  const cleanup = async () => {
    const location = context.location
    const result = await context.client
      .rpc(CleanupViewRpc)
      .view({}, location ? { location } : {})
      .then((view) => ({ view: view as CleanupView }), (error: unknown) => ({ error }))
    if ("error" in result) {
      const reason = shortReason(typeof result.error === "object" && result.error !== null && "message" in result.error ? String(result.error.message) : String(result.error))
      void context.ui.dialog.alert({ title: CLEANUP_TITLE, message: errorText("STATUS_UNAVAILABLE", `Could not read boxd's cleanup view${reason ? ` (${reason})` : ""}.`, "Restart OpenCode, then try again.") })
      return
    }
    const message = cleanupText(result.view)
    const route = context.ui.router.current()
    const runnable = result.view.state === "ok" && result.view.confirm !== "report-only" && result.view.actions.length > 0
    if (!runnable || route.type !== "session") {
      void context.ui.dialog.alert({ title: CLEANUP_TITLE, message: runnable ? `${message}\nOpen a session to run /${CLEANUP_COMMAND}.` : message })
      return
    }
    const run = await context.ui.dialog.confirm({ title: CLEANUP_TITLE, message, label: { confirm: `Run /${CLEANUP_COMMAND}`, cancel: "Close" } })
    if (run) await context.client.session.command({ sessionID: route.sessionID, name: CLEANUP_COMMAND, text: "" })
  }

  // Called from setup itself, because keymap layers need the host's reactive owner. Global, because the palette and
  // slash completion list only the commands reachable from their own input mode.
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: `${PLUGIN_ID}.status`,
        title: `${DISPLAY_NAME}: Status`,
        description: "The ledger, the machines, the permission posture and the next step for boxd",
        group: DISPLAY_NAME,
        palette: true,
        slash: { name: COMMAND_STEM },
        run: () => show(false),
      },
      { id: `${PLUGIN_ID}.status.refresh`, title: `Refresh ${DISPLAY_NAME} status`, group: DISPLAY_NAME, bind: "r", enabled: shown, run: refresh },
      {
        id: `${PLUGIN_ID}.cleanup`,
        title: `${DISPLAY_NAME}: Cleanup`,
        description: "What boxd machines cost now, and the cleanup actions; each one asks you before it runs",
        group: DISPLAY_NAME,
        palette: true,
        run: () => void cleanup(),
      },
    ],
  }))
  return () => {
    unsubscribe()
    if (open === undefined) return
    open = undefined
    setShown(false)
    context.ui.dialog.clear()
  }
}

export default Plugin.define({ id: `${PLUGIN_ID}.tui`, setup: setupView })
