/** The plugin's one name (contract §3): its id, namespace, RPC id, tool prefix and bus event prefix. */
export const PLUGIN_ID = "boxd"
/** The command a person runs for the status report. */
export const COMMAND_STEM = "boxd"
/** The vendor's display name, as boxd writes it. */
export const DISPLAY_NAME = "boxd"
/** The OpenCode versions the plugin starts on. Equals `capabilities.plugin.host.opencode` in package.json. */
export const SUPPORTED_HOST = ">=2.4.1 <2.5.0"
/** The OpenCode releases every check runs on: the one list. Status calls only these "tested". */
export const TESTED_HOSTS: readonly string[] = ["2.4.1"]

/** The one error shape: `CODE: What happened. Next step: What to do.` Both parts are sentences. */
export const errorText = (code: string, message: string, nextStep: string) => `${code}: ${message} Next step: ${nextStep}`
