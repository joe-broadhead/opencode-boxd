export const PLUGIN_ID = "boxd.machines"
/** The command stem: `/boxd` is the dialog and `/boxd-status` the report. */
export const COMMAND_STEM = "boxd"
/** The vendor's display name, as boxd writes it. */
export const DISPLAY_NAME = "boxd"
/** The tool namespace: every tool is `boxd_<name>`. */
export const NAMESPACE = "boxd"
/** The OpenCode versions the plugin starts on. Equals `opencode.host` in package.json. */
export const SUPPORTED_HOST = ">=2.2.3 <2.3.0"
/** The OpenCode releases every check runs on: the one list. Status calls only these "tested". */
export const TESTED_HOSTS: readonly string[] = ["2.2.3", "2.2.4", "2.2.5", "2.2.6"]
/** What Code Mode's catalog says about the `boxd` namespace. */
export const NAMESPACE_DESCRIPTION =
  "Run an OpenCode session on a private boxd machine and keep the transcript on this laptop. The laptop is the source of truth; a boxd snapshot is an image, not a session. Read the boxd skill before the first call. Every machine change asks first: ensure, submit, resume, sleep, image and drop all create, run or destroy something that costs money. Never pass --shared or --isolated, never publish the guest port, and never wait inside a tool call: submit admits a prompt and returns, and job answers once. Harvest before sleep, image or drop, and drop only the machine the ledger records for that work id."

/** The one error shape: `CODE: What happened. Next step: What to do.` Both parts are sentences. */
export const errorText = (code: string, message: string, nextStep: string) => `${code}: ${message} Next step: ${nextStep}`
