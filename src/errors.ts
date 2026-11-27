import { errorText, SUPPORTED_HOST } from "./constants.js"

/**
 * The `state` a refusal or failure carries beside its code, so every answer has one and a coordinator reads one shape
 * (design §3): `refused` for a call the plugin would not make, `failed` for something that ran and failed, and the
 * phase-like states for a work that cannot take the call now.
 */
export type ErrorState = "refused" | "failed" | "unreachable" | "busy" | "starting" | "gone" | "asleep" | "cancelled"

interface CodeSpec {
  /** The state a tool result carries with this code; null for the codes that are never a tool's answer. */
  readonly state: ErrorState | null
  /** What happened, as the default sentence; a throw site may say it more exactly. */
  readonly message: string
  /** The one next step: a concrete call with its arguments wherever there is one. */
  readonly next: string
}

const SECRET_WAYS =
  "a sealed, host-bound boxd env secret (boxd env set <KEY> <value> --secret --domains <provider hosts>), a separately named secret per provider, or opencode auth login on one work's own machine after boxd connect"

/**
 * Every code this plugin raises (design §5), with its state, its default sentence and its one next step. A code is
 * raised through `boxdError`, so a throw site cannot invent a different next step, and the README's Troubleshooting
 * rows and `docs/configuration.md` are checked against this table.
 */
export const CODES = {
  // Shared with every plugin of the family.
  HOST_UNTESTED: {
    state: null,
    message: "This OpenCode version is outside the supported range.",
    next: `Use OpenCode ${SUPPORTED_HOST}, or set the plugin option "allowUntestedHost": true to run anyway.`,
  },
  OPTIONS_INVALID: { state: null, message: "The plugin options are not valid.", next: "Fix the plugin options in opencode.json, then restart OpenCode." },
  STATUS_UNAVAILABLE: { state: null, message: "boxd's status could not be read.", next: "Restart OpenCode, then run /boxd-status again." },
  SKILLS_INVALID: { state: null, message: "The plugin's skill file is missing or invalid.", next: "Reinstall the plugin so its skill file is present, then restart OpenCode." },

  // Input.
  NAME_INVALID: { state: "refused", message: "An input failed its rule; field names it.", next: "Fix the field the message names, as its reason says, then call again." },
  PATH_REFUSED: {
    state: "refused",
    message: "A path here is outside the project and allowedRoots, or is a symlink.",
    next: 'Pass a path inside the project, or add its root to the plugin option "allowedRoots" and allow it with the external_directory rule.',
  },
  FILE_TOO_LARGE: { state: "refused", message: "A file is over 8 MiB, or the call is over 32 MiB.", next: "Move a smaller file, or split it: the limit is 8 MiB a file and 32 MiB a call." },
  FILE_CONFLICT: {
    state: "refused",
    message: "The file changed here since the last harvest.",
    next: "Keep the local edit and leave that path out, or restore the harvested copy and harvest again.",
  },

  // Which machine.
  NOT_OURS: {
    state: "refused",
    message:
      "No open work has this id; or oc-<id> now has another id than the recorded machineId; or the recorded machine lives under another name; or two regions hold oc-<id>; or the machine to adopt is one another open work records (even with adopt: true). Nothing was changed.",
    next: "For an unknown id, boxd_ensure({ workId }). Otherwise look at the machines the message names with boxd machine get, and rename them back or boxd_reassign.",
  },
  NOT_REASSIGNABLE: {
    state: "refused",
    message: "from has a session, uploaded files or a dirty tree, or to is an open work.",
    next: "boxd_drop it after a harvest, or reassign a work with no prompt yet.",
  },
  MACHINE_LIMIT: {
    state: "refused",
    message: "No allowed region has room for another machine; limit, inUse and free are given per region.",
    next: 'Pass region: "<other region>" when it has room; otherwise free machines with boxd_drop or boxd_reassign, or have the owner raise the limit with boxd manage machine-limit request --max-vms <n>.',
  },
  REGION_NOT_ALLOWED: {
    state: "refused",
    message: "A new machine or golden image would be placed in a region the plugin option \"regions\" does not allow.",
    next: 'Pass region: "<an allowed region>" ("fra" or "nyc" by default; the message lists the ones this project allows, and /boxd-status shows them), or add this region to "regions" and restart OpenCode.',
  },
  SIZE_UNAVAILABLE: { state: "refused", message: "The organisation's quota does not allow this size.", next: "Pick a smaller size." },

  // Golden images.
  GOLDEN_MISSING: {
    state: "refused",
    message: 'No golden image for this region, size and OpenCode version, and the option buildGolden is "never".',
    next: "boxd_golden({ region, size }), then call again.",
  },
  GOLDEN_BUILD_FAILED: {
    state: "failed",
    message: "A golden image build failed at the step the message names, or its base holds an OpenCode session.",
    next: "Read the message; fix goldenSetup or the base, then boxd_golden again.",
  },
  GOLDEN_HAS_CREDENTIAL: {
    state: "refused",
    message:
      "The base holds ~/.local/share/opencode/auth.json. Model credentials are never baked into an image, because an image reaches every work and everyone in the organisation who can boot it.",
    next: `Remove auth.json from the base, or build from stock, and give works a model key another way: ${SECRET_WAYS}. Then boxd_golden again.`,
  },

  // The machine.
  MACHINE_SHARED: { state: "refused", message: "The machine is shared, which deletes the guest's sign-in.", next: "Unshare it with boxd machine unshare, or boxd_drop it and boxd_ensure again." },
  MACHINE_ISOLATED: { state: "refused", message: "The machine is isolated: no git integration and no in-VM CLI.", next: "boxd_drop it, then boxd_ensure again." },
  MACHINE_STARTING: { state: "starting", message: "The machine is still starting after this call's wait.", next: "The same call again; it waits." },
  MACHINE_GONE: {
    state: "gone",
    message: "A fresh all-region listing and a get of the recorded machine id found the machine nowhere.",
    next: "boxd_resume({ workId }) to rebuild it, or boxd_drop({ workId }) to close the work.",
  },
  MACHINE_ASLEEP: {
    state: "asleep",
    message: "The machine is hibernated, and this call does not wake it.",
    next: "boxd_resume({ workId }), or pass wake: true to boxd_exec.",
  },
  AGENT_UNREACHABLE: {
    state: "unreachable",
    message: "boxd's VM agent on the machine does not answer, and the plugin has not rebooted this machine itself.",
    next: 'boxd_ensure({ workId, repair: "reboot" }); a reboot ends a running run.',
  },

  // The session.
  SESSION_BUSY: {
    state: "busy",
    message: "The session is running, and this call needs it idle.",
    next: 'Wait for the work\'s notice, or pass mode: "interrupt" to boxd_submit, or partial: true to boxd_harvest.',
  },
  SESSION_MISSING: { state: "failed", message: "The guest no longer has the work's session.", next: "boxd_resume({ workId }), which imports the saved transcript." },
  RUN_FAILED: { state: "failed", message: "The last run failed; error is its one line.", next: "Read lastText with boxd_job, then boxd_submit again." },
  RUN_INTERRUPTED: { state: "failed", message: "The guest's OpenCode stopped mid-run.", next: "boxd_harvest({ workId }), then boxd_submit again." },

  // The guest.
  GUEST_AUTH_FAILED: {
    state: "failed",
    message: "The model provider or a pushed host refused the credential, or the guest has none.",
    next: `Set or rotate the credential (${SECRET_WAYS}), then boxd_submit again. A session never starts an interactive sign-in itself.`,
  },
  ACTS_AS_OPERATOR: {
    state: "refused",
    message: "The work would act as its operator: its machine holds a real GitHub, model or cloud credential, or git is given a real GitHub login, instead of a placeholder bound to one host.",
    next: "Give the work its identity as a sealed, host-bound boxd env secret (boxd env set <KEY> <value> --secret --domains <hosts>), and remove the operator's: boxd manage integrations disconnect git, and unset any real token or key on the machine. Then call again.",
  },
  GUEST_VERSION: {
    state: "refused",
    message: "The guest's OpenCode differs from the OpenCode here, and this call moves a transcript.",
    next: "boxd_ensure({ workId }) upgrades it in place once the session is idle.",
  },
  GUEST_UNRESPONSIVE: {
    state: "unreachable",
    message: "The guest is short of memory or overloaded; the facts are in the message.",
    next: "Tell the user which processes the message names, or stop them with boxd_exec.",
  },
  GUEST_SERVER_DOWN: { state: "unreachable", message: "Nothing listens on the guest's OpenCode port.", next: "boxd_ensure({ workId }) starts it." },
  GUEST_FAILED: {
    state: "unreachable",
    message: "The guest helper failed; its words are in the message.",
    next: 'boxd_ensure({ workId }); if it repeats, boxd_read({ workId, log: "server" }).',
  },
  GUEST_WORKSPACE: {
    state: "failed",
    message: "The guest folder could not be made or cloned.",
    next: "Read the message (clone auth, disk), fix it, then boxd_ensure({ workId }).",
  },

  // Drop's guard.
  NOT_SAVED: {
    state: "refused",
    message: "The work is not saved: no fresh harvest since the last prompt, or the guest's sessions moved on since the harvest.",
    next: "boxd_harvest({ workId }), then drop again.",
  },
  UNTRACKED: {
    state: "refused",
    message: "Untracked or ignored paths were not harvested; paths, count and kind name them.",
    next: "Harvest them with files, or delete them on the machine, then boxd_harvest again.",
  },
  UNPUSHED: {
    state: "refused",
    message: "A local branch, tag, stash or detached HEAD has commits that no remote ref contains; count and commits name them.",
    next: 'Push every local branch and tag from the machine with boxd_exec({ workId, command: ["sh", "-c", "git push --all origin && git push --tags origin"] }); push a detached HEAD by name. Then drop again.',
  },
  UNPUSHED_UNKNOWN: {
    state: "refused",
    message: "The guest could not tell whether every commit is on a remote ref, so dropping would risk losing one.",
    next: 'Run the check with boxd_exec({ workId, command: ["git", "rev-list", "--count", "--all", "HEAD", "--not", "--remotes"] }); push whatever it counts, then drop again.',
  },
  DIRTY: { state: "refused", message: "The guest has uncommitted work and no stored patch.", next: "boxd_harvest({ workId }), then drop again." },
  GIT_UNKNOWN: { state: "refused", message: "The guest folder is not a git repository.", next: "Make it one, or boxd_sleep({ workId }) instead." },

  // Moving transcripts.
  EXPORT_INVALID: {
    state: "failed",
    message: "A transcript failed its checks: shape, digest, a cycle or a missing parent.",
    next: "boxd_harvest({ workId }) again from an idle session.",
  },
  IMPORT_FAILED: {
    state: "failed",
    message: "The OpenCode here could not import the session; the export is kept.",
    next: "boxd_harvest({ workId }) again; the stored file is retried.",
  },

  // boxd and the runner.
  BOXD_FAILED: {
    state: "unreachable",
    message: "The boxd CLI failed in a way the plugin does not know; its words are in the message, redacted.",
    next: "Read the message, and run boxd_status before trying again.",
  },
  BOXD_MISSING: {
    state: "unreachable",
    message: "No boxd CLI on the host's PATH: it is missing, not signed in, or the in-VM CLI.",
    next: "Install the host boxd CLI on the server's PATH and run boxd auth login, in that server's HOME.",
  },
  TIMEOUT: { state: "unreachable", message: "A step did not answer in its bound; the message names the step.", next: "The same call in a later turn." },
  CANCELLED: {
    state: "cancelled",
    message: "The call was stopped; uncertain is true when a write was in flight.",
    next: "Read the work with boxd_job({ workId }) before acting again.",
  },
  CREATE_UNCERTAIN: {
    state: "unreachable",
    message: "A create timed out, and no machine was found yet.",
    next: "boxd_ensure({ workId }) again: it adopts the machine if one landed.",
  },

  // The ledger.
  LEDGER_FAILED: { state: "failed", message: "The ledger could not be read or written.", next: "Check that the ledger folder is writable, then restart OpenCode." },
  LEDGER_LOCKED: { state: "busy", message: "Another OpenCode process holds this work's lock.", next: "The same call again in a few seconds." },

  // Cost (design §C.5).
  BUDGET_REACHED: {
    state: "refused",
    message:
      "Today's machine cost has reached the budget's daily limit, and budget.action is refuse; today, daily and currency are in the result. A call that would make a machine run is refused.",
    next: 'Lower the cost first: boxd_sleep({ select: "idle" }), then boxd_drop({ select: "saved-finished" }); or raise budget.daily. It resets at local midnight.',
  },

  // Setup.
  RULES_NOT_ADDED: {
    state: null,
    message: "boxd's default permission rules did not load.",
    next: "Restart OpenCode, then run /boxd-status; a machine change may run without asking until the rules load.",
  },
} as const satisfies Record<string, CodeSpec>

export type Code = keyof typeof CODES

/**
 * Warnings (design §5): in a record's `warnings`, in `attention` and in status, beside a state that succeeded, never a
 * refusal. Each has its own next step.
 */
export const WARNINGS = {
  /** A work was slept before its last prompt was saved. */
  UNHARVESTED_SLEEP: {
    message: "The machine was hibernated before its last prompt was harvested.",
    next: "boxd_resume({ workId }), then boxd_harvest({ workId }).",
  },
  /** The budget is reached with `action: "warn"` (§C.5). */
  BUDGET_WARN: {
    message: "Today's machine cost has reached the budget's daily limit.",
    next: 'Lower the cost: boxd_sleep({ select: "idle" }), then boxd_drop({ select: "saved-finished" }); or raise budget.daily.',
  },
  /** Usage cannot be read with this sign-in, so the budget is not measured and `refuse` acts as `warn` (§C.5). */
  BUDGET_UNKNOWN: {
    message: "boxd's machine usage is for organisation owners and admins, so this sign-in cannot measure the budget; refuse acts as warn.",
    next: "Sign the boxd CLI in as an owner or admin to measure the budget, or remove the budget option.",
  },
  /** A `leaseDays` timer ends within 24 hours; what is unsaved is named (§C.2). */
  LEASE_EXPIRING: {
    message: "The work's delete-after lease ends within 24 hours, and boxd deletes the machine whatever it holds.",
    next: "boxd_harvest({ workId }) now; any change call for the work renews the lease.",
  },
  /** Auto-harvest or auto-sleep failed; the step and its code are named (§C.3). */
  AUTOMATION_BLOCKED: {
    message: "The plugin's automatic harvest or sleep of this work failed at the step the message names.",
    next: "Read the code the message names, fix it, then boxd_harvest({ workId }) and boxd_sleep({ workId }).",
  },
  /** A golden build found no provider key among the account's secrets (§2.3). */
  NO_MODEL_CREDENTIAL: {
    message: "No secret that OpenCode reads as a model provider key is set, so a work's first prompt will answer GUEST_AUTH_FAILED.",
    next: `Give works a model key: ${SECRET_WAYS}.`,
  },
} as const satisfies Record<string, Omit<CodeSpec, "state">>

export type WarningCode = keyof typeof WARNINGS

/** Facts a program can read beside the sentence, such as the paths a drop refused for. Plain JSON values only. */
export type ErrorDetails = Readonly<Record<string, unknown>>

/** One plugin error: the code, what happened, the code's next step, and any facts a program needs. */
export class BoxdError extends Error {
  readonly code: Code
  /** What happened, the sentence between the code and the next step. */
  readonly what: string
  readonly next: string
  readonly state: ErrorState | null
  readonly details: ErrorDetails

  constructor(code: Code, message: string = CODES[code].message, details: ErrorDetails = {}) {
    super(errorText(code, message, CODES[code].next))
    this.name = "BoxdError"
    this.code = code
    this.what = message
    this.next = CODES[code].next
    this.state = CODES[code].state
    this.details = details
  }
}

/** A coded error with the table's next step for its code; the table's sentence when no message is given. */
export const boxdError = (code: Code, message?: string, details?: ErrorDetails) => new BoxdError(code, message, details)

/** The state a code's result carries; a code that is never a tool's answer reads as `failed`. */
export const errorState = (code: Code): ErrorState => CODES[code].state ?? "failed"

/** True for a string that is a code in the one table: only these reach a notice (design §3.13, L-f). */
export const isCode = (value: unknown): value is Code => typeof value === "string" && Object.hasOwn(CODES, value)

/**
 * Runs a check on one input and names that input in its refusal: `localDirectory: "…" does not exist.` A refusal of
 * another kind passes through unchanged.
 */
export async function inField<T>(field: string, check: () => Promise<T> | T): Promise<T> {
  try {
    return await check()
  } catch (error) {
    if (error instanceof BoxdError && (error.code === "NAME_INVALID" || error.code === "PATH_REFUSED")) {
      throw new BoxdError(error.code, `${field}: ${error.what}`, { ...error.details, field })
    }
    throw error
  }
}
