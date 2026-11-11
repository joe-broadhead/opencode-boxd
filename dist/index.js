// src/plugin.ts
import { homedir } from "node:os";
import { join as join5 } from "node:path";
import { Plugin } from "@opencode/plugin";

// src/cli-boxd.ts
import { readFile } from "node:fs/promises";

// src/constants.ts
var PLUGIN_ID = "boxd.machines";
var COMMAND_STEM = "boxd";
var DISPLAY_NAME = "boxd";
var NAMESPACE = "boxd";
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

// src/names.ts
var WORK = /^[a-z][a-z0-9-]{0,24}$/;
var SESSION = /^ses_[A-Za-z0-9_-]{1,80}$/;
var SNAPSHOT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
var DIRECTORY = /^\/[A-Za-z0-9_./-]+$/;
var REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;
function assertWorkId(workId) {
  if (!WORK.test(workId)) throw boxdError("NAME_INVALID", `Work id "${workId}" is not a short lowercase name.`);
}
function machineName(workId) {
  assertWorkId(workId);
  return `oc-${workId}`;
}
function assertSessionId(id) {
  if (!SESSION.test(id)) throw boxdError("NAME_INVALID", `Session id "${id}" is not an OpenCode session id.`);
  return id;
}
function assertDirectory(path) {
  if (!DIRECTORY.test(path) || path.includes("..") || path.endsWith("/")) {
    throw boxdError("NAME_INVALID", `Directory "${path}" must be an absolute guest path with no spaces or "..".`);
  }
  return path;
}
function assertSnapshot(name) {
  if (!SNAPSHOT.test(name)) throw boxdError("NAME_INVALID", `Snapshot name "${name}" is not a boxd snapshot name.`);
  return name;
}
function assertRepo(url) {
  if (!REPO.test(url)) throw boxdError("NAME_INVALID", "Repo must be an https://github.com/owner/repo URL.");
  return url;
}
function workDirectory(workId) {
  assertWorkId(workId);
  return `/home/boxd/work/${workId}`;
}

// src/argv.ts
function createArgs(workId, snapshot) {
  assertWorkId(workId);
  assertSnapshot(snapshot);
  return [
    "machine",
    "new",
    machineName(workId),
    "--from-snapshot",
    snapshot,
    "--label",
    "role=session",
    "--label",
    `work=${workId}`,
    "--json"
  ];
}
var AWAKE_SECONDS = "1800";
var SLEEP_SECONDS = "14400";
function getArgs(name) {
  return ["machine", "get", name, "--json"];
}
function listArgs() {
  return ["machine", "list", "--json"];
}
function hibernateArgs(name) {
  return ["machine", "hibernate", name, "--json"];
}
function wakeArgs(name) {
  return ["machine", "wake", name, "--json"];
}
function removeArgs(name) {
  return ["machine", "remove", name, "-y"];
}
function holdAwakeArgs(name) {
  return ["machine", "config", "set", name, "auto-hibernate.timeout", AWAKE_SECONDS];
}
function allowSleepArgs(name) {
  return ["machine", "config", "set", name, "auto-hibernate.timeout", SLEEP_SECONDS];
}
function outboundArgs(name, value) {
  return ["machine", "config", "set", name, "idle.ignore-outbound", value];
}
function saveSnapshotArgs(machine, snapshot) {
  assertSnapshot(snapshot);
  return ["snapshots", "save", machine, snapshot, "--json"];
}
function listSnapshotArgs() {
  return ["snapshots", "list", "--json"];
}
function execArgs(machine) {
  return ["machine", "exec", machine, "--", "python3", "/tmp/opencode-boxd/guest.py"];
}
function copyToGuestArgs(machine, remote) {
  assertDirectory(remote);
  return ["machine", "cp", "-", `${machine}:${remote}`];
}
function copyFromGuestArgs(machine, remote) {
  assertDirectory(remote);
  return ["machine", "cp", `${machine}:${remote}`, "-"];
}
function guestRequest(action, fields) {
  if (typeof fields.sessionID === "string") assertSessionId(fields.sessionID);
  if (typeof fields.directory === "string") assertDirectory(fields.directory);
  return JSON.stringify({ action, ...fields });
}

// src/run.ts
import { spawn } from "node:child_process";
function run(bin, args, options) {
  const timeoutMs = options?.timeoutMs ?? 2e4;
  return new Promise((resolve2, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(boxdError("TIMEOUT", `${bin} ${args[0] ?? ""} did not answer within ${timeoutMs} ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(boxdError("BOXD_MISSING", `The boxd CLI could not be run (${error.message}).`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve2({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    if (options?.stdin !== void 0) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}
function runBuffer(bin, args, options) {
  return new Promise((resolve2, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(boxdError("TIMEOUT", `${bin} ${args[0] ?? ""} did not answer within ${options?.timeoutMs ?? 6e4} ms.`));
    }, options?.timeoutMs ?? 6e4);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(boxdError("BOXD_MISSING", `The boxd CLI could not be run (${error.message}).`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve2({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    if (options?.stdin) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}
function parseJson(text2) {
  const start = text2.indexOf("{");
  const list3 = text2.indexOf("[");
  const cut2 = start === -1 ? list3 : list3 === -1 ? start : Math.min(start, list3);
  if (cut2 === -1) throw boxdError("BOXD_FAILED", "The boxd CLI did not return JSON.");
  return JSON.parse(text2.slice(cut2));
}

// src/cli-boxd.ts
function cliBoxd(bin = "boxd") {
  return {
    get: (name) => get(bin, name),
    list: async () => {
      const result = await run(bin, listArgs());
      if (result.code !== 0) fail("list", result.stderr);
      const parsed = parseJson(result.stdout);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((item) => parseMachine(item, String(asRecord(item).name ?? "")));
    },
    create: async (input) => {
      const result = await run(bin, createArgs(input.workId, input.snapshot), { timeoutMs: 3e4 });
      if (result.code !== 0) fail("create", result.stderr);
      const created = asRecord(parseJson(result.stdout));
      const name = String(created.name ?? input.name);
      try {
        return await get(bin, name);
      } catch {
        return { name, status: "starting", sharing: "unknown", isolated: false, ...typeof created.source === "string" ? { source: created.source } : {} };
      }
    },
    hibernate: (name) => ok(bin, hibernateArgs(name)),
    wake: (name) => ok(bin, wakeArgs(name)),
    remove: (name) => ok(bin, removeArgs(name)),
    saveSnapshot: (machine, snapshot) => ok(bin, saveSnapshotArgs(machine, snapshot), 6e4),
    listSnapshots: async () => {
      const result = await run(bin, listSnapshotArgs());
      if (result.code !== 0) fail("snapshots", result.stderr);
      const parsed = parseJson(result.stdout);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((item) => {
        const record2 = asRecord(item);
        return { name: String(record2.name ?? ""), storage: String(record2.storage ?? ""), status: String(record2.status ?? "") };
      });
    },
    holdAwake: async (name) => {
      await ok(bin, holdAwakeArgs(name));
      await ok(bin, outboundArgs(name, "off"));
    },
    allowSleep: async (name) => {
      await ok(bin, allowSleepArgs(name));
      await ok(bin, outboundArgs(name, "on"));
    }
  };
}
async function get(bin, name) {
  const result = await run(bin, getArgs(name));
  if (result.code !== 0) {
    if (isMissing(result.stderr)) return missing(name);
    fail("get", result.stderr);
  }
  return parseMachine(parseJson(result.stdout), name);
}
async function ok(bin, args, timeoutMs) {
  const result = await run(bin, args, { timeoutMs });
  if (result.code !== 0) fail(args[0] ?? "boxd", result.stderr || result.stdout);
}
function parseMachine(raw, fallbackName) {
  const record2 = asRecord(raw);
  const boot = String(record2.boot ?? "");
  const status = normalize(String(record2.status ?? (boot === "starting" ? "starting" : boot || "starting")));
  const sharing = record2.sharing === "shared" ? "shared" : record2.sharing === "private" ? "private" : "unknown";
  return {
    name: String(record2.name ?? fallbackName),
    status,
    sharing,
    // `machine get --json` prints isolation as the string "yes" or "no"; a fake may print a boolean.
    isolated: record2.isolated === true || record2.isolated === "yes" || record2.isolated === "true",
    source: typeof record2.source === "string" ? record2.source : void 0
  };
}
function missing(name) {
  return { name, status: "missing", sharing: "unknown", isolated: false };
}
function isMissing(stderr) {
  return /not found|no such|no machine|unknown|does not exist/i.test(stderr);
}
function normalize(value) {
  if (value === "suspended") return "standby";
  if (value === "hibernating" || value === "rebooting") return "starting";
  if (value === "running" || value === "starting" || value === "standby" || value === "hibernated" || value === "stopped" || value === "destroyed" || value === "missing") {
    return value;
  }
  return "other";
}
function asRecord(value) {
  return value && typeof value === "object" ? value : {};
}
function fail(action, detail) {
  throw boxdError("BOXD_FAILED", `boxd ${action} failed (${detail.trim().slice(0, 300) || "no output"}).`);
}
async function readGuestHelper() {
  return readFile(new URL("../guest/guest.py", import.meta.url), "utf8");
}

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
var reasonOf = (error, fallback = "no reason given") => shortReason(error instanceof Error ? error.message : String(error)) ?? fallback;

// src/outcome.ts
var STATES = { succeeded: "completed", failed: "failed", interrupted: "aborted" };
function mapOutcome(value) {
  return typeof value === "string" ? STATES[value] ?? null : null;
}
function errorLine(error) {
  if (!error || typeof error !== "object") return void 0;
  const { type, message } = error;
  const text2 = shortReason(typeof message === "string" ? message : "");
  if (!text2) return void 0;
  const name = typeof type === "string" && /^[a-z][\w.-]{0,40}$/i.test(type) ? type : "error";
  return shortReason(`${name}: ${text2}`);
}
function readRun(info, messages) {
  const session = info && typeof info === "object" ? info : {};
  let outcome = mapOutcome(session.outcome);
  let error;
  if (Array.isArray(messages)) {
    for (const message of [...messages].reverse()) {
      if (!message || typeof message !== "object") continue;
      const record2 = message;
      if (record2.type !== "idle") continue;
      outcome ??= mapOutcome(record2.outcome);
      if (outcome === "failed") error = errorLine(record2.error);
      break;
    }
  }
  return { outcome, ...error ? { error } : {} };
}
function isCredentialFailure(run2) {
  if (run2.outcome !== "failed" || !run2.error) return false;
  return /provider\.auth|auth|api.?key|credential|unauthori[sz]ed|forbidden|401|403|sign.?in/i.test(run2.error);
}
function failureCode(run2) {
  return isCredentialFailure(run2) ? "GUEST_AUTH_FAILED" : "GUEST_RUN_FAILED";
}
function nextStepFor(run2) {
  return CODES[failureCode(run2)];
}
function failureText(run2, workId) {
  return `The last run of ${workId} failed${run2.error ? ` (${run2.error})` : ""}.`;
}

// src/cli-guest.ts
var HELPER = "/tmp/opencode-boxd/guest.py";
function cliGuest(bin = "boxd") {
  const uploaded = /* @__PURE__ */ new Set();
  async function call(machine, action, fields = {}) {
    await ensureHelper(bin, machine, uploaded);
    const result = await run(bin, execArgs(machine), { stdin: guestRequest(action, fields), timeoutMs: 3e4 });
    const parsed = parseLine(result.stdout);
    if (result.code !== 0 || parsed.ok === false) {
      throw boxdError("GUEST_FAILED", `The guest ${action} failed (${String(parsed.error ?? result.stderr).slice(0, 300)}).`);
    }
    return parsed;
  }
  return {
    forget: (machine) => void uploaded.delete(machine),
    version: async (machine) => {
      const result = await run(bin, ["machine", "exec", machine, "--", "opencode", "--version"]);
      if (result.code !== 0) throw boxdError("GUEST_VERSION", "The machine's OpenCode version could not be read.");
      return result.stdout.trim();
    },
    server: async (machine) => {
      const parsed = await call(machine, "serve");
      return parsed.server === "up" ? "up" : "starting";
    },
    prepare: async (machine, directory, repo) => {
      await call(machine, "prepare", { directory, repo });
    },
    listSessions: async (machine) => {
      const parsed = await call(machine, "list");
      const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      return sessions.map((item) => {
        const record2 = item;
        return { id: String(record2.id), parentID: record2.parentID ? String(record2.parentID) : void 0 };
      });
    },
    createSession: async (machine, directory, title) => {
      const parsed = await call(machine, "create", { directory, title });
      return { id: String(parsed.id) };
    },
    prompt: async (machine, sessionID, text2) => {
      await call(machine, "prompt", { sessionID, text: text2 });
    },
    phase: async (machine, sessionID) => {
      const parsed = await call(machine, "phase", { sessionID });
      const phase = parsed.phase === "busy" || parsed.phase === "idle" || parsed.phase === "missing" ? parsed.phase : "missing";
      const outcome = mapOutcome(parsed.outcome);
      const error = errorLine(parsed.error);
      return { phase, run: { outcome, ...error ? { error } : {} } };
    },
    exportSession: async (machine, sessionID) => {
      const parsed = await call(machine, "export", { sessionID });
      return parsed.export;
    },
    importSession: async (machine, transfer, directory) => {
      const parsed = await call(machine, "import", { transfer, directory });
      return { id: String(parsed.id) };
    },
    upload: async (machine, directory, path, body) => {
      await mkdirOnGuest(bin, machine, `${directory}/${path}`);
      const remote = `${directory}/${path}`;
      const result = await runBuffer(bin, copyToGuestArgs(machine, remote), { stdin: body, timeoutMs: 6e4 });
      if (result.code !== 0) throw boxdError("GUEST_FAILED", `The guest refused the upload of ${path} (${result.stderr.trim().slice(0, 200)}).`);
    },
    download: async (machine, directory, path) => {
      const result = await runBuffer(bin, copyFromGuestArgs(machine, `${directory}/${path}`), { timeoutMs: 6e4 });
      if (result.code !== 0) throw boxdError("GUEST_FAILED", `The guest refused the download of ${path} (${result.stderr.trim().slice(0, 200)}).`);
      return result.stdout;
    },
    digest: async (machine, directory, paths) => {
      const parsed = await call(machine, "digest", { directory, paths });
      const digests = parsed.digests && typeof parsed.digests === "object" ? parsed.digests : {};
      return Object.fromEntries(Object.entries(digests).filter((entry) => typeof entry[1] === "string"));
    },
    git: async (machine, directory) => {
      const parsed = await call(machine, "git", { directory });
      return {
        known: parsed.known === true,
        remote: stringOrNull(parsed.remote),
        branch: stringOrNull(parsed.branch),
        sha: stringOrNull(parsed.sha),
        dirty: parsed.dirty === true,
        ...typeof parsed.patch === "string" ? { patch: parsed.patch } : {},
        untracked: strings(parsed.untracked),
        ignored: strings(parsed.ignored),
        untrackedFiles: files(parsed.untrackedFiles)
      };
    }
  };
}
async function mkdirOnGuest(bin, machine, remote) {
  const folder = remote.slice(0, remote.lastIndexOf("/")) || "/";
  const result = await run(bin, ["machine", "exec", machine, "--", "mkdir", "-p", folder]);
  if (result.code !== 0) throw boxdError("GUEST_FAILED", `The guest could not create ${folder} (${result.stderr.trim().slice(0, 200)}).`);
}
async function ensureHelper(bin, machine, uploaded) {
  if (uploaded.has(machine)) return;
  const helper = await readGuestHelper();
  const mkdir4 = await run(bin, ["machine", "exec", machine, "--", "mkdir", "-p", "/tmp/opencode-boxd"]);
  if (mkdir4.code !== 0) throw boxdError("GUEST_FAILED", "The guest work directory could not be created.");
  const copied = await run(bin, copyToGuestArgs(machine, HELPER), { stdin: helper, timeoutMs: 3e4 });
  if (copied.code !== 0) throw boxdError("GUEST_FAILED", "The guest helper could not be copied to the machine.");
  uploaded.add(machine);
}
function parseLine(stdout) {
  const lines = stdout.trim().split("\n");
  const line = [...lines].reverse().find((item) => item.startsWith("{"));
  if (!line) throw boxdError("GUEST_FAILED", "The guest helper did not return JSON.");
  return JSON.parse(line);
}
function stringOrNull(value) {
  return typeof value === "string" && value ? value : null;
}
function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function files(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value).filter(([path, body]) => path.startsWith("/") === false && typeof body === "string");
  return Object.fromEntries(entries);
}

// src/fleet.ts
import { mkdir as mkdir2, stat as stat2 } from "node:fs/promises";
import { join as join2 } from "node:path";

// src/paths.ts
import { createHash } from "node:crypto";
import { lstat, readFile as readFile2, realpath, stat, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
var FILE_LIMIT = 8 * 1024 * 1024;
var TOTAL_LIMIT = 32 * 1024 * 1024;
function assertWorkPath(path) {
  if (!path || path.startsWith("/") || path.includes("\\") || /(^|\/)\.\.?(\/|$)/.test(path) || path.endsWith("/")) {
    throw boxdError("PATH_REFUSED", `"${path}" is not a path inside the work tree.`);
  }
  return path;
}
var inside = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
async function resolveLaptopPath(path, roots, options = {}) {
  const absolute = isAbsolute(path) ? path : resolve(roots[0] ?? process.cwd(), path);
  const realRoots = await Promise.all(roots.map(async (root) => realpath(root).catch(() => resolve(root))));
  let real;
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw boxdError("PATH_REFUSED", `"${path}" is a symlink, which this plugin never follows.`);
    real = await realpath(absolute);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT" && options.create) {
      const parent = await nearestExisting(absolute);
      const realParent = await realpath(parent).catch(() => parent);
      if (!realRoots.some((root) => inside(root, realParent))) throw refused(path, roots);
      return join(realParent, relative(parent, absolute));
    }
    if (error instanceof Error && error.message.startsWith("PATH_REFUSED")) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      const parent = await nearestExisting(absolute);
      const realParent = await realpath(parent).catch(() => parent);
      if (!realRoots.some((root) => inside(root, realParent))) throw refused(path, roots);
      throw boxdError("NAME_INVALID", `"${path}" does not exist.`);
    }
    throw boxdError("PATH_REFUSED", `"${path}" cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!realRoots.some((root) => inside(root, real))) throw refused(path, roots);
  return real;
}
function rootsOf(projectDirectory, allowedRoots) {
  return [projectDirectory, ...allowedRoots];
}
var refused = (path, roots) => boxdError(
  "PATH_REFUSED",
  `"${path}" is outside the project${roots.length > 1 ? " and the allowed roots" : ""}. Allowed: ${roots.join(", ")}.`
);
async function nearestExisting(path) {
  let current = path;
  for (; ; ) {
    try {
      await lstat(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}
async function loadFile(path, roots) {
  const real = await resolveLaptopPath(path, roots);
  const info = await stat(real);
  if (!info.isFile()) throw boxdError("PATH_REFUSED", `"${path}" is not a file.`);
  if (info.size > FILE_LIMIT) throw boxdError("FILE_TOO_LARGE", `"${path}" is ${info.size} bytes; the limit is ${FILE_LIMIT}.`);
  const body = await readFile2(real);
  return { path: real, bytes: body.byteLength, sha256: sha256(body), body };
}
function assertTotal(files2) {
  const total = files2.reduce((sum, file) => sum + file.bytes, 0);
  if (total > TOTAL_LIMIT) throw boxdError("FILE_TOO_LARGE", `The files total ${total} bytes; the limit is ${TOTAL_LIMIT}.`);
}
var sha256 = (body) => createHash("sha256").update(body).digest("hex");
async function storeFile(path, body, previous) {
  const existing = await readFile2(path).catch(() => void 0);
  if (existing) {
    const digest2 = sha256(existing);
    if (digest2 !== sha256(body) && digest2 !== previous) {
      throw boxdError("FILE_CONFLICT", `"${path}" changed since the last harvest, so it was not overwritten.`);
    }
  }
  await mkdir(dirname(path), { recursive: true, mode: 448 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, body, { mode: 384 });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => void 0);
    throw boxdError("LEDGER_FAILED", `"${path}" could not be written: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// src/transfer.ts
import { createHash as createHash2 } from "node:crypto";
function parseExport(payload) {
  const body = unwrap(payload);
  if (!body || typeof body !== "object") invalid("The export is not an object.");
  const record2 = body;
  if (!record2.info || typeof record2.info !== "object" || !Array.isArray(record2.messages)) {
    invalid("The export has no info and messages.");
  }
  const info = record2.info;
  assertSessionId(String(info.id ?? ""));
  if (info.parentID !== void 0) assertSessionId(String(info.parentID));
  return { info: { ...info, id: String(info.id) }, messages: record2.messages };
}
function order(transfers) {
  const byId = new Map(transfers.map((transfer) => [transfer.info.id, transfer]));
  if (byId.size !== transfers.length) invalid("The export set names a session twice.");
  const pending = new Map(byId);
  const ordered = [];
  while (pending.size) {
    const ready = [...pending.values()].filter((transfer) => {
      const parent = transfer.info.parentID;
      return !parent || !pending.has(parent);
    });
    if (!ready.length) invalid("The session tree has a cycle.");
    for (const transfer of ready.sort((a, b) => a.info.id.localeCompare(b.info.id))) {
      const parent = transfer.info.parentID;
      if (parent && !byId.has(parent)) {
        throw boxdError("PARENT_MISSING", `Session ${transfer.info.id} names parent ${parent}, which was not in the export.`);
      }
      pending.delete(transfer.info.id);
      ordered.push(transfer);
    }
  }
  return ordered;
}
function rewrite(transfer, imported) {
  const copy = structuredClone(transfer);
  const parent = copy.info.parentID;
  if (!parent) return copy;
  const mapped = imported.get(parent);
  if (!mapped) throw boxdError("PARENT_MISSING", `Cannot import ${copy.info.id} until parent ${parent} has an id on the destination.`);
  copy.info.parentID = mapped;
  return copy;
}
function digest(transfer) {
  return createHash2("sha256").update(JSON.stringify(transfer)).digest("hex");
}
function unwrap(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const record2 = payload;
  if (!record2.info && record2.data !== void 0) return record2.data;
  return payload;
}
function invalid(message) {
  throw boxdError("EXPORT_INVALID", message);
}

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
var isTestedHost = (version) => TESTED_HOSTS.includes(version);
function checkHost(version, allowUntestedHost) {
  if (!isSupportedHost(version) && !allowUntestedHost) {
    throw boxdError("HOST_UNTESTED", `This plugin supports OpenCode ${SUPPORTED_HOST}, found ${version || "no version"}.`);
  }
  return { version: version === "" ? null : version, range: SUPPORTED_HOST, tested: isTestedHost(version) };
}
function checkGuest(reported, hostVersion) {
  const guest = parseVersion(reported);
  const host = hostVersion === null ? void 0 : parseVersion(hostVersion);
  if (guest === void 0 || host === void 0) {
    throw boxdError("GUEST_VERSION", `The machine reports OpenCode ${reported.trim() || "no version"}, and this laptop reports ${hostVersion ?? "none"}.`);
  }
  if (compare(guest, host) !== 0) {
    throw boxdError("GUEST_VERSION", `The machine runs OpenCode ${reported.trim()}, and this laptop runs ${hostVersion}.`);
  }
}

// src/fleet.ts
var SNAPSHOT_TTL_MS = 3e4;
function createFleet(deps) {
  const snapshot = assertSnapshot(deps.snapshot);
  let snapshots;
  async function snapshotNames(fresh) {
    if (!fresh && snapshots && Date.now() - snapshots.at < SNAPSHOT_TTL_MS) return snapshots.names;
    try {
      const listed = await deps.boxd.listSnapshots();
      snapshots = { at: Date.now(), names: new Set(listed.map((item) => item.name)) };
      return snapshots.names;
    } catch {
      return void 0;
    }
  }
  async function requireSnapshot() {
    const names = await snapshotNames(true);
    if (names && !names.has(snapshot)) throw boxdError("SNAPSHOT_MISSING", `The golden snapshot "${snapshot}" is not in this boxd account.`);
  }
  const report = (code, message) => deps.report?.(`${code}: ${message} Next step: Restart OpenCode, then run /boxd-status.`);
  async function loadOwned(workId) {
    assertWorkId(workId);
    const work = await deps.ledger.load(workId);
    if (!work || work.dropped) throw boxdError("NOT_OURS", `No open work "${workId}".`);
    if (work.machine !== machineName(workId)) throw boxdError("NOT_OURS", `Work "${workId}" is not bound to its own machine.`);
    return work;
  }
  async function ownedBy(machine) {
    return (await deps.ledger.list()).find((work) => work.machine === machine);
  }
  async function machineOf(work) {
    const machine = await deps.boxd.get(work.machine);
    refuseUnsafe(machine);
    return machine;
  }
  async function armAwake(machine, awake = "hold") {
    try {
      if (awake === "hold") await deps.boxd.holdAwake(machine);
      else await deps.boxd.allowSleep(machine);
    } catch (error) {
      const reason = error instanceof Error ? error.message.split(" Next step: ")[0] : String(error);
      report("AWAKE_UNBOUND", `The awake bound could not be armed on ${machine}, so it may idle without hibernating (${reason}).`);
    }
  }
  async function ready(work, options) {
    const machine = await machineOf(work);
    if (machine.status === "missing" || machine.status === "destroyed") {
      throw boxdError("MACHINE_GONE", `Machine ${work.machine} is gone.`);
    }
    if (machine.status === "hibernated" || machine.status === "standby" || machine.status === "stopped") {
      if (!options.wake) throw boxdError("MACHINE_STARTING", `Machine ${work.machine} is ${machine.status}.`);
      await deps.boxd.wake(work.machine);
      await armAwake(work.machine, "hold");
      throw boxdError("MACHINE_STARTING", `Machine ${work.machine} is waking.`);
    }
    if (machine.status !== "running") throw boxdError("MACHINE_STARTING", `Machine ${work.machine} is ${machine.status}.`);
    if (options.arm !== false) await armAwake(work.machine, "hold");
    const server = await deps.guest.server(work.machine);
    if (server !== "up") throw boxdError("MACHINE_STARTING", "OpenCode on the machine is not up yet.");
    checkGuest(await deps.guest.version(work.machine), deps.hostVersion);
    return machine;
  }
  async function create(name, workId) {
    try {
      const machine = await deps.boxd.create({ name, snapshot, workId });
      deps.guest.forget(name);
      return machine;
    } catch (error) {
      if (!(error instanceof BoxdError) || error.code !== "TIMEOUT") throw error;
      const machine = await deps.boxd.get(name);
      if (machine.status === "missing") throw boxdError("CREATE_UNCERTAIN", `boxd did not answer within the timeout, and no machine named ${name} exists yet.`);
      deps.guest.forget(name);
      return machine;
    }
  }
  async function removeRefused(name) {
    await deps.boxd.remove(name).catch(() => void 0);
    throw boxdError("NOT_OURS", `Machine ${name} was created shared or isolated, so it was removed again.`);
  }
  return {
    /** The ledger and each work's machine when the CLI answers. Never starts, wakes or runs a session. */
    async status() {
      const works = await deps.ledger.list();
      const listed = await deps.boxd.list().catch(() => void 0);
      const names = await snapshotNames(false);
      const known = new Set(works.map((work) => work.machine));
      return {
        snapshot,
        snapshotPresent: names ? names.has(snapshot) : null,
        works: await Promise.all(
          works.map(async (work) => {
            const machine = await deps.boxd.get(work.machine).catch(() => void 0);
            return {
              workId: work.workId,
              machine: work.machine,
              sessionId: work.rootSessionId ?? null,
              proof: proofState(work),
              dirty: work.git?.dirty ?? false,
              machineStatus: machine?.status ?? null,
              warnings: (work.warnings ?? []).map((warning) => warning.code),
              outcome: work.lastOutcome?.state ?? null,
              ...work.lastOutcome?.error ? { error: work.lastOutcome.error } : {}
            };
          })
        ),
        orphans: (listed ?? []).map((machine) => machine.name).filter((name) => name.startsWith("oc-") && !known.has(name)).sort()
      };
    },
    async ensure(input) {
      assertWorkId(input.workId);
      const laptopDirectory = await resolveWorkDirectory(deps, input.directory ?? deps.projectDirectory, rootsOf(deps.projectDirectory, deps.allowedRoots), true);
      const guestDirectory = workDirectory(input.workId);
      const directory = guestDirectory;
      const repo = input.repo ? assertRepo(input.repo) : void 0;
      const name = machineName(input.workId);
      let work = await deps.ledger.load(input.workId);
      if (work?.dropped) throw boxdError("NOT_OURS", `Work "${input.workId}" was dropped. Use a new work id.`);
      let machine = await deps.boxd.get(name);
      refuseUnsafe(machine);
      if (machine.status === "missing" || machine.status === "destroyed") {
        await requireSnapshot();
        await deps.ledger.mutate(input.workId, (current) => ({
          workId: input.workId,
          machine: name,
          snapshot,
          laptopDirectory,
          guestDirectory,
          ...repo ?? current?.repo ? { repo: repo ?? current?.repo } : {},
          ...current?.rootSessionId ? { rootSessionId: current.rootSessionId } : {},
          ...current?.lastSubmitAt ? { lastSubmitAt: current.lastSubmitAt } : {},
          ...current?.proof ? { proof: current.proof } : {},
          ...current?.git ? { git: current.git } : {},
          ...current?.warnings ? { warnings: current.warnings } : {},
          pendingCreate: { at: deps.now(), snapshot }
        }));
        machine = await create(name, input.workId);
        if (machine.sharing === "shared" || machine.isolated) await removeRefused(name);
      }
      work = await deps.ledger.mutate(input.workId, (current) => {
        const next = {
          workId: input.workId,
          machine: name,
          snapshot,
          laptopDirectory,
          guestDirectory,
          ...repo ?? current?.repo ? { repo: repo ?? current?.repo } : {},
          ...current?.rootSessionId ? { rootSessionId: current.rootSessionId } : {},
          ...current?.lastSubmitAt ? { lastSubmitAt: current.lastSubmitAt } : {},
          ...current?.proof ? { proof: current.proof } : {},
          ...current?.git ? { git: current.git } : {},
          ...current?.warnings ? { warnings: current.warnings } : {}
        };
        return next;
      });
      if (machine.status !== "running") {
        if (machine.status === "hibernated" || machine.status === "standby" || machine.status === "stopped") {
          await deps.boxd.wake(name);
          await armAwake(name, "hold");
        }
        return { workId: input.workId, machine: name, state: "starting", next: "Call boxd_status in a later turn." };
      }
      await armAwake(name, "hold");
      checkGuest(await deps.guest.version(name), deps.hostVersion);
      if (await deps.guest.server(name) !== "up") {
        return { workId: input.workId, machine: name, state: "starting", next: "Call boxd_status in a later turn." };
      }
      await prepareWorkspace(deps, name, directory, work.repo);
      return { workId: input.workId, machine: name, guestDirectory, laptopDirectory, state: "ready", guestVersion: deps.hostVersion };
    },
    async submit(input) {
      const work = await loadOwned(input.workId);
      if (!input.text.trim()) throw boxdError("NAME_INVALID", "Prompt text is empty.");
      const incoming = await readIncoming(deps, input.files ?? []);
      await ready(work, { wake: true });
      const uploaded = await uploadAll(deps, work, incoming);
      let sessionId = work.rootSessionId;
      if (!sessionId) {
        const created = await deps.guest.createSession(work.machine, work.guestDirectory, input.title ?? input.workId);
        sessionId = assertSessionId(created.id);
        await deps.ledger.mutate(work.workId, (current) => ({ ...current ?? work, rootSessionId: sessionId }));
      }
      const at = deps.now();
      await deps.ledger.mutate(work.workId, (current) => ({ ...current ?? work, lastSubmitAt: at }));
      await deps.guest.prompt(work.machine, sessionId, input.text);
      return {
        workId: work.workId,
        machine: work.machine,
        sessionId,
        state: "admitted",
        ...uploaded.length ? { files: uploaded.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })) } : {},
        next: "Call boxd_job in a later turn. This call did not wait for the model."
      };
    },
    /**
     * One read. It never wakes a hibernated machine: it reports `asleep` with the machine's own state, and the next step
     * is the asking call that would wake it.
     */
    async job(input) {
      const work = await loadOwned(input.workId);
      const machine = await machineOf(work);
      const status = machine.status;
      if (status === "missing" || status === "destroyed") {
        return { workId: work.workId, machine: work.machine, state: "gone", next: "Call boxd_resume to rebuild it from the golden snapshot and the proven transcript." };
      }
      if (status === "hibernated" || status === "standby" || status === "stopped") {
        return {
          workId: work.workId,
          machine: work.machine,
          state: "asleep",
          machineStatus: status,
          next: "Call boxd_resume to wake it. This read does not wake a machine, because waking starts billing."
        };
      }
      if (status !== "running") {
        return { workId: work.workId, machine: work.machine, state: "starting", machineStatus: status, next: "Call boxd_job in a later turn." };
      }
      if (!work.rootSessionId) {
        if (await deps.guest.server(work.machine) !== "up") {
          return { workId: work.workId, machine: work.machine, state: "starting", next: "OpenCode on the machine is not up yet. Call boxd_job in a later turn." };
        }
        return { workId: work.workId, state: "empty", next: "Call boxd_submit." };
      }
      await ready(work, { wake: false, arm: false });
      const { phase, run: run2 } = await deps.guest.phase(work.machine, work.rootSessionId);
      return {
        workId: work.workId,
        sessionId: work.rootSessionId,
        state: phase,
        proof: proofState(work),
        // The last run's outcome, so an idle session that failed is never read as a finished job.
        outcome: run2.outcome,
        ...run2.outcome === "failed" ? { error: run2.error, warning: failureCode(run2) } : {},
        next: jobNext(work.workId, phase, run2)
      };
    },
    async harvest(input) {
      const work = await loadOwned(input.workId);
      const roots = rootsOf(deps.projectDirectory, deps.allowedRoots);
      const localDirectory = await resolveWorkDirectory(deps, input.localDirectory ?? work.laptopDirectory, roots);
      const wanted = (input.files ?? []).map((path) => assertWorkPath(path));
      const toDirectory = input.to ? await resolveWorkDirectory(deps, input.to, roots, true) : localDirectory;
      if (!work.rootSessionId) throw boxdError("NOT_OURS", "This work has no session. Call boxd_submit first.");
      await ready(work, { wake: true });
      const { phase, run: live } = await deps.guest.phase(work.machine, work.rootSessionId);
      if (phase === "busy") throw boxdError("SESSION_BUSY", "The session is still running.");
      const listed = await deps.guest.listSessions(work.machine);
      const tree = collect(work.rootSessionId, listed);
      const transfers = order(await Promise.all(tree.map(async (id) => parseExport(await deps.guest.exportSession(work.machine, id)))));
      const root = transfers.find((transfer) => transfer.info.id === work.rootSessionId);
      const exported = readRun(root?.info, root?.messages);
      const run2 = live.outcome === "aborted" ? live : exported.outcome ? exported : live;
      const imported = /* @__PURE__ */ new Map();
      const sessions = [];
      const sha2562 = {};
      for (const transfer of transfers) {
        await deps.ledger.saveExport(work.workId, transfer.info.id, transfer);
        sha2562[transfer.info.id] = digest(transfer);
        const result = await deps.prover.importTransfer(rewrite(transfer, imported), localDirectory);
        const importedId = assertSessionId(result.id);
        imported.set(transfer.info.id, importedId);
        sessions.push({ remoteId: transfer.info.id, importedId, ...transfer.info.parentID ? { parentRemoteId: transfer.info.parentID } : {} });
      }
      const git = await harvestGit(deps, work);
      const proof = { harvestedAt: deps.now(), guestVersion: deps.hostVersion ?? "unknown", sessions, sha256: sha2562 };
      await deps.ledger.mutate(work.workId, (current) => ({
        ...current ?? work,
        proof,
        git,
        warnings: [],
        ...run2.outcome ? { lastOutcome: { state: run2.outcome, ...run2.error ? { error: run2.error } : {}, at: deps.now() } } : {}
      }));
      const moved = await downloadAll(deps, work, wanted, toDirectory);
      if (moved.length) {
        await deps.ledger.mutate(work.workId, (current) => ({ ...current ?? work, downloads: mergeFiles(current?.downloads, moved) }));
      }
      return {
        workId: work.workId,
        state: "proven",
        outcome: run2.outcome,
        ...run2.outcome === "failed" ? { error: run2.error, warning: failureCode(run2) } : {},
        ...moved.length ? { files: moved.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })) } : {},
        sessions: sessions.map((session) => ({ remoteId: session.remoteId, importedId: session.importedId })),
        git: { known: git.known, remote: git.remote, sha: git.sha, dirty: git.dirty, patchStored: git.patchStored, untracked: git.untracked, ignored: git.ignored },
        // A failed run is a warning on a successful harvest: the transcript is imported and proven, and the laptop keeps
        // it. The next step says what to do before the next prompt.
        next: run2.outcome === "failed" ? `${failureText(run2, work.workId)} ${nextStepFor(run2)}` : dropAdvice(git, proofState(await loadOwned(work.workId)))
      };
    },
    /**
     * Hibernates. It destroys nothing, so it does not need a proof: a machine whose guest cannot be harvested must always
     * have an exit from billing. A live prompt that was not harvested is recorded as a warning, and status shows it.
     */
    async sleep(input) {
      const work = await loadOwned(input.workId);
      const machine = await machineOf(work);
      if (machine.status !== "missing" && machine.status !== "destroyed") {
        await deps.boxd.hibernate(work.machine);
        await armAwake(work.machine, "sleep");
      }
      const unharvested = work.lastSubmitAt !== void 0 && proofState(work) !== "fresh";
      if (unharvested) {
        await deps.ledger.mutate(work.workId, (current) => ({ ...current ?? work, warnings: addWarning(current?.warnings, { code: "UNHARVESTED_SLEEP", at: deps.now() }) }));
      }
      return {
        workId: work.workId,
        machine: work.machine,
        state: "hibernated",
        ...unharvested ? { warning: "The last prompt's work is not harvested on this laptop yet. Calling boxd_resume and boxd_harvest recovers it.", next: "Call boxd_resume and boxd_harvest when you need that work." } : {}
      };
    },
    /**
     * Destroys the machine. It is refused unless the laptop has a proven import, the guest's tree is a known git
     * repository, and it has no untracked or ignored path: nothing is destroyed that the ledger cannot account for.
     */
    async drop(input) {
      const work = await loadOwned(input.workId);
      await requireDroppable(deps, work);
      const machine = await deps.boxd.get(work.machine);
      if (machine.name !== work.machine) throw boxdError("NOT_OURS", "Refusing to remove a machine this work does not own.");
      refuseUnsafe(machine);
      if (machine.status !== "missing" && machine.status !== "destroyed") await deps.boxd.remove(work.machine);
      await deps.ledger.mutate(work.workId, (current) => ({ ...current ?? work, dropped: true }));
      return { workId: work.workId, machine: work.machine, state: "dropped" };
    },
    async resume(input) {
      const work = await loadOwned(input.workId);
      let machine = await deps.boxd.get(work.machine);
      refuseUnsafe(machine);
      if (machine.status === "hibernated" || machine.status === "standby" || machine.status === "stopped") {
        await deps.boxd.wake(work.machine);
        await armAwake(work.machine, "hold");
        return { workId: work.workId, machine: work.machine, state: "starting", resumed: "wake", next: "Call boxd_status in a later turn." };
      }
      if (machine.status === "starting" || machine.status === "other") {
        throw boxdError("MACHINE_STARTING", `Machine ${work.machine} is ${machine.status}.`);
      }
      let recreated = false;
      if (machine.status === "missing" || machine.status === "destroyed") {
        await requireSnapshot();
        machine = await create(work.machine, work.workId);
        if (machine.sharing === "shared" || machine.isolated) await removeRefused(work.machine);
        recreated = true;
        if (machine.status !== "running") return { workId: work.workId, machine: work.machine, state: "starting", resumed: "import", next: "Call boxd_resume again once boxd_status reports running." };
      }
      await armAwake(work.machine, "hold");
      checkGuest(await deps.guest.version(work.machine), deps.hostVersion);
      await prepareWorkspace(deps, work.machine, work.guestDirectory, work.repo);
      if (recreated && await deps.guest.server(work.machine) !== "up") {
        return { workId: work.workId, machine: work.machine, state: "starting", resumed: "import", next: "Call boxd_resume again once the machine's OpenCode server is up." };
      }
      if (!recreated && work.rootSessionId) {
        const { phase, run: run2 } = await deps.guest.phase(work.machine, work.rootSessionId);
        if (phase === "idle" && run2.outcome === "aborted") throw boxdError("RUN_INTERRUPTED", "The run was interrupted: the guest's OpenCode stopped during it.");
        if (phase !== "missing") return { workId: work.workId, machine: work.machine, sessionId: work.rootSessionId, state: phase, resumed: "wake" };
      }
      if (!work.proof) throw boxdError("NOT_PROVEN", "The machine is gone and there is no proven export to restart from.");
      const transfers = order(await Promise.all(work.proof.sessions.map((session) => deps.ledger.loadExport(work.workId, session.remoteId))));
      const imported = /* @__PURE__ */ new Map();
      for (const transfer of transfers) {
        const result = await deps.guest.importSession(work.machine, rewrite(transfer, imported), work.guestDirectory);
        imported.set(transfer.info.id, assertSessionId(result.id));
      }
      const root = work.rootSessionId ? imported.get(work.rootSessionId) : void 0;
      await deps.ledger.mutate(work.workId, (current) => ({
        ...current ?? work,
        ...root ? { rootSessionId: root } : {},
        proof: void 0,
        lastSubmitAt: deps.now(),
        warnings: []
      }));
      return {
        workId: work.workId,
        machine: work.machine,
        sessionId: root ?? null,
        state: "ready",
        resumed: "import",
        next: "The transcript is back. Harvest again before sleep, image or drop, because the old proof was for the previous machine."
      };
    },
    /** Saves a new immutable snapshot of a machine this plugin owns. */
    async image(input) {
      const name = assertSnapshot(input.name);
      const owner = await ownedBy(input.machine);
      if (!owner) throw boxdError("NOT_OURS", `No work id owns machine ${input.machine}.`);
      const existing = await deps.boxd.listSnapshots();
      if (existing.some((item) => item.name === name)) throw boxdError("SNAPSHOT_EXISTS", `Snapshot ${name} already exists.`);
      const machine = await deps.boxd.get(input.machine);
      refuseUnsafe(machine);
      if (machine.status !== "running") throw boxdError("MACHINE_STARTING", `Machine ${input.machine} is ${machine.status}.`);
      checkGuest(await deps.guest.version(input.machine), deps.hostVersion);
      const stale = (await deps.ledger.list()).filter((work) => work.machine === input.machine && proofState(work) !== "fresh");
      if (stale.length) throw boxdError("NOT_PROVEN", `Machine ${input.machine} has work without a fresh export (${stale.map((work) => work.workId).join(", ")}).`);
      await deps.boxd.saveSnapshot(input.machine, name);
      return { machine: input.machine, snapshot: name, state: "saved" };
    }
  };
}
async function prepareWorkspace(deps, machine, guestDirectory, repo) {
  try {
    await deps.guest.prepare(machine, guestDirectory, repo);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split(" Next step: ")[0] : String(error);
    throw boxdError("GUEST_WORKSPACE", `The machine could not prepare ${guestDirectory} (${reason}).`);
  }
}
async function resolveWorkDirectory(deps, path, roots = rootsOf(deps.projectDirectory, deps.allowedRoots), create = false) {
  const real = await resolveLaptopPath(path, roots, create ? { create: true } : {});
  const info = await stat2(real).catch(() => void 0);
  if (info?.isDirectory()) return real;
  if (!info && create) {
    await mkdir2(real, { recursive: true, mode: 448 });
    return real;
  }
  throw boxdError("NAME_INVALID", `The local directory "${path}" does not exist.`);
}
async function readIncoming(deps, files2) {
  const roots = rootsOf(deps.projectDirectory, deps.allowedRoots);
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const file of files2) {
    const path = assertWorkPath(file.to);
    if (seen.has(path)) throw boxdError("NAME_INVALID", `Two files copy to "${path}".`);
    seen.add(path);
    const loaded = await loadFile(file.from, roots);
    out.push({ path, body: loaded.body, bytes: loaded.bytes, sha256: loaded.sha256 });
  }
  assertTotal(out);
  return out;
}
async function uploadAll(deps, work, files2) {
  const moved = [];
  for (const file of files2) {
    await deps.guest.upload(work.machine, work.guestDirectory, file.path, file.body).catch((error) => {
      throw boxdError("GUEST_FAILED", `The machine refused the upload of ${file.path} (${reasonOf(error)}).`);
    });
    moved.push({ path: file.path, bytes: file.bytes, sha256: file.sha256, at: deps.now() });
  }
  if (moved.length) await deps.ledger.mutate(work.workId, (current) => ({ ...current ?? work, uploads: mergeFiles(current?.uploads, moved) }));
  return moved;
}
async function downloadAll(deps, work, paths, toDirectory) {
  const roots = rootsOf(deps.projectDirectory, deps.allowedRoots);
  const moved = [];
  let total = 0;
  for (const path of paths) {
    const body = await deps.guest.download(work.machine, work.guestDirectory, path).catch((error) => {
      throw boxdError("GUEST_FAILED", `The machine refused the download of ${path} (${reasonOf(error)}).`);
    });
    if (body.byteLength > FILE_LIMIT) throw boxdError("FILE_TOO_LARGE", `"${path}" is ${body.byteLength} bytes; the limit is ${FILE_LIMIT}.`);
    total += body.byteLength;
    if (total > TOTAL_LIMIT) throw boxdError("FILE_TOO_LARGE", `The files total ${total} bytes; the limit is ${TOTAL_LIMIT}.`);
    const target = await resolveLaptopPath(join2(toDirectory, path), roots, { create: true });
    const previous = work.downloads?.filter((file) => file.path === path).at(-1)?.sha256;
    await storeFile(target, body, previous);
    moved.push({ path, bytes: body.byteLength, sha256: sha256(body), at: deps.now(), laptopPath: target });
  }
  return moved;
}
function mergeFiles(existing, moved) {
  const replaced = new Set(moved.map((file) => file.path));
  return [...(existing ?? []).filter((file) => !replaced.has(file.path)), ...moved];
}
function jobNext(workId, phase, run2) {
  if (phase === "busy") return "Call boxd_job again in a later turn.";
  if (run2.outcome === "failed") return `${failureText(run2, workId)} ${nextStepFor(run2)}`;
  if (run2.outcome === "aborted") return `The last run of ${workId} was aborted. Call boxd_harvest before sleep, image or drop, then boxd_submit again if you still need it.`;
  return "Call boxd_harvest before sleep, image or drop.";
}
function refuseUnsafe(machine) {
  if (machine.status === "missing") return;
  if (machine.sharing === "shared") throw boxdError("MACHINE_SHARED", `Machine ${machine.name} is shared, and sharing deletes OpenCode's sign-in.`);
  if (machine.isolated) throw boxdError("MACHINE_ISOLATED", `Machine ${machine.name} is isolated, so it has no git integration and no in-VM boxd.`);
}
function proofState(work) {
  if (!work.proof) return "missing";
  if (work.lastSubmitAt && work.proof.harvestedAt < work.lastSubmitAt) return "stale";
  return "fresh";
}
function addWarning(warnings, warning) {
  const rest = (warnings ?? []).filter((item) => item.code !== warning.code);
  return [...rest, warning];
}
function dropAdvice(git, proof) {
  if (proof !== "fresh") return "Call boxd_harvest again before drop.";
  if (!git || !git.known) return "The guest directory is not a git repository, so boxd_drop will refuse. Hibernate instead, or make it one.";
  if (git.untracked.length) return `Commit or delete ${list(git.untracked)} on the machine, then harvest again. boxd_drop will refuse until you do.`;
  if (git.ignored.length) return `Remove ${list(git.ignored)} on the machine, then harvest again. boxd_drop will refuse until you do.`;
  if (git.dirty) {
    return git.patchStored ? "The uncommitted change is stored as a patch on this laptop. Call boxd_sleep to hibernate, or boxd_drop, which keeps the patch and then destroys the machine." : "The uncommitted work has no patch on this laptop, so boxd_drop will refuse. Commit it on the machine, harvest again, or hibernate instead.";
  }
  return "Call boxd_sleep to hibernate, or boxd_drop: the import is proven and the tree is clean.";
}
var list = (names) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
async function requireDroppable(deps, work) {
  const proof = proofState(work);
  if (proof !== "fresh") throw boxdError("NOT_PROVEN", proof === "missing" ? "No proven export is on this laptop." : "The laptop export is older than the last prompt.");
  const git = work.git;
  if (!git || !git.known) throw boxdError("GIT_UNKNOWN", "The guest directory is not a git repository, so its files cannot be accounted for.");
  const recovered = await recoveredPaths(deps, work, git);
  const lostUntracked = git.untracked.filter((path) => !recovered.has(path));
  const lostIgnored = git.ignored.filter((path) => !recovered.has(path));
  if (lostUntracked.length) throw boxdError("UNTRACKED", `The guest tree has untracked paths the patch cannot hold: ${list(lostUntracked)}.`);
  if (lostIgnored.length) throw boxdError("UNTRACKED", `The guest tree has ignored paths the patch cannot hold: ${list(lostIgnored)}.`);
  if (git.dirty && !git.patchStored) throw boxdError("DIRTY", "The guest tree has uncommitted work and no patch in the ledger.");
}
async function recoveredPaths(deps, work, git) {
  const recorded = /* @__PURE__ */ new Map();
  for (const file of work.downloads ?? []) recorded.set(file.path, file.sha256);
  const candidates = [...git.untracked, ...git.ignored].filter((path) => recorded.has(path));
  if (!candidates.length) return /* @__PURE__ */ new Set();
  const digests = await deps.guest.digest(work.machine, work.guestDirectory, candidates).catch(() => ({}));
  return new Set(candidates.filter((path) => digests[path] !== void 0 && digests[path] === recorded.get(path)));
}
function collect(root, listed) {
  const children = /* @__PURE__ */ new Map();
  for (const session of listed) {
    if (!session.parentID) continue;
    const group = children.get(session.parentID) ?? [];
    group.push(session.id);
    children.set(session.parentID, group);
  }
  const ids = [];
  const seen = /* @__PURE__ */ new Set();
  const walk = (id) => {
    if (seen.has(id)) throw boxdError("EXPORT_INVALID", `The session tree names ${id} twice, so it has a cycle.`);
    seen.add(id);
    ids.push(id);
    for (const child of children.get(id) ?? []) walk(child);
  };
  walk(root);
  return ids;
}
async function harvestGit(deps, work) {
  const git = await deps.guest.git(work.machine, work.guestDirectory);
  const patchStored = Boolean(git.known && (git.dirty || git.untracked.length) && git.patch);
  if (patchStored && git.patch) await deps.ledger.savePatch(work.workId, git.patch);
  const untrackedStored = Boolean(Object.keys(git.untrackedFiles).length);
  if (untrackedStored) await deps.ledger.saveUntracked(work.workId, git.untrackedFiles);
  return {
    known: git.known,
    remote: git.remote,
    branch: git.branch,
    sha: git.sha,
    dirty: git.dirty,
    patchStored,
    untracked: git.untracked,
    ignored: git.ignored,
    untrackedStored
  };
}

// src/ledger.ts
import { randomUUID } from "node:crypto";
import { mkdir as mkdir3, readFile as readFile3, readdir, rename as rename2, unlink as unlink2, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2, join as join3 } from "node:path";
var PRIVATE_DIR = 448;
var PRIVATE_FILE = 384;
var Ledger = class {
  root;
  /** One promise chain per work id: the writes to one work run in the order they were asked for. */
  queues = /* @__PURE__ */ new Map();
  constructor(root) {
    this.root = root;
  }
  async load(workId) {
    try {
      return JSON.parse(await readFile3(this.workPath(workId), "utf8"));
    } catch (error) {
      if (codeOf(error) === "ENOENT") return void 0;
      throw ledgerError("read", workId, error);
    }
  }
  /** Writes the whole work atomically. The caller holds the fields it loaded; prefer `mutate`. */
  async save(work) {
    await this.exclusive(work.workId, () => this.writeWork(work));
  }
  /**
   * Reads, changes and writes one work under its lock, so a concurrent writer cannot lose this change. The recipe gets
   * the work as it is now, and its result is what is stored. A failing recipe writes nothing.
   */
  async mutate(workId, recipe) {
    return this.exclusive(workId, async () => {
      const next = recipe(await this.load(workId));
      await this.writeWork(next);
      return next;
    });
  }
  async saveExport(workId, remoteId, transfer) {
    await this.exclusive(workId, () => this.writeJson(this.exportPath(workId, remoteId), transfer, workId));
  }
  async loadExport(workId, remoteId) {
    try {
      return JSON.parse(await readFile3(this.exportPath(workId, remoteId), "utf8"));
    } catch (error) {
      throw ledgerError("read", workId, error);
    }
  }
  async savePatch(workId, patch) {
    await this.exclusive(workId, async () => {
      const path = join3(this.dir(workId), "patch.diff");
      await mkdir3(dirname2(path), { recursive: true, mode: PRIVATE_DIR });
      await this.writeAtomic(path, patch, workId);
    });
  }
  /** The untracked files a harvest captured: a JSON map of path to base64 content, beside the patch. */
  async saveUntracked(workId, files2) {
    await this.exclusive(workId, () => this.writeJson(join3(this.dir(workId), "untracked.json"), files2, workId));
  }
  async list() {
    let names;
    try {
      names = await readdir(join3(this.root, "works"));
    } catch (error) {
      if (codeOf(error) === "ENOENT") return [];
      throw ledgerError("list", "works", error);
    }
    const works = await Promise.all(names.map((name) => this.load(name)));
    return works.filter((work) => work !== void 0 && !work.dropped);
  }
  /** Runs `task` after every earlier task for this work, whatever their outcome, and returns its result. */
  exclusive(workId, task) {
    const previous = this.queues.get(workId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(
      workId,
      next.then(
        () => void 0,
        () => void 0
      )
    );
    return next;
  }
  async writeWork(work) {
    await this.writeJson(this.workPath(work.workId), work, work.workId);
  }
  async writeJson(path, value, workId) {
    await mkdir3(dirname2(path), { recursive: true, mode: PRIVATE_DIR });
    await this.writeAtomic(path, `${JSON.stringify(value, null, 2)}
`, workId);
  }
  /** A unique temp file in the same directory, then a rename: a reader never sees half a file, and two writers never share a name. */
  async writeAtomic(path, text2, workId) {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile2(temp, text2, { mode: PRIVATE_FILE });
      await rename2(temp, path);
    } catch (error) {
      await unlink2(temp).catch(() => void 0);
      throw ledgerError("write", workId, error);
    }
  }
  dir(workId) {
    return join3(this.root, "works", workId);
  }
  workPath(workId) {
    return join3(this.dir(workId), "work.json");
  }
  exportPath(workId, remoteId) {
    return join3(this.dir(workId), "exports", `${remoteId}.json`);
  }
};
var codeOf = (error) => error?.code;
var ledgerError = (action, workId, error) => {
  const reason = error instanceof Error ? error.message : String(error);
  throw boxdError("LEDGER_FAILED", `The ledger could not ${action} work "${workId}" (${reason.slice(0, 160)}).`);
};

// src/tools.ts
var object = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});
var WORK2 = { type: "string", description: 'A short lowercase work id, such as "review-api". The machine is named oc-<id>.' };
var DIRECTORY2 = {
  type: "string",
  description: "A laptop folder for the work, inside the project or an allowed root. The guest always works in /home/boxd/work/<work id>."
};
var REPO2 = { type: "string", description: "An https://github.com/owner/repo URL to clone on the machine, if the directory is not a checkout already." };
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
var SNAPSHOT2 = { type: "string", description: "A new lowercase snapshot name. Snapshots are immutable." };
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
    input: object({ workId: WORK2 }, ["workId"]),
    run: (fleet, input) => fleet.job({ workId: text(input, "workId", "workId") })
  },
  {
    name: "ensure",
    id: "boxd_ensure",
    class: "write",
    description: "Get a private machine from the golden snapshot for a work id, and record the work. The guest works in /home/boxd/work/<work id>. Returns starting when it is not up yet. It does not wait.",
    input: object({ workId: WORK2, directory: DIRECTORY2, repo: REPO2, title: TITLE }, ["workId"]),
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
    input: object({ workId: WORK2, text: TEXT, title: TITLE, files: FILES_IN }, ["workId", "text"]),
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
    input: object({ workId: WORK2, localDirectory: LOCAL, files: FILES_OUT, to: LOCAL }, ["workId"]),
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
    input: object({ workId: WORK2 }, ["workId"]),
    run: (fleet, input) => fleet.sleep({ workId: text(input, "workId", "workId") })
  },
  {
    name: "resume",
    id: "boxd_resume",
    class: "write",
    description: "Wake a hibernated machine, or rebuild a destroyed one from the golden snapshot and the proven transcript.",
    input: object({ workId: WORK2 }, ["workId"]),
    run: (fleet, input) => fleet.resume({ workId: text(input, "workId", "workId") })
  },
  {
    name: "image",
    id: "boxd_image",
    class: "write",
    description: "Save a new immutable snapshot of a machine this plugin owns. Refuses if any work on that machine lacks a fresh export. Not a session backup.",
    input: object({ machine: MACHINE, name: SNAPSHOT2 }, ["machine", "name"]),
    run: (fleet, input) => fleet.image({ machine: text(input, "machine", "machine"), name: text(input, "name", "name") })
  },
  {
    name: "drop",
    id: "boxd_drop",
    class: "destructive",
    description: "Destroy the machine and close the work. Refuses unless the laptop import is fresh, the guest is a git repository, and every untracked or ignored path was harvested at the digest the guest still has.",
    input: object({ workId: WORK2 }, ["workId"]),
    run: (fleet, input) => fleet.drop({ workId: text(input, "workId", "workId") })
  }
];
var toolSpec = (name) => TOOLS.find((tool) => tool.name === name);
var READ_TOOLS = TOOLS.filter((tool) => tool.class === "read").map((tool) => tool.id);
var CHANGING_TOOLS = TOOLS.filter((tool) => tool.class !== "read").map((tool) => tool.id);
async function runTool(name, fleet, input) {
  try {
    const output = await toolSpec(name).run(fleet, input);
    return { output, text: JSON.stringify(output) };
  } catch (error) {
    if (error instanceof BoxdError) return { output: { error: error.code, next: error.next }, text: error.message };
    throw error;
  }
}
function toolTransform(fleet, assert) {
  return (editor) => {
    editor.namespace({ name: NAMESPACE, description: "Run an OpenCode session on a private boxd machine and keep the transcript on this laptop" });
    for (const spec of TOOLS) {
      editor.add({
        // The namespace prefixes the tool's id: `status` becomes `boxd_status`.
        name: spec.name,
        description: spec.description,
        input: spec.input,
        output: { type: "object" },
        options: { namespace: NAMESPACE, permission: spec.id },
        execute: async (value, context) => {
          const input = value ?? {};
          await assertTool(assert, spec, input, {
            sessionID: context.sessionID,
            agent: context.agent,
            messageID: context.messageID,
            id: context.id
          });
          const answer = await runTool(spec.name, fleet, input);
          return { output: answer.output, content: answer.text };
        }
      });
    }
  };
}
async function assertTool(assert, spec, input, call) {
  if (spec.class === "read") return;
  const work = typeof input.workId === "string" ? input.workId : typeof input.machine === "string" ? input.machine : "";
  await assert({
    sessionID: call.sessionID,
    agent: call.agent,
    action: spec.id,
    resources: work ? [work] : ["*"],
    source: { type: "tool", messageID: call.messageID, id: call.id }
  });
}
function ownedMethods(fleet, assert) {
  return TOOLS.map((spec) => ({
    kind: "plugin",
    class: spec.class,
    name: spec.id,
    action: spec.id,
    description: spec.description,
    input: spec.input,
    output: { type: "object" },
    run: async (value, call) => {
      const input = value ?? {};
      await assertTool(assert, spec, input, { sessionID: call.sessionID, agent: call.agent, messageID: call.messageID, id: call.id });
      return (await runTool(spec.name, fleet, input)).output;
    }
  }));
}

// src/permissions.ts
var ACCESS_VALUES = ["all", "ask-changes", "read-only"];
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
var same = (a, b) => a.action === b.action && a.resource === b.resource && a.effect === b.effect;
var BASE_ALLOW = { action: "*", resource: "*", effect: "allow" };
function hasDefaultRules(permissions, access = "all") {
  const base = permissions.findIndex((item) => same(item, BASE_ALLOW));
  if (base === -1) return false;
  const rules = defaultRules(access);
  return permissions.some((_, start) => start > base && rules.every((item, offset) => permissions[start + offset] !== void 0 && same(permissions[start + offset], item)));
}
function insertRules(permissions, rules, access = "all") {
  if (hasDefaultRules(permissions, access)) return false;
  const base = permissions.findIndex((item) => same(item, BASE_ALLOW));
  if (base === -1) return false;
  for (const value of ACCESS_VALUES) {
    if (value === access) continue;
    const stale = defaultRules(value);
    for (let start = 0; start + stale.length <= permissions.length; start += 1) {
      if (stale.every((item, offset) => same(permissions[start + offset], item))) {
        permissions.splice(start, stale.length);
        return insertRules(permissions, rules, access);
      }
    }
  }
  permissions.splice(base + 1, 0, ...rules.map((item) => ({ ...item })));
  return true;
}
function registerDefaultRules(agent, rules, report, access = "all") {
  return agent.transform((editor) => {
    try {
      for (const { id } of editor.list()) editor.update(id, (info) => void insertRules(info.permissions, rules, access));
      report(void 0);
    } catch (error) {
      report(`RULES_NOT_ADDED: boxd's default permission rules could not be added (${reasonOf(error)}), so a tool may run without asking. Next step: Restart OpenCode.`);
    }
  });
}
var wildcard = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
function evaluate(permissions, action) {
  return permissions.findLast((item) => wildcard(item.action).test(action) && wildcard(item.resource).test("*"))?.effect ?? "ask";
}
var unguardedAgents = (agents, access = "all") => agents.filter((agent) => agent.permissions.some((item) => same(item, BASE_ALLOW)) && !hasDefaultRules(agent.permissions, access) && evaluate(agent.permissions, "boxd_new_tool") === "allow").map((agent) => agent.id);

// src/options.ts
var EXAMPLE = `"plugins": [{ "package": "github:joe-broadhead/opencode-boxd#v0.0.0", "options": { "snapshot": "opencode-golden" } }]`;
var ACCEPTED = {
  snapshot: "a lowercase boxd snapshot name (opencode-golden by default)",
  allowUntestedHost: "true or false (the default)",
  access: '"all" (the default), "ask-changes" or "read-only"',
  allowedRoots: "an array of absolute laptop folders that work files may use besides the project (empty by default)"
};
var invalid2 = (problem) => boxdError("OPTIONS_INVALID", `${problem}. Fix the plugin options, for example ${EXAMPLE}`);
function parseOptions(raw) {
  if (raw === void 0 || raw === null) return { snapshot: assertSnapshot("opencode-golden"), allowUntestedHost: false, access: "all", allowedRoots: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid2(`The plugin options must be an object, found ${describe(raw)}`);
  const input = raw;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(ACCEPTED, key)) throw invalid2(`Unknown option "${key}". Accepted options: ${Object.keys(ACCEPTED).map((name) => `"${name}"`).join(", ")}`);
  }
  const { snapshot = "opencode-golden", allowUntestedHost = false, access = "all", allowedRoots = [] } = input;
  if (typeof allowUntestedHost !== "boolean") throw invalid2(`The option "allowUntestedHost" must be ${ACCEPTED.allowUntestedHost}, found ${describe(allowUntestedHost)}`);
  if (typeof snapshot !== "string") throw invalid2(`The option "snapshot" must be ${ACCEPTED.snapshot}, found ${describe(snapshot)}`);
  try {
    assertSnapshot(snapshot);
  } catch {
    throw invalid2(`The option "snapshot" must be ${ACCEPTED.snapshot}, found ${describe(snapshot)}`);
  }
  if (typeof access !== "string" || !ACCESS_VALUES.includes(access)) throw invalid2(`The option "access" must be ${ACCEPTED.access}, found ${describe(access)}`);
  if (!Array.isArray(allowedRoots) || allowedRoots.some((root) => typeof root !== "string" || !root.startsWith("/"))) {
    throw invalid2(`The option "allowedRoots" must be ${ACCEPTED.allowedRoots}, found ${describe(allowedRoots)}`);
  }
  return { snapshot, allowUntestedHost, access, allowedRoots };
}
var describe = (value) => value === null ? "null" : Array.isArray(value) ? "an array" : typeof value === "string" ? JSON.stringify(value) : typeof value === "object" ? "an object" : String(value);

// src/prover.ts
import { mkdtemp, rm, writeFile as writeFile3 } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join4 } from "node:path";
function cliProver(bin = "opencode") {
  return {
    async importTransfer(transfer, directory) {
      const dir = await mkdtemp(join4(tmpdir(), "opencode-boxd-"));
      try {
        const file = join4(dir, "export.json");
        await writeFile3(file, JSON.stringify(transfer));
        const result = await run(bin, ["session", "import", file, "--directory", directory, "--standalone"], { timeoutMs: 12e4 });
        const text2 = `${result.stdout}
${result.stderr}`;
        if (result.code === 0 && /Session already exists/i.test(text2)) return { id: transfer.info.id };
        if (result.code !== 0) throw boxdError("NOT_PROVEN", `The laptop's import failed: ${firstLine(text2)}.`);
        const id = /ses_[A-Za-z0-9_-]+/.exec(text2)?.[0];
        if (!id) throw boxdError("NOT_PROVEN", "The laptop's import printed no session id.");
        return { id };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  };
}
function firstLine(text2) {
  const line = text2.split("\n").map((item) => item.trim()).filter(Boolean)[0] ?? "no output";
  return line.slice(0, 200);
}

// src/skills.ts
import { readFile as readFile4 } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Skill } from "@opencode/plugin";
var ID = "boxd";
var SKILL_NAMES = [ID];
var DEFAULT_DIR = fileURLToPath(new URL("../skills", import.meta.url));
function skillPath(name = ID, directory = DEFAULT_DIR) {
  return fileURLToPath(new URL(`${name}/SKILL.md`, `file://${directory.replace(/\/*$/, "/")}`));
}
function parseSkill(name, path, text2) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text2.replace(/\r\n/g, "\n"));
  if (!match) throw boxdError("SKILLS_INVALID", `${name}'s skill file has no frontmatter.`);
  const fields = /* @__PURE__ */ new Map();
  for (const line of match[1].split("\n")) {
    const field = /^([a-z]+):\s*(.*)$/.exec(line);
    if (field) fields.set(field[1], field[2].trim());
  }
  const declared = fields.get("name");
  const description = fields.get("description");
  if (declared !== name || !description) throw boxdError("SKILLS_INVALID", `The ${name} skill needs the name "${name}" and a description.`);
  return { id: Skill.ID.make(name), name: Skill.Name.make(name), description, path: Skill.Info.fields.path.make(path), content: match[2].trimStart() };
}
async function loadSkills(directory = DEFAULT_DIR) {
  const skills = [];
  const problems = [];
  for (const name of SKILL_NAMES) {
    const path = skillPath(name, directory);
    try {
      const text2 = await readFile4(path, "utf8").catch(() => {
        throw boxdError("SKILLS_INVALID", `The ${name} skill file is not in the package.`);
      });
      skills.push(parseSkill(name, path, text2));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { skills, problems };
}
function registerSkills(skill, skills) {
  return skill.transform((editor) => {
    for (const info of skills) {
      editor.add({ id: info.id, name: info.name, description: info.description, path: info.path, content: info.content, autoinvoke: true });
    }
  });
}

// src/version.ts
var VERSION = "0.0.0";

// src/status.ts
var agentRules = (access) => defaultRules(access).map((rule2, index, rules) => `  ${JSON.stringify(rule2)}${index < rules.length - 1 ? "," : ""}`).join("\n");
var AGENTS_NEXT_STEP = "Put the default rules shown by /boxd-status first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for boxd tools.";
var NOTHING_TO_DO = "Nothing to do.";
var LISTED_UNKNOWN = 20;
var SAFE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
var STATUS_LIMIT = 160;
var CLASS_OF = new Map(TOOLS.map((tool) => [tool.id, tool.class]));
var RULES_NOT_ADDED = "RULES_NOT_ADDED:";
function buildStatus(facts) {
  const state = facts.ledgerError ? "failed" : "connected";
  const listed = facts.tools ?? [];
  const unknown = listed.filter((name) => !CLASS_OF.has(name));
  const works = facts.ledger?.works ?? [];
  const unharvested = works.filter((work) => work.proof !== "fresh").map((work) => work.workId);
  const warned = works.filter((work) => work.warnings.length > 0).map((work) => work.workId);
  const failedRuns = works.filter((work) => work.outcome === "failed").map((work) => ({ workId: work.workId, ...work.error ? { error: work.error } : {} }));
  const status = {
    version: VERSION,
    state,
    ...facts.ledgerError ? { error: cut(shortReason(facts.ledgerError) ?? "no reason given", STATUS_LIMIT) } : {},
    access: facts.access,
    host: facts.host,
    snapshot: facts.snapshot,
    snapshotPresent: facts.ledger?.snapshotPresent ?? null,
    guestVersion: facts.guestVersion,
    works,
    openWorks: works.length,
    unharvested,
    orphans: facts.ledger?.orphans ?? [],
    warned,
    failedRuns,
    tools: listed.length,
    unknownCount: unknown.length,
    unknownTools: unknown.filter((name) => SAFE_NAME.test(name)).slice(0, LISTED_UNKNOWN),
    unguardedAgents: unguardedAgents(facts.agents ?? [], facts.access),
    problems: facts.problems ?? []
  };
  return { ...status, nextStep: nextStepOf(status) };
}
function nextStepOf(status) {
  if (status.state === "failed") return "Restart OpenCode, then run /boxd-status again.";
  if (status.snapshotPresent === false) {
    return `Create the golden image named "${status.snapshot}" as docs/golden-image.md describes, then set the snapshot option to it.`;
  }
  const rules = status.problems.find((problem2) => problem2.startsWith(RULES_NOT_ADDED));
  if (rules) return rules.split(" Next step: ")[1] ?? AGENTS_NEXT_STEP;
  if (status.unguardedAgents.length) return AGENTS_NEXT_STEP;
  if (status.failedRuns.length) {
    const first = status.failedRuns[0];
    const run2 = { outcome: "failed", ...first.error ? { error: first.error } : {} };
    const more = status.failedRuns.length > 1 ? ` ${status.failedRuns.length - 1} more ${status.failedRuns.length === 2 ? "work has" : "works have"} a failed run too.` : "";
    return `${failureText(run2, first.workId)} ${nextStepFor(run2)}${more}`;
  }
  if (status.orphans.length) {
    return `Call boxd_ensure for the work id ${status.orphans.length === 1 ? "named" : "named"} by ${list2(status.orphans.map((name) => name.replace(/^oc-/, "")))} to adopt ${status.orphans.length === 1 ? "a machine" : "machines"} no ledger records, or remove them with the boxd CLI.`;
  }
  if (status.warned.length) {
    return `Call boxd_resume and then boxd_harvest for ${list2(status.warned)}: it was hibernated before its last prompt was harvested.`;
  }
  if (status.unharvested.length) {
    const names = list2(status.unharvested);
    return `Call boxd_harvest for ${names}: sleep, image and drop refuse without a fresh import on this laptop.`;
  }
  const problem = status.problems[0]?.split(" Next step: ")[1];
  return problem ?? NOTHING_TO_DO;
}
var list2 = (names) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
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
  const unowned = orphans.length ? `; machines no ledger records: ${list2(orphans)}` : "";
  if (openWorks === 0) return `no open work${unowned}`;
  const machines = works.map((work) => `${work.workId} (${work.machineStatus ?? "state unknown"}${outcomeText(work.outcome)}${work.outcome === "failed" && work.error ? `: ${work.error}` : ""})`).join(", ");
  const stale = unharvested.length ? `; no fresh laptop import: ${list2(unharvested)}` : "; every work has a fresh laptop import";
  const asleep = warned.length ? `; hibernated before a harvest: ${list2(warned)}` : "";
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
  const connection2 = status.state === "failed" ? `failed (${status.error ?? "no reason given"})` : `connected (the ledger is readable; ${status.openWorks} open ${status.openWorks === 1 ? "work" : "works"})`;
  return [
    `${DISPLAY_NAME} status`,
    `- Connection: ${connection2}`,
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
async function readStatus(ctx, facts) {
  const [agents, tools, ledger] = await Promise.all([
    ctx.agent.list(),
    ctx.tool.list(),
    facts.ledger().then(
      (value) => ({ value }),
      (error) => ({ error: shortReason(error instanceof Error ? error.message : String(error)) ?? "no reason given" })
    )
  ]);
  return buildStatus({
    access: facts.access,
    host: facts.host,
    snapshot: facts.snapshot,
    guestVersion: facts.guestVersion,
    ...facts.problems ? { problems: facts.problems } : {},
    ..."value" in ledger ? { ledger: ledger.value } : { ledgerError: ledger.error },
    tools: tools.filter((tool) => tool.options?.namespace === "boxd").map((tool) => tool.id),
    agents: agents.data
  });
}
function unavailable(error) {
  const reason = shortReason(error instanceof Error ? error.message : String(error));
  return { message: `STATUS_UNAVAILABLE: Could not read boxd's status${reason ? ` (${reason})` : ""}.`, nextStep: "Restart OpenCode, then run /boxd-status again." };
}
var strings2 = { type: "array", items: { type: "string" } };
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
                warnings: strings2,
                outcome: { type: ["string", "null"], enum: ["completed", "failed", "aborted", null] },
                error: { type: "string" }
              }
            }
          },
          openWorks: count,
          unharvested: strings2,
          orphans: strings2,
          warned: strings2,
          failedRuns: {
            type: "array",
            items: { type: "object", required: ["workId"], properties: { workId: { type: "string" }, error: { type: "string" } } }
          },
          tools: count,
          unknownCount: count,
          unknownTools: strings2,
          unguardedAgents: strings2,
          problems: strings2,
          nextStep: { type: "string" }
        }
      },
      errors: { unavailable: { type: "object", required: ["nextStep"], properties: { nextStep: { type: "string" } } } }
    }
  },
  events: {}
};
function registerStatusRpc(rpc, read) {
  return rpc.register(StatusRpc, {
    status: (_input, { error }) => read().catch((cause) => {
      const { message, nextStep } = unavailable(cause);
      return error("unavailable", message, { nextStep });
    })
  });
}
function registerStatusCommand(ctx, read) {
  return ctx.command.transform(
    (editor) => editor.add({
      name: `${COMMAND_STEM}-status`,
      description: "Show boxd's ledger, machines, permission posture and the next step",
      execute: async ({ sessionID }) => {
        const text2 = await read().then(formatStatus, (cause) => {
          const { message, nextStep } = unavailable(cause);
          return `${message} Next step: ${nextStep}`;
        });
        await ctx.session.synthetic({ sessionID, text: text2, description: "boxd status", resume: false });
      }
    })
  );
}

// src/host/tools-rpc.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { Rpc } from "@opencode/plugin/rpc";
var PLUGIN_ID2 = PLUGIN_ID;
function shapeInput(_method, input, _call) {
  return input;
}
function shapeResult(_method, result, _call) {
  return result;
}
var NEXT_STEPS = {
  SESSION_UNKNOWN: `Create a session in the location you mean, such as POST /api/session with {"agent":"build"} sent with the header "x-opencode-directory: <dir>" or the location[directory] query, and pass its id.`,
  SESSION_AGENT_REQUIRED: `Create a session that names an agent this project has, with its project as the location, such as POST /api/session with {"agent":"build","location":{"directory":"/path/to/project"}}, and pass its id.`,
  PERMISSION_DENIED: "A script cannot answer an approval prompt: add an allow rule for the method to the session's agent, then call it again.",
  SERVER_CONFLICT: `Remove your own server from opencode.json so that the plugin manages it, then run "opencode reload".`,
  AUTH_REQUIRED: "Run /connect and choose the plugin's account to connect it.",
  CONNECTING: "Wait a few seconds, then call the method again.",
  CONNECTION_FAILED: "Run /boxd-status and follow its next step.",
  DISABLED: `Enable the plugin's server in /mcps, or remove "disabled": true from its entry in opencode.json.`,
  NOT_REGISTERED: "Run /boxd-status and follow its next step.",
  TOOL_UNAVAILABLE: "Call describe to see which methods OpenCode lists now, and run /boxd-status.",
  UPSTREAM_ERROR: "Check the input against the method's schema from describe, and run /boxd-status if it keeps failing.",
  CANCELLED: "Call the method again if you still need the result."
};
function pluginError(error) {
  if (!(error instanceof Error)) return void 0;
  const { code, next } = error;
  if (typeof code !== "string" || typeof next !== "string") return void 0;
  const message = error.message.startsWith(`${code}: `) ? error.message.slice(code.length + 2) : error.message;
  const what = message.split(" Next step: ")[0] ?? message;
  return { code, what: what.replace(/[.\s]+$/, ""), next };
}
var TOOLS_RPC_ID = `${PLUGIN_ID2}.tools`;
var CLASSES = ["read", "write", "send", "export", "destructive"];
var MCP_ONLY = ["SERVER_CONFLICT", "AUTH_REQUIRED", "CONNECTING", "CONNECTION_FAILED", "DISABLED", "NOT_REGISTERED", "TOOL_UNAVAILABLE", "UPSTREAM_ERROR"];
var UNATTENDED = "A script cannot answer an approval prompt; this needs an allow rule for the session's agent.";
var MESSAGE_ID = "msg_script";
var UPSTREAM_LIMIT = 300;
var LOCATION_HEADER = "x-opencode-directory";
var LOCATION_HINT = `Send the call to the location you mean: run it in that project with "opencode api ... -H \\"${LOCATION_HEADER}:$PWD\\"", or pass the location[directory] query parameter to the HTTP request.`;
var object2 = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});
var STRING = { type: "string" };
var ANY_OBJECT = { type: "object" };
var FAILED = object2({ code: STRING, next: STRING }, ["code", "next"]);
var mcpOutput = (output = {}) => object2({ output, text: STRING }, ["text"]);
var DESCRIBED = object2(
  {
    name: STRING,
    tool: STRING,
    kind: { type: "string", enum: ["mcp", "plugin"] },
    class: { type: "string", enum: [...CLASSES] },
    action: STRING,
    description: STRING,
    available: { type: "boolean" },
    reason: STRING,
    detail: STRING,
    permission: { type: "string", enum: ["allow", "ask", "deny"] },
    input: ANY_OBJECT,
    output: ANY_OBJECT
  },
  ["name", "tool", "kind", "class", "action", "description", "available", "input", "output"]
);
var DESCRIPTION = object2(
  {
    id: STRING,
    call: STRING,
    location: STRING,
    locationHint: STRING,
    methods: { type: "array", items: DESCRIBED },
    unclassified: { type: "array", items: STRING }
  },
  ["id", "call", "location", "locationHint", "methods"]
);
var plainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var ENVELOPE_MESSAGES = {
  notObject: `the envelope must be an object, such as {"sessionID":"<session>","input":<the tool's input>}`,
  unknownKey: (key) => `"${key}" is not allowed`,
  sessionID: `"sessionID" must be a non-empty string`,
  account: `"account" must be a non-empty string`,
  inputMissing: `"input" is missing`,
  inputNotObject: `"input" must be an object`,
  describe: `describe takes nothing, or {"sessionID":"<session>"}`
};
var standard = (schema, validate) => Object.defineProperty({ ...schema }, "~standard", { value: { version: 1, vendor: "tools-rpc", validate }, enumerable: false });
var DESCRIBE_INPUT = standard(
  object2({ sessionID: { type: "string", minLength: 1 } }, []),
  (value) => {
    if (value === void 0 || value === null) return { value: {} };
    if (!plainObject(value)) return { issues: [{ message: ENVELOPE_MESSAGES.describe }] };
    const issues = [
      ...Object.keys(value).filter((key) => key !== "sessionID").map(ENVELOPE_MESSAGES.unknownKey),
      ...value["sessionID"] === void 0 || typeof value["sessionID"] === "string" && value["sessionID"] !== "" ? [] : [ENVELOPE_MESSAGES.sessionID]
    ];
    return issues.length === 0 ? { value } : { issues: issues.map((message) => ({ message })) };
  }
);
function strict(schema, issues) {
  const keys = Object.keys(schema["properties"]);
  return standard(schema, (value) => {
    if (!plainObject(value)) return { issues: [{ message: ENVELOPE_MESSAGES.notObject }] };
    const found = [...Object.keys(value).filter((key) => !keys.includes(key)).map(ENVELOPE_MESSAGES.unknownKey), ...issues(value)];
    return found.length === 0 ? { value } : { issues: found.map((message) => ({ message })) };
  });
}
var ScriptError = class extends Error {
  failure;
  constructor(failure) {
    super(`${failure.code}: ${failure.what.replace(/[.\s]+$/, "")}. Next step: ${failure.next}`);
    this.failure = failure;
  }
};
var fail2 = (code, what) => {
  const next = NEXT_STEPS[code];
  if (next === void 0) throw new Error(`tools-rpc: NEXT_STEPS.${code} is missing`);
  return new ScriptError({ code, what, next });
};
var conflictNext = (server) => NEXT_STEPS.SERVER_CONFLICT ?? `Remove your own "${server}" server from opencode.json so that the plugin manages it, then run "opencode reload".`;
var record = (value) => typeof value === "object" && value !== null;
function notFound(error, tags) {
  if (!record(error)) return false;
  const tag = error["_tag"] ?? error["name"];
  return typeof tag === "string" && tags.includes(tag) || error["status"] === 404 || error["statusCode"] === 404;
}
var toolError = (error) => record(error) && error["_tag"] === "Tool.Error";
var requestAction = (cause) => {
  const request = record(cause) ? cause["request"] : void 0;
  return record(request) && typeof request["action"] === "string" && request["action"] !== "" ? request["action"] : void 0;
};
var deniedAction = (message) => /^Permission denied: ([\w.:-]*[\w-])\.?\s*$/.exec(message.split(/\r?\n/, 1)[0] ?? "")?.[1];
var wildcard2 = (pattern, value) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(value);
var evaluate2 = (rules, action) => rules.findLast((rule2) => wildcard2(rule2.action, action) && wildcard2(rule2.resource, "*"))?.effect ?? "ask";
var hidden = (rules, action) => evaluate2(rules, action) === "deny";
var SECRETS2 = [
  [/\b(bearer|basic|token)\s+[\w.~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b([\w-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|signature|credential)["']?\s*[:=]\s*)["']?[^\s"'&,;]+["']?/gi, "$1[redacted]"],
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g, "[redacted]"],
  [/\b(?:tvly|sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abposr]|lin_api|lin_oauth)[-_][\w-]{8,}/gi, "[redacted]"],
  [/[\w+=-]{40,}/g, "[redacted]"]
];
var withoutQuery = (text2) => text2.replace(/\bhttps?:\/\/[^\s"'<>()]+/gi, (url) => {
  const cut2 = url.search(/[?#]/);
  return cut2 === -1 ? url : `${url.slice(0, cut2)}?[redacted]`;
});
function upstreamText(text2) {
  const line = text2.split(/\r?\n/).find((part) => part.trim() !== "")?.trim() ?? "no message";
  const redacted = SECRETS2.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), withoutQuery(line));
  return redacted.length <= UPSTREAM_LIMIT ? redacted : `${redacted.slice(0, UPSTREAM_LIMIT - 1)}\u2026`;
}
var jsonSchema = (schema) => record(schema) && !("ast" in schema) && !("~standard" in schema) ? schema : void 0;
function normalise(result) {
  const text2 = typeof result.content === "string" ? result.content : (result.content ?? []).flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
  return result.output === void 0 ? { text: text2 } : { output: result.output, text: text2 };
}
function connection(status) {
  switch (status) {
    case "connected":
      return void 0;
    case "pending":
      return "CONNECTING";
    case "needs_auth":
      return "AUTH_REQUIRED";
    case "failed":
      return "CONNECTION_FAILED";
    case "disabled":
      return "DISABLED";
    default:
      return "NOT_REGISTERED";
  }
}
var STATUS_TEXT = {
  CONNECTING: "is still connecting",
  AUTH_REQUIRED: "needs a sign-in",
  CONNECTION_FAILED: "could not connect",
  DISABLED: "is disabled",
  NOT_REGISTERED: "is not registered"
};
async function registerToolsRpc(ctx, options) {
  const { mcp, methods } = options;
  const shapeIn = options.shapers?.input ?? shapeInput;
  const shapeOut = options.shapers?.result ?? shapeResult;
  const accounts = typeof mcp?.server === "function";
  const anyMcp = methods.some((method) => method.kind === "mcp");
  if (anyMcp && !mcp) throw new Error("registerToolsRpc: an MCP method needs the mcp option");
  if (accounts && NEXT_STEPS.ACCOUNT_UNKNOWN === void 0) throw new Error("registerToolsRpc: per-account servers need NEXT_STEPS.ACCOUNT_UNKNOWN");
  const missing2 = anyMcp ? MCP_ONLY.find((code) => code !== "SERVER_CONFLICT" && NEXT_STEPS[code] === void 0) : void 0;
  if (missing2) throw new Error(`registerToolsRpc: MCP methods need NEXT_STEPS.${missing2}`);
  const names = methods.map((method) => method.name);
  const duplicate = names.find((name, index) => name === "describe" || names.indexOf(name) !== index);
  if (duplicate) throw new Error(`registerToolsRpc: the method name "${duplicate}" is taken`);
  for (const method of methods) {
    if (!CLASSES.includes(method.class)) throw new Error(`registerToolsRpc: ${method.name} has the class "${String(method.class)}"; use one of ${CLASSES.join(", ")}`);
    if (method.kind === "plugin" && (typeof method.run !== "function" || method.action === "")) throw new Error(`registerToolsRpc: the plugin method ${method.name} needs a run function and an action`);
  }
  const live = /* @__PURE__ */ new Set();
  const refused2 = /* @__PURE__ */ new Map();
  const serverOf = (account) => {
    const server = typeof mcp.server === "function" ? mcp.server(account) : mcp.server;
    if (server !== void 0) return server;
    throw new ScriptError({ code: "ACCOUNT_UNKNOWN", what: `there is no account '${account}'`, next: NEXT_STEPS.ACCOUNT_UNKNOWN });
  };
  const actionOf = (method, envelope2) => method.kind === "plugin" ? method.action : `${serverOf(envelope2.account)}_${method.name}`;
  const session = async (sessionID) => {
    let info;
    try {
      info = await ctx.session.get({ sessionID });
    } catch (error) {
      if (notFound(error, ["Session.NotFoundError", "SessionNotFoundError"])) throw fail2("SESSION_UNKNOWN", `there is no session '${sessionID}' in this location`);
      throw error;
    }
    if (!info.agent) throw fail2("SESSION_AGENT_REQUIRED", `session '${sessionID}' names no agent`);
    let agent;
    try {
      agent = await ctx.agent.get({ agentID: info.agent });
    } catch (error) {
      const missing3 = notFound(error, ["Agent.NotFoundError", "AgentNotFoundError"]) || error instanceof Error && error.message.startsWith("Agent not found");
      if (missing3) throw fail2("SESSION_AGENT_REQUIRED", `session '${sessionID}' names the agent '${info.agent}', which does not exist in this location`);
      throw error;
    }
    const rules = [...agent.data.permissions, ...info.permissions ?? []];
    return { agent: info.agent, rules };
  };
  const notRegistered = (server) => mcp?.notRegistered?.(server);
  const unavailable2 = async (server, tool, connected) => {
    const status = (await ctx.mcp.list()).data.find((entry) => entry.name === server)?.status.status;
    const code = connection(status) ?? connected;
    if (code === "TOOL_UNAVAILABLE") return fail2(code, `OpenCode does not list ${tool} on the connected "${server}" server`);
    if (status === "connected") return fail2(code, `the "${server}" server was reconnecting when ${tool} ran`);
    const what = `the "${server}" server ${STATUS_TEXT[code] ?? "is unavailable"}`;
    const own = code === "NOT_REGISTERED" ? notRegistered(server) : void 0;
    return own ? new ScriptError({ code: own.code, what, next: own.next }) : fail2(code, what);
  };
  const denyNext = (action, agent) => `Remove or narrow the deny rule for ${action} in the agent "${agent}" or in the session, or add a later allow rule for ${action} to the session, or use a session whose agent allows it.`;
  const denied = (action, error, asked = action) => {
    const reason = upstreamText(record(error) && typeof error["message"] === "string" ? error["message"] : String(error));
    if (asked === action) return fail2("PERMISSION_DENIED", `${action} was refused for this session's agent: ${reason}`);
    return new ScriptError({
      code: "PERMISSION_DENIED",
      what: `${action} needs ${asked}, which was refused for this session's agent: ${reason}`,
      next: `Add an allow rule for ${asked} to the session's agent or to the session, or use a session whose agent allows it.`
    });
  };
  const ruleDenied = (action, error, agent, inner = action) => {
    const reason = upstreamText(record(error) && typeof error["message"] === "string" ? error["message"] : String(error));
    const what = inner === action ? `${action} was refused by a deny rule for this session's agent: ${reason}` : `${action} needs ${inner}, which a deny rule refuses for this session's agent: ${reason}`;
    return new ScriptError({ code: "PERMISSION_DENIED", what, next: denyNext(inner, agent) });
  };
  const resolve2 = (rules, action, agent) => {
    const effect = evaluate2(rules, action);
    if (effect === "allow") return;
    if (effect === "ask")
      throw new ScriptError({
        code: "PERMISSION_DENIED",
        what: `${action} would ask for this session's agent, and a script cannot answer`,
        next: `Add an allow rule for ${action} to the session's agent or to the session, or use a session whose agent allows it.`
      });
    if (hidden(rules, action)) throw new ScriptError({ code: "PERMISSION_DENIED", what: `${action} is hidden from this session's agent by a deny rule`, next: denyNext(action, agent) });
    throw new ScriptError({ code: "PERMISSION_DENIED", what: `${action} is denied for this session's agent`, next: denyNext(action, agent) });
  };
  const mcpTarget = (method, envelope2, action, server) => ({
    action,
    method,
    async run(call) {
      if (!mcp.managed(server)) {
        throw new ScriptError({ code: "SERVER_CONFLICT", what: `the "${server}" server in your config is not the one this plugin manages`, next: conflictNext(server) });
      }
      const tool = (await ctx.tool.list()).find((entry) => entry.id === action);
      if (!tool) throw await unavailable2(server, action, "TOOL_UNAVAILABLE");
      const shaped = shapeIn(method.name, envelope2.input, { sessionID: call.sessionID, agent: call.agent, action });
      let result;
      try {
        result = await tool.execute(shaped, call);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith(`MCP server "${server}" `)) throw await unavailable2(server, action, "CONNECTING");
        throw error;
      }
      const shapedResult = shapeOut(method.name, normalise(result), { sessionID: call.sessionID, agent: call.agent, action });
      return shapedResult;
    }
  });
  const pluginTarget = (method, envelope2, action) => {
    if (accounts) serverOf(envelope2.account);
    const account = accounts && envelope2.account !== void 0 ? { account: envelope2.account } : {};
    return {
      action,
      method,
      run: async (call) => await method.run(envelope2.input, { ...call, ...account }) ?? null
    };
  };
  const targetOf = (method, envelope2) => {
    const action = actionOf(method, envelope2);
    if (method.kind === "plugin") return pluginTarget(method, envelope2, action);
    return mcpTarget(method, envelope2, action, serverOf(envelope2.account));
  };
  const invoke = async (method, raw, context) => {
    const envelope2 = raw;
    let target;
    let id;
    let agent;
    try {
      if (context.signal.aborted) throw fail2("CANCELLED", "the call was cancelled");
      target = targetOf(method, envelope2);
      const resolved = await session(envelope2.sessionID);
      agent = resolved.agent;
      resolve2(resolved.rules, target.action, agent);
      id = `script:${randomUUID2()}`;
      const call = {
        sessionID: envelope2.sessionID,
        agent,
        messageID: MESSAGE_ID,
        id,
        signal: context.signal,
        progress: async () => {
        }
      };
      live.add(call.id);
      try {
        return JSON.parse(JSON.stringify(await target.run(call)));
      } finally {
        live.delete(call.id);
      }
    } catch (error) {
      const failure = refusal(error, target, context.signal, agent, id === void 0 ? void 0 : refused2.get(id));
      if (!failure) throw error;
      return context.error("failed", new ScriptError(failure).message, { code: failure.code, next: failure.next });
    } finally {
      if (id !== void 0) refused2.delete(id);
    }
  };
  const refusal = (error, target, signal, agent, seen) => {
    if (signal.aborted) return fail2("CANCELLED", "the call was cancelled").failure;
    if (error instanceof ScriptError) return error.failure;
    const own = pluginError(error);
    if (own || !target || !toolError(error)) return own;
    if (error.error !== void 0) {
      const request = requestAction(error.error);
      if (seen?.effect === "ask" || request !== void 0 || agent === void 0) return denied(target.action, error, request ?? seen?.action).failure;
      return ruleDenied(target.action, error, agent, seen?.action ?? deniedAction(error.message) ?? target.action).failure;
    }
    if (target.method.kind === "mcp") return fail2("UPSTREAM_ERROR", `${target.action} failed: ${upstreamText(error.message)}`).failure;
    return void 0;
  };
  const unclassified = async (tools) => {
    const server = serverOf(void 0);
    const prefix = `${server}_`;
    const known = new Set(methods.filter((method) => method.kind === "mcp").map((method) => method.name));
    const owned = new Set(methods.filter((method) => method.kind === "plugin").flatMap((method) => [method.name, method.action]));
    return tools.filter((tool) => tool.id.startsWith(prefix) && !known.has(tool.id.slice(prefix.length)) && !owned.has(tool.id.slice(prefix.length))).map((tool) => tool.id.slice(prefix.length)).sort();
  };
  const describe2 = async (raw) => {
    const input = raw ?? {};
    const resolved = input.sessionID === void 0 ? void 0 : await session(input.sessionID);
    const tools = mcp ? await ctx.tool.list() : [];
    const server = anyMcp ? serverOf(void 0) : "";
    const managed = mcp !== void 0 && server !== "" ? mcp.managed(server) : false;
    const status = managed ? (await ctx.mcp.list()).data.find((entry) => entry.name === server)?.status.status : void 0;
    const methodsOut = [];
    for (const method of methods) {
      if (method.kind === "mcp") {
        const id = `${server}_${method.name}`;
        const tool = managed ? tools.find((entry) => entry.id === id) : void 0;
        const code = !managed ? "SERVER_CONFLICT" : tool ? void 0 : connection(status) ?? "TOOL_UNAVAILABLE";
        const reason2 = code === "NOT_REGISTERED" ? notRegistered(server)?.code ?? code : code;
        const detail = code === void 0 ? void 0 : mcp.unavailableDetail?.(method.name, code);
        methodsOut.push({
          name: method.name,
          tool: id,
          kind: "mcp",
          class: method.class,
          action: id,
          description: tool?.description ?? "",
          available: reason2 === void 0,
          ...reason2 ? { reason: reason2 } : {},
          ...detail === void 0 ? {} : { detail },
          ...resolved ? { permission: evaluate2(resolved.rules, id) } : {},
          input: jsonSchema(tool?.input) ?? ANY_OBJECT,
          output: mcpOutput(jsonSchema(tool?.output))
        });
        continue;
      }
      const reason = await method.available?.();
      methodsOut.push({
        name: method.name,
        tool: method.name,
        kind: "plugin",
        class: method.class,
        action: method.action,
        description: method.description,
        available: reason === void 0,
        ...reason === void 0 ? {} : { reason },
        ...resolved ? { permission: evaluate2(resolved.rules, method.action) } : {},
        input: method.input,
        output: method.output
      });
    }
    const loose = mcp && mcp.managed(serverOf(void 0)) ? await unclassified(tools) : [];
    return JSON.parse(
      JSON.stringify({
        id: TOOLS_RPC_ID,
        call: `POST /api/rpc/${TOOLS_RPC_ID}/<method> with {"input":{"sessionID":"<session>",${accounts ? `"account":"<account>",` : ""}"input":<the tool's input>}}`,
        location: ctx.location.directory,
        locationHint: LOCATION_HINT,
        methods: methodsOut,
        ...loose.length > 0 ? { unclassified: loose } : {}
      })
    );
  };
  const envelope = (input, objectInput) => strict(
    object2({ sessionID: { type: "string", minLength: 1 }, ...accounts ? { account: { type: "string", minLength: 1 } } : {}, input }, ["sessionID", "input"]),
    (value) => [
      ...typeof value["sessionID"] === "string" && value["sessionID"] !== "" ? [] : [ENVELOPE_MESSAGES.sessionID],
      ...value["account"] === void 0 || typeof value["account"] === "string" && value["account"] !== "" ? [] : [ENVELOPE_MESSAGES.account],
      ...!("input" in value) ? [ENVELOPE_MESSAGES.inputMissing] : objectInput && !plainObject(value["input"]) ? [ENVELOPE_MESSAGES.inputNotObject] : []
    ]
  );
  const contract = Rpc.define({
    id: TOOLS_RPC_ID,
    methods: {
      describe: { input: DESCRIBE_INPUT, output: DESCRIPTION, errors: { failed: FAILED } },
      ...Object.fromEntries(
        methods.map((method) => [
          method.name,
          method.kind === "mcp" ? { input: envelope(ANY_OBJECT, true), output: mcpOutput(), errors: { failed: FAILED } } : { input: envelope(method.input, false), output: method.output, errors: { failed: FAILED } }
        ])
      )
    },
    events: {}
  });
  const handlers = {
    describe: async (raw, context) => {
      try {
        return await describe2(raw);
      } catch (error) {
        if (!(error instanceof ScriptError)) throw error;
        return context.error("failed", error.message, { code: error.failure.code, next: error.failure.next });
      }
    },
    ...Object.fromEntries(methods.map((method) => [method.name, (raw, context) => invoke(method, raw, context)]))
  };
  const registration = await ctx.rpc.register(contract, handlers);
  const hook = await ctx.permission.hook("evaluate", (evaluation) => {
    if (evaluation.source === void 0 || !live.has(evaluation.source.id) || evaluation.effect === "allow") return;
    refused2.set(evaluation.source.id, { action: evaluation.action, effect: evaluation.effect === "ask" ? "ask" : "deny" });
    if (evaluation.effect !== "ask") return;
    evaluation.effect = "deny";
    evaluation.message = UNATTENDED;
  });
  return async () => {
    await hook.dispose().catch(() => void 0);
    await registration.dispose().catch(() => void 0);
  };
}

// src/plugin.ts
var ledgerRoot = () => join5(homedir(), ".local", "share", "opencode-boxd");
function createBoxdPlugin(seam = {}) {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      const options = parseOptions(ctx.options);
      const host = checkHost(ctx.app.version, options.allowUntestedHost);
      const bin = seam.boxdBin ?? "boxd";
      const { skills, problems: skillProblems } = await loadSkills(seam.skillsDir);
      const problems = new Map(skillProblems.map((problem, index) => [`skill:${index}`, problem]));
      const report = (area) => (problem) => void (problem ? problems.set(area, problem) : problems.delete(area));
      const fleet = createFleet({
        boxd: seam.boxd ?? cliBoxd(bin),
        guest: seam.guest ?? cliGuest(bin),
        prover: seam.prover ?? cliProver(),
        ledger: new Ledger(seam.ledger ?? ledgerRoot()),
        now: () => (/* @__PURE__ */ new Date()).toISOString(),
        snapshot: options.snapshot,
        hostVersion: host.version,
        projectDirectory: ctx.location.directory,
        allowedRoots: options.allowedRoots,
        // An awake bound that could not be armed is a status problem, not a silent skip.
        report: report("wake")
      });
      const read = () => readStatus(ctx, {
        access: options.access,
        host,
        snapshot: options.snapshot,
        guestVersion: host.version,
        problems: [...problems.values()],
        ledger: () => fleet.status()
      });
      const stops = [
        await registerDefaultRules(ctx.agent, defaultRules(options.access), report("rules"), options.access).then((registration) => registration.dispose),
        await registerSkills(ctx.skill, skills).then((registration) => registration.dispose),
        await registerStatusCommand(ctx, read).then((registration) => registration.dispose),
        await registerStatusRpc(ctx.rpc, read).then((registration) => registration.dispose),
        // Every tool as a method with its class: a script calls them with no model, and the rules decide what runs.
        await registerToolsRpc(ctx, { methods: ownedMethods(fleet, ctx.permission.assert) }),
        await ctx.tool.transform(toolTransform(fleet, ctx.permission.assert)).then((registration) => registration.dispose)
      ];
      return async () => {
        for (const stop of stops.reverse()) await stop();
      };
    }
  });
}

// src/index.ts
var src_default = createBoxdPlugin();
export {
  src_default as default
};
