import { errorText, SUPPORTED_HOST } from "./constants.js"

/**
 * Every code this plugin raises, with its one next step. A code is raised through `boxdError`, so a throw site cannot
 * invent a different sentence, and the README's Troubleshooting rows and `docs/configuration.md` are checked against
 * this table.
 */
export const CODES = {
  HOST_UNTESTED: `Use OpenCode ${SUPPORTED_HOST}, or set the plugin option "allowUntestedHost": true to run anyway.`,
  OPTIONS_INVALID: `Fix the plugin options in opencode.json, then restart OpenCode.`,
  STATUS_UNAVAILABLE: "Restart OpenCode, then run /boxd-status again.",
  SKILLS_INVALID: "Reinstall the plugin so its skill file is present, then restart OpenCode.",
  NAME_INVALID: `Use a short lowercase work id, an absolute guest path with no "..", and a lowercase snapshot name.`,
  NOT_OURS: "Call boxd_ensure for this work id, and act only on the machine the ledger records for it.",
  MACHINE_GONE: "Call boxd_resume to wake it, or to rebuild it from the golden snapshot and the proven transcript.",
  MACHINE_STARTING: "Call boxd_status in a later turn. Do not wait inside a call.",
  MACHINE_SHARED: "Recreate the machine without --shared: sharing deletes the guest's OpenCode sign-in.",
  MACHINE_ISOLATED: "Recreate the machine without --isolated, which drops git and the in-VM boxd CLI.",
  SESSION_BUSY: "Call boxd_job until it reports idle, then harvest.",
  GUEST_VERSION: "Boot the machine from an image whose OpenCode is the same version as this laptop's.",
  GUEST_RUN_FAILED: "Read the transcript, then boxd_submit again.",
  RUN_INTERRUPTED: "Call boxd_harvest to keep what exists, then boxd_submit again.",
  GUEST_AUTH_FAILED: "Fix the guest's model credentials (docs/golden-image.md), then boxd_submit again.",
  GUEST_FAILED: "Call boxd_status, and recreate the machine with boxd_resume if the guest keeps failing.",
  BOXD_FAILED: "Read the boxd CLI's own message, and run boxd_status before trying again.",
  BOXD_MISSING: "Put the boxd CLI on the server's PATH and sign it in, in that server's HOME (its config is at ~/.config/boxd on Linux, or ~/Library/Application Support/boxd on macOS); an isolated or service instance needs its own HOME with both setups.",
  TIMEOUT: "Call boxd_status in a later turn instead. Do not retry inside the same call.",
  NOT_PROVEN: "Call boxd_harvest before sleeping, imaging or dropping this work.",
  DIRTY: "Call boxd_harvest, which stores the uncommitted diff with the export, before dropping.",
  EXPORT_INVALID: "Call boxd_harvest again from an idle session. Do not invent a transcript.",
  PARENT_MISSING: "Harvest the whole session tree again, parents first, then move it.",
  SNAPSHOT_EXISTS: "Pick a new snapshot name: snapshots are immutable.",
  SNAPSHOT_MISSING: "Create the golden image described in docs/golden-image.md, then set the snapshot option to its name.",
  LEDGER_FAILED: "Check that the ledger folder is writable, then restart OpenCode.",
  RULES_NOT_ADDED: "Restart OpenCode, then run /boxd-status; a machine change may run without asking until the rules load.",
  UNTRACKED: "Commit or delete the paths the message names on the machine, harvest again, then drop. Or hibernate, which keeps the disk.",
  GIT_UNKNOWN: "Commit the work in a git repository on the machine, harvest again, then drop. Or hibernate, which keeps the disk.",
  CREATE_UNCERTAIN: "Run boxd_status: if the machine appears there, call boxd_ensure to adopt it; if not, ensure again.",
  PATH_REFUSED: `Pass a path inside the project, or name its root in the plugin option "allowedRoots", and allow it with the external_directory rule.`,
  FILE_TOO_LARGE: "Move a smaller file, or split it: the per-file limit is 8 MiB and the total is 32 MiB.",
  FILE_CONFLICT: "Keep the local edit and drop that path from the harvest, or restore the harvested copy and harvest again.",
  GUEST_WORKSPACE: "Hibernate the machine, then boot an image whose /home/boxd is writable by the boxd user, and call boxd_ensure again.",
} as const

export type Code = keyof typeof CODES

/** One plugin error: the code, what happened, and the code's next step. */
export class BoxdError extends Error {
  readonly code: Code
  /** What happened, the sentence between the code and the next step. */
  readonly what: string
  readonly next: string

  constructor(code: Code, message: string) {
    super(errorText(code, message, CODES[code]))
    this.name = "BoxdError"
    this.code = code
    this.what = message
    this.next = CODES[code]
  }
}

/** A coded error with the table's next step for its code. */
export const boxdError = (code: Code, message: string) => new BoxdError(code, message)
