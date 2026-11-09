import { Plugin } from "@opencode/plugin/tui"
import { shortReason } from "./redact.js"
import { createSignal } from "solid-js"
import { COMMAND_STEM, DISPLAY_NAME, errorText, PLUGIN_ID } from "./constants.js"
import { formatStatus, StatusRpc, type Status } from "./status.js"

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
  readonly client: Pick<Context["client"], "rpc">
  readonly data: Pick<Context["data"], "on">
  readonly ui: { readonly dialog: Pick<Context["ui"]["dialog"], "alert" | "set" | "clear"> }
  readonly keymap: Pick<Context["keymap"], "layer">
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
