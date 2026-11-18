export const PLUGIN_ID = "boxd.machines"
/** The command stem: `/boxd` is the dialog and `/boxd-status` the report. */
export const COMMAND_STEM = "boxd"
/** The vendor's display name, as boxd writes it. */
export const DISPLAY_NAME = "boxd"
/** The tool namespace: every tool is `boxd_<name>`. */
export const NAMESPACE = "boxd"
/** The OpenCode versions the plugin starts on. Equals `opencode.host` in package.json. */
export const SUPPORTED_HOST = ">=2.2.3 <2.4.0"
/** The OpenCode releases every check runs on: the one list. Status calls only these "tested". */
export const TESTED_HOSTS: readonly string[] = ["2.2.3", "2.2.4", "2.2.5", "2.2.6", "2.2.7", "2.3.0", "2.3.1", "2.3.2"]

/** The one error shape: `CODE: What happened. Next step: What to do.` Both parts are sentences. */
export const errorText = (code: string, message: string, nextStep: string) => `${code}: ${message} Next step: ${nextStep}`
