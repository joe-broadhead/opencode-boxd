// src/tui.ts
import { Plugin } from "@opencode/plugin/tui";

// src/redact.ts
var SECRETS = [
  [/\b(bearer|basic|token)\s+[\w.~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b([\w-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|signature|credential)["']?\s*[:=]\s*)["']?[^\s"'&,;]+["']?/gi, "$1[redacted]"],
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g, "[redacted]"],
  [/\b(?:tvly|sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abposr]|lin_api|lin_oauth)[-_][\w-]{8,}/gi, "[redacted]"],
  [/[\w+=-]{40,}/g, "[redacted]"]
];
var REASON_LIMIT = 160;
var CONTROLS = /[\u0000-\u001f\u007f-\u009f]+/g;
var BIDI = /[‎‏‪-‮⁦-⁩]/g;
var withoutUrlSecrets = (text2) => text2.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => url.replace(/^(https?:\/\/)[^/?#@]*@/i, "$1").replace(/[?#].*$/s, ""));
var oneLine = (text2) => text2.replace(BIDI, "").replace(CONTROLS, " ").replace(/\s+/g, " ").trim();
function cut(text2, limit) {
  const characters = Array.from(text2);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}\u2026` : text2;
}
function shortReason(text2) {
  const reason = oneLine(SECRETS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), withoutUrlSecrets(text2))).replace(/[.\s]+$/, "");
  if (reason === "") return void 0;
  return cut(reason, REASON_LIMIT);
}

// src/tui.ts
import { createSignal } from "solid-js";

// src/constants.ts
var PLUGIN_ID = "boxd.machines";
var COMMAND_STEM = "boxd";
var DISPLAY_NAME = "boxd";
var SUPPORTED_HOST = ">=2.2.3 <2.3.0";
var TESTED_HOSTS = ["2.2.3", "2.2.4", "2.2.5", "2.2.6"];
var errorText = (code, message, nextStep) => `${code}: ${message} Next step: ${nextStep}`;

// src/errors.ts
var CODES = {
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
  GUEST_WORKSPACE: "Hibernate the machine, then boot an image whose /home/boxd is writable by the boxd user, and call boxd_ensure again."
};
var BoxdError = class extends Error {
  code;
  next;
  constructor(code, message) {
    super(errorText(code, message, CODES[code]));
    this.name = "BoxdError";
    this.code = code;
    this.next = CODES[code];
  }
};
var boxdError = (code, message) => new BoxdError(code, message);

// src/host-version.ts
var RELEASE = /(?:^|v)(\d+)\.(\d+)\.(\d+)$/;
function parseVersion(version) {
  const match = RELEASE.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : void 0;
}
var [LOWEST, ABOVE] = SUPPORTED_HOST.split(" ").map((bound) => parseVersion(bound.replace(/^[<>]=?/, "")));
var compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
function isSupportedHost(version) {
  const parts = parseVersion(version);
  return parts !== void 0 && compare(parts, LOWEST) >= 0 && compare(parts, ABOVE) < 0;
}

// src/tools.ts
var object = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});
var WORK = { type: "string", description: 'A short lowercase work id, such as "review-api". The machine is named oc-<id>.' };
var DIRECTORY = {
  type: "string",
  description: "A laptop folder for the work, inside the project or an allowed root. The guest always works in /home/boxd/work/<work id>."
};
var REPO = { type: "string", description: "An https://github.com/owner/repo URL to clone on the machine, if the directory is not a checkout already." };
var TITLE = { type: "string", description: "The guest session's title; the work id by default." };
var LOCAL = {
  type: "string",
  description: "The laptop folder that receives the transcript and the harvested files; the work's own folder by default. It must be inside the project or an allowed root."
};
var FILES_IN = {
  type: "array",
  description: "Files to copy to the machine before the prompt, from a laptop path to a path inside the work tree. 8 MiB each, 32 MiB together.",
  items: {
    type: "object",
    required: ["from", "to"],
    properties: {
      from: { type: "string", description: "A laptop file inside the project or an allowed root; no symlinks." },
      to: { type: "string", description: 'A path inside the work tree, such as "data/bookmarks.json".' }
    },
    additionalProperties: false
  }
};
var FILES_OUT = {
  type: "array",
  description: "Paths inside the work tree to copy back after the transcript import, such as SUMMARY.md. 8 MiB each, 32 MiB together.",
  items: { type: "string" }
};
var TEXT = { type: "string", description: "The prompt to admit on the guest OpenCode." };
var MACHINE = { type: "string", description: "The machine name, oc-<work id>, owned by an open work." };
var SNAPSHOT = { type: "string", description: "A new lowercase snapshot name. Snapshots are immutable." };
var text = (input, key, field) => {
  const value = input[key];
  if (typeof value !== "string" || value === "") throw boxdError("NAME_INVALID", `${field} must be a non-empty string.`);
  return value;
};
var optional = (input, key) => {
  const value = input[key];
  return typeof value === "string" && value ? value : void 0;
};
var TOOLS = [
  {
    name: "status",
    id: "boxd_status",
    class: "read",
    description: "Read the ledger and each open work's machine state. Starts, wakes and runs nothing.",
    input: object({}, []),
    run: (fleet) => fleet.status()
  },
  {
    name: "job",
    id: "boxd_job",
    class: "read",
    description: "Read whether the guest session is busy or idle, once. It does not wait, and it never wakes a hibernated machine.",
    input: object({ workId: WORK }, ["workId"]),
    run: (fleet, input) => fleet.job({ workId: text(input, "workId", "workId") })
  },
  {
    name: "ensure",
    id: "boxd_ensure",
    class: "write",
    description: "Get a private machine from the golden snapshot for a work id, and record the work. The guest works in /home/boxd/work/<work id>. Returns starting when it is not up yet. It does not wait.",
    input: object({ workId: WORK, directory: DIRECTORY, repo: REPO, title: TITLE }, ["workId"]),
    run: (fleet, input) => fleet.ensure({
      workId: text(input, "workId", "workId"),
      ...optional(input, "directory") ? { directory: optional(input, "directory") } : {},
      ...optional(input, "repo") ? { repo: optional(input, "repo") } : {},
      ...optional(input, "title") ? { title: optional(input, "title") } : {}
    })
  },
  {
    name: "submit",
    id: "boxd_submit",
    class: "write",
    description: "Admit a prompt on the guest OpenCode, after copying any files it needs to the machine. Returns when the prompt is admitted, not when the model finishes.",
    input: object({ workId: WORK, text: TEXT, title: TITLE, files: FILES_IN }, ["workId", "text"]),
    run: (fleet, input) => fleet.submit({
      workId: text(input, "workId", "workId"),
      text: text(input, "text", "text"),
      ...optional(input, "title") ? { title: optional(input, "title") } : {},
      ...input.files ? { files: input.files } : {}
    })
  },
  {
    name: "harvest",
    id: "boxd_harvest",
    class: "export",
    description: "Export the session tree, import it on this laptop, and record git; copy back any files the work produced. Refuses while the session is busy.",
    input: object({ workId: WORK, localDirectory: LOCAL, files: FILES_OUT, to: LOCAL }, ["workId"]),
    run: (fleet, input) => fleet.harvest({
      workId: text(input, "workId", "workId"),
      ...optional(input, "localDirectory") ? { localDirectory: optional(input, "localDirectory") } : {},
      ...Array.isArray(input.files) ? { files: input.files.filter((path) => typeof path === "string") } : {},
      ...optional(input, "to") ? { to: optional(input, "to") } : {}
    })
  },
  {
    name: "sleep",
    id: "boxd_sleep",
    class: "write",
    description: "Hibernate the machine, which keeps its disk, and let it stay down. Works even when the guest cannot be harvested; it records a warning when the last prompt is not.",
    input: object({ workId: WORK }, ["workId"]),
    run: (fleet, input) => fleet.sleep({ workId: text(input, "workId", "workId") })
  },
  {
    name: "resume",
    id: "boxd_resume",
    class: "write",
    description: "Wake a hibernated machine, or rebuild a destroyed one from the golden snapshot and the proven transcript.",
    input: object({ workId: WORK }, ["workId"]),
    run: (fleet, input) => fleet.resume({ workId: text(input, "workId", "workId") })
  },
  {
    name: "image",
    id: "boxd_image",
    class: "write",
    description: "Save a new immutable snapshot of a machine this plugin owns. Refuses if any work on that machine lacks a fresh export. Not a session backup.",
    input: object({ machine: MACHINE, name: SNAPSHOT }, ["machine", "name"]),
    run: (fleet, input) => fleet.image({ machine: text(input, "machine", "machine"), name: text(input, "name", "name") })
  },
  {
    name: "drop",
    id: "boxd_drop",
    class: "destructive",
    description: "Destroy the machine and close the work. Refuses unless the laptop import is fresh, the guest is a git repository, and every untracked or ignored path was harvested at the digest the guest still has.",
    input: object({ workId: WORK }, ["workId"]),
    run: (fleet, input) => fleet.drop({ workId: text(input, "workId", "workId") })
  }
];
var READ_TOOLS = TOOLS.filter((tool) => tool.class === "read").map((tool) => tool.id);
var CHANGING_TOOLS = TOOLS.filter((tool) => tool.class !== "read").map((tool) => tool.id);

// src/permissions.ts
var rule = (action, effect) => ({ action, resource: "*", effect });
var changingEffect = (access) => access === "all" ? "allow" : access === "ask-changes" ? "ask" : "deny";
var defaultRules = (access = "all") => {
  const changing = changingEffect(access);
  return [
    rule("boxd_*", changing),
    ...READ_TOOLS.map((tool) => rule(tool, "allow")),
    ...CHANGING_TOOLS.map((tool) => rule(tool, changing))
  ];
};

// src/status.ts
var agentRules = (access) => defaultRules(access).map((rule2, index, rules) => `  ${JSON.stringify(rule2)}${index < rules.length - 1 ? "," : ""}`).join("\n");
var CLASS_OF = new Map(TOOLS.map((tool) => [tool.id, tool.class]));
var RULES_NOT_ADDED = "RULES_NOT_ADDED:";
var list = (names) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
function accessText(status) {
  const changing = TOOLS.filter((tool) => tool.class !== "read");
  const classes = [...new Set(changing.map((tool) => tool.class))].join(", ");
  const posture = status.access === "all" ? `every tool is allowed without asking, including the ${changing.length} machine changes (${classes}); option access is "all"` : status.access === "ask-changes" ? `reads run without asking; the ${changing.length} machine changes (${classes}) ask first; option access is "ask-changes"` : `reads run without asking; the ${changing.length} machine changes (${classes}) are denied; option access is "read-only"`;
  const rules = status.problems.some((problem) => problem.startsWith(RULES_NOT_ADDED)) ? "the default rules are missing (see the OpenCode row)" : status.unguardedAgents.length ? "the default rules are missing in the agents listed below" : "no agent runs a new boxd tool unasked";
  return `${posture}; ${rules}`;
}
function toolsText({ tools, unknownCount, unknownTools, access }) {
  if (unknownCount === 0) return `${tools} available, 0 unknown`;
  const more = unknownCount - unknownTools.length;
  const names = unknownTools.length ? `: ${unknownTools.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : "";
  const unknown = access === "read-only" ? "are denied" : access === "ask-changes" ? "ask before running" : "run without asking";
  return `${tools} available, ${unknownCount} unknown${names} (unknown tools ${unknown})`;
}
function outcomeText(outcome) {
  if (outcome === null) return "";
  if (outcome === "failed") return ", last run failed";
  if (outcome === "aborted") return ", last run aborted";
  return ", last run completed";
}
function snapshotText({ snapshot, snapshotPresent }) {
  if (snapshotPresent === false) return `${snapshot} (not in this boxd account)`;
  if (snapshotPresent === null) return `${snapshot} (not checked: the snapshot list could not be read)`;
  return `${snapshot} (present)`;
}
function worksText({ openWorks, unharvested, warned, orphans, works }) {
  const unowned = orphans.length ? `; machines no ledger records: ${list(orphans)}` : "";
  if (openWorks === 0) return `no open work${unowned}`;
  const machines = works.map((work) => `${work.workId} (${work.machineStatus ?? "state unknown"}${outcomeText(work.outcome)}${work.outcome === "failed" && work.error ? `: ${work.error}` : ""})`).join(", ");
  const stale = unharvested.length ? `; no fresh laptop import: ${list(unharvested)}` : "; every work has a fresh laptop import";
  const asleep = warned.length ? `; hibernated before a harvest: ${list(warned)}` : "";
  return `${openWorks} open: ${machines}${stale}${asleep}${unowned}`;
}
function hostText({ host, problems }) {
  const { version, range, tested } = host;
  const outside = version === null || !isSupportedHost(version);
  const notes = [
    ...outside ? [`It is outside the supported range; the plugin runs because allowUntestedHost is true. If it misbehaves, use OpenCode ${TESTED_TEXT}.`] : [],
    ...problems
  ];
  return `${version ?? "unknown version"} (${tested ? "tested" : "untested"}; supported range ${range})${notes.length ? `. ${notes.join(" ")}` : ""}`;
}
var TESTED_TEXT = `${TESTED_HOSTS.slice(0, -1).join(", ")} or ${TESTED_HOSTS.at(-1)}`;
function formatStatus(status) {
  const agents = status.unguardedAgents;
  const connection = status.state === "failed" ? `failed (${status.error ?? "no reason given"})` : `connected (the ledger is readable; ${status.openWorks} open ${status.openWorks === 1 ? "work" : "works"})`;
  return [
    `${DISPLAY_NAME} status`,
    `- Connection: ${connection}`,
    `- Account: not read: the plugin never reads your boxd account or credentials, and boxd_status runs one read-only machine get per open work`,
    `- Access: ${accessText(status)}`,
    `- Snapshot: ${snapshotText(status)}`,
    `- Guest: must be OpenCode ${status.guestVersion ?? "unknown"}, this laptop's version; a job or a harvest checks it`,
    `- Works: ${worksText(status)}`,
    `- Tools: ${toolsText(status)}`,
    `- Agents without default rules: ${agents.length ? `${agents.join(", ")}
${agentRules(status.access)}` : "none"}`,
    `- OpenCode: ${hostText(status)}`,
    `- Next step: ${status.nextStep}`
  ].join("\n");
}
var strings = { type: "array", items: { type: "string" } };
var count = { type: "integer", minimum: 0 };
var nullableString = { type: ["string", "null"] };
var StatusRpc = {
  id: PLUGIN_ID,
  methods: {
    status: {
      input: { type: "object" },
      output: {
        type: "object",
        required: ["version", "state", "access", "host", "snapshot", "snapshotPresent", "guestVersion", "works", "openWorks", "unharvested", "orphans", "warned", "failedRuns", "tools", "unknownCount", "unknownTools", "unguardedAgents", "problems", "nextStep"],
        properties: {
          version: { type: "string" },
          state: { enum: ["connected", "failed"] },
          access: { enum: ["all", "ask-changes", "read-only"] },
          error: { type: "string" },
          host: {
            type: "object",
            required: ["version", "range", "tested"],
            properties: { version: nullableString, range: { type: "string" }, tested: { type: "boolean" } }
          },
          snapshot: { type: "string" },
          snapshotPresent: { type: ["boolean", "null"] },
          guestVersion: nullableString,
          works: {
            type: "array",
            items: {
              type: "object",
              required: ["workId", "machine", "sessionId", "proof", "dirty", "machineStatus", "warnings"],
              properties: {
                workId: { type: "string" },
                machine: { type: "string" },
                sessionId: nullableString,
                proof: { enum: ["fresh", "stale", "missing"] },
                dirty: { type: "boolean" },
                machineStatus: { type: ["string", "null"] },
                warnings: strings,
                outcome: { type: ["string", "null"], enum: ["completed", "failed", "aborted", null] },
                error: { type: "string" }
              }
            }
          },
          openWorks: count,
          unharvested: strings,
          orphans: strings,
          warned: strings,
          failedRuns: {
            type: "array",
            items: { type: "object", required: ["workId"], properties: { workId: { type: "string" }, error: { type: "string" } } }
          },
          tools: count,
          unknownCount: count,
          unknownTools: strings,
          unguardedAgents: strings,
          problems: strings,
          nextStep: { type: "string" }
        }
      },
      errors: { unavailable: { type: "object", required: ["nextStep"], properties: { nextStep: { type: "string" } } } }
    }
  },
  events: {}
};

// src/tui.ts
var TITLE2 = `${DISPLAY_NAME} status`;
var KEYS = "r refresh \xB7 esc close";
function viewMessage(result) {
  return `${reportOf(result)}

${KEYS}`;
}
function reportOf(result) {
  if ("status" in result) return formatStatus(result.status).split("\n").slice(1).join("\n");
  const { error } = result;
  const type = typeof error === "object" && error !== null && "type" in error ? error.type : void 0;
  if (type === "unavailable") {
    const { message, data } = error;
    if (typeof message === "string" && typeof data?.nextStep === "string") return `${message} Next step: ${data.nextStep}`;
  }
  if (type === "rpc.unavailable" || type === "rpc.method_not_found") {
    return errorText("STATUS_UNAVAILABLE", "The boxd plugin is not running on this OpenCode server.", "Run /plugins to see why it did not start.");
  }
  const reason = shortReason(typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error));
  return errorText("STATUS_UNAVAILABLE", `Could not read boxd's status${reason ? ` (${reason})` : ""}.`, "Restart OpenCode, then run /boxd again.");
}
function setupView(context) {
  let open;
  let latest = 0;
  let stops = [];
  const unsubscribe = () => {
    for (const stop of stops.splice(0)) stop();
  };
  const subscribe = () => {
    if (stops.length) return;
    stops = [
      // The ledger and the agents change from outside the dialog: a harvest, a rule edit, a plugin rebuild.
      context.data.on("server.connected", refresh),
      context.data.on("agent.updated", refresh)
    ];
  };
  const [shown, setShown] = createSignal(false);
  const show = async (refresh2) => {
    if (refresh2 && open === void 0) return;
    const request = ++latest;
    const location = context.location;
    const result = await context.client.rpc(StatusRpc).status({}, location ? { location } : {}).then((status) => ({ status }), (error) => ({ error }));
    if (request !== latest || refresh2 && open === void 0) return;
    open = request;
    setShown(true);
    subscribe();
    void context.ui.dialog.alert({ title: TITLE2, message: viewMessage(result) }).then(() => {
      if (open !== request) return;
      open = void 0;
      setShown(false);
      unsubscribe();
    });
    context.ui.dialog.set({ size: "large" });
  };
  const refresh = () => void show(true);
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
        run: () => show(false)
      },
      { id: `${PLUGIN_ID}.status.refresh`, title: `Refresh ${DISPLAY_NAME} status`, group: DISPLAY_NAME, bind: "r", enabled: shown, run: refresh }
    ]
  }));
  return () => {
    unsubscribe();
    if (open === void 0) return;
    open = void 0;
    setShown(false);
    context.ui.dialog.clear();
  };
}
var tui_default = Plugin.define({ id: `${PLUGIN_ID}.tui`, setup: setupView });
export {
  tui_default as default
};
