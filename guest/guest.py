#!/usr/bin/env python3
"""boxd guest helper, protocol 1.

One JSON object on stdin, one JSON line on stdout: {"ok": true, "protocol": 1, ...} or
{"ok": false, "protocol": 1, "error": "<CODE>", "detail": "..."}. It lives at the stable path
~/.boxd-plugin/guest.py, talks only to the guest's own OpenCode server on localhost, and uses the standard
library only.

Read actions (phase, read, health, serve) never start, write or upload anything. Change actions (setup, prompt,
interrupt, upgrade, export, import, git, scrub) first check that this file is the copy the laptop expects (its
sha256): an older copy answers HELPER_OUTDATED and does nothing, and the laptop uploads the new one. An upload runs
once with --install, which moves it to the stable path before it acts.
"""

import base64
import datetime
import hashlib
import json
import os
import re
import secrets
import shlex
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PROTOCOL = 1
PORT = 4096
DEFAULT_BASE = f"http://127.0.0.1:{PORT}"

# The tests run this helper against a folder that stands in for the machine's disk; on a machine it is empty.
ROOT = os.environ.get("BOXD_FAKE_ROOT", "")


def local(path):
    """A guest path as this process opens it."""
    return ROOT + path if ROOT else path


def guest(path):
    """A path this process opened, as the laptop names it on the guest."""
    return path[len(ROOT):] if ROOT and path.startswith(ROOT) else path


HOME = "/home/boxd"
WORK_ROOT = HOME + "/work"
HELPER_HOME = local(HOME + "/.boxd-plugin")
HELPER_PATH = HELPER_HOME + "/guest.py"
PASSWORD_PATH = HELPER_HOME + "/password"
SERVER_LOG = HELPER_HOME + "/server.log"
SERVER_PID = HELPER_HOME + "/server.pid"
SETUP_LOG = HELPER_HOME + "/setup.log"
ENV_NAMES = HELPER_HOME + "/env.json"
CLONES = HELPER_HOME + "/clones"
EXPORTS = HELPER_HOME + "/exports"
HARVEST = HELPER_HOME + "/harvest"
STAGING = HELPER_HOME + "/staging"
IMPORTS = HELPER_HOME + "/imports"
# The work's OpenCode reads global plugins from ~/.config/opencode/plugins; setup puts the completion tool there.
PLUGIN_HOME = local(HOME + "/.config/opencode/plugins")
PLUGIN_PATH = PLUGIN_HOME + "/boxd-done.js"
CLONE_SECONDS = 300
TEXT_LIMIT = 2000
# `phase` with `full`: the whole last assistant message, up to this many characters (line breaks kept).
FULL_TEXT_LIMIT = 64000
TAIL_LIMIT = 20
LIST_LIMIT = 1000
# The server pages /api/session (50 a page by default). A work's whole tree is every page; this is the sane cap.
SESSION_PAGES = 100

# The completion tool, written into the guest OpenCode's global plugins folder by setup. Its arguments are the work's
# claim of completion and the pull requests it opened; they stay in the transcript, which is where the laptop reads
# them. It uses only the public @opencode/plugin 2.4.1 API.
DONE_PLUGIN = r'''// boxd_done: the work's completion tool, written by the guest helper.
import { Plugin } from "@opencode/plugin"

const SUMMARY_LIMIT = 500
const PR_LIMIT = 20
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/
const PR_SHORT = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/

function refuse(message) {
  throw new Error("boxd_done refused: " + message)
}

export default Plugin.define({
  id: "boxd.done",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "boxd", description: "Declare this work complete for the laptop." })
      editor.add({
        name: "done",
        description:
          "Call this once, as your last act, when the whole task is finished, including every subagent. " +
          "Give a short summary of what changed and the pull requests you opened. Do not call it while work remains.",
        input: {
          type: "object",
          properties: {
            summary: { type: "string", description: "A short summary of the work, in one or two sentences." },
            prs: {
              type: "array",
              items: { type: "string" },
              description: "The pull requests this work opened, as https://github.com/owner/repo/pull/123 or owner/repo#123.",
            },
          },
          required: ["summary"],
          additionalProperties: false,
        },
        options: { namespace: "boxd", codemode: false },
        execute: async (input) => {
          const summary = typeof input?.summary === "string" ? input.summary.trim() : ""
          if (summary === "") refuse("summary must be a non-empty string")
          if (Array.from(summary).length > SUMMARY_LIMIT) refuse("summary must be at most " + SUMMARY_LIMIT + " characters")
          const prs = input?.prs ?? []
          if (!Array.isArray(prs)) refuse("prs must be an array of pull request URLs or owner/repo#n")
          if (prs.length > PR_LIMIT) refuse("prs must list at most " + PR_LIMIT + " pull requests")
          for (const pr of prs) {
            if (typeof pr !== "string" || !(PR_URL.test(pr) || PR_SHORT.test(pr))) refuse(String(pr).slice(0, 80) + " is not a pull request URL or owner/repo#n")
          }
          const count = prs.length
          return {
            content: count === 0 ? "Done recorded." : "Done recorded: " + count + (count === 1 ? " pull request." : " pull requests."),
          }
        },
      })
    })
  },
})
'''


class GuestError(Exception):
    def __init__(self, error, detail=""):
        super().__init__(error)
        self.error = error
        self.detail = detail


def fail(error, detail=""):
    raise GuestError(error, detail)


def emit(payload):
    sys.stdout.write(json.dumps({"ok": True, "protocol": PROTOCOL, **payload}) + "\n")


# ── Input checks ──────────────────────────────────────────────────────────────────────────────────────────────────

SAFE_PATH = re.compile(r"/[A-Za-z0-9_./-]+")
SESSION = re.compile(r"ses_[A-Za-z0-9_-]{1,80}")
MODEL = re.compile(r"([A-Za-z0-9][A-Za-z0-9._-]{0,63})/([A-Za-z0-9][A-Za-z0-9._:/@-]{0,127})(?:#([A-Za-z0-9][A-Za-z0-9._-]{0,31}))?")
VERSION = re.compile(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?")


def work_directory(value):
    """The work's guest folder: always /home/boxd/work/<work id>."""
    if not isinstance(value, str) or not re.fullmatch(r"/home/boxd/work/[a-z][a-z0-9-]{0,24}", value):
        fail("NAME_INVALID", "directory must be /home/boxd/work/<work id>")
    return local(value)


def session_id(value):
    if not isinstance(value, str) or not SESSION.fullmatch(value):
        fail("NAME_INVALID", "bad session id")
    return value


def relative(value):
    if not isinstance(value, str) or value == "" or value.startswith("/") or "\\" in value or ".." in value.split("/") or "\x00" in value:
        fail("NAME_INVALID", "a path must be relative to the work tree, with no '..'")
    return value


def inside(root, path):
    """The real path, when it stays inside root's real path; a symlink out of the tree is refused."""
    real_root = os.path.realpath(root)
    real = os.path.realpath(path)
    if real != real_root and not real.startswith(real_root + os.sep):
        fail("PATH_REFUSED", "the path leaves the work tree")
    return real


def model_ref(value):
    parsed = MODEL.fullmatch(value) if isinstance(value, str) else None
    if not parsed:
        fail("NAME_INVALID", "bad model")
    ref = {"providerID": parsed.group(1), "id": parsed.group(2)}
    if parsed.group(3):
        ref["variant"] = parsed.group(3)
    return ref


def base_url(request):
    """The guest server: only a loopback host and an explicit port."""
    base = request.get("base") or DEFAULT_BASE
    parsed = re.fullmatch(r"http://(127\.0\.0\.1|localhost):(\d{1,5})", base)
    if not parsed or not (1 <= int(parsed.group(2)) <= 65535):
        fail("NAME_INVALID", "base must be http://127.0.0.1:<port>")
    return base


# ── The guest's OpenCode server ───────────────────────────────────────────────────────────────────────────────────


def read_password():
    try:
        with open(PASSWORD_PATH, encoding="utf8") as handle:
            return handle.read().strip()
    except OSError:
        return ""


def http_raw(request, method, path, body=None, timeout=5):
    """One call to the guest server, with the whole JSON envelope (its `data` and, for a list, its `cursor`)."""
    base = base_url(request)
    data = None if body is None else json.dumps(body).encode()
    headers = {"content-type": "application/json", "accept": "application/json"}
    password = read_password() if base == DEFAULT_BASE else ""
    if password:
        headers["authorization"] = "Basic " + base64.b64encode(f"opencode:{password}".encode()).decode()
    try:
        with urllib.request.urlopen(urllib.request.Request(base + path, data=data, method=method, headers=headers), timeout=timeout) as response:
            raw = response.read().decode()
    except urllib.error.HTTPError as error:
        raise GuestError(f"HTTP {error.code}", error.read().decode(errors="replace")[:300]) from None
    except (urllib.error.URLError, OSError) as error:
        raise GuestError("GUEST_SERVER_DOWN", str(getattr(error, "reason", error))[:200]) from None
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        return None


def http(request, method, path, body=None, timeout=5):
    """One call to the guest server, unwrapped to its `data`."""
    payload = http_raw(request, method, path, body, timeout)
    return payload["data"] if isinstance(payload, dict) and "data" in payload else payload


def server_version(request):
    """The server's OpenCode version from /api/info, or None when it does not say. Raises when it is down."""
    try:
        info = http(request, "GET", "/api/info")
    except GuestError as error:
        if error.error.startswith("HTTP"):
            return None
        raise
    version = info.get("version") if isinstance(info, dict) else None
    return version if isinstance(version, str) and VERSION.fullmatch(version) else None


def server_up(request):
    try:
        server_version(request)
        return True
    except GuestError:
        return False


def pid_alive(path):
    try:
        with open(path, encoding="utf8") as handle:
            pid = int(handle.read().strip())
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError):
        return None


def opencode_version():
    try:
        result = subprocess.run(["opencode", "--version"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    found = VERSION.search(result.stdout or "")
    return found.group(0) if found else None


def ensure_home():
    os.makedirs(HELPER_HOME, mode=0o700, exist_ok=True)
    os.chmod(HELPER_HOME, 0o700)


def ensure_password():
    ensure_home()
    if not os.path.exists(PASSWORD_PATH):
        write_file(PASSWORD_PATH, secrets.token_hex(24).encode(), 0o600)


# What a work's OpenCode, and every command it runs, starts with besides the variables the work declares: the machine's
# basics. Everything else the machine holds (the operator's tokens and keys among it) is left out of the server's
# environment. This is not a barrier: the guest user can still read PROFILE_ENV, source it in a login shell or use sudo.
BASIC_NAMES = frozenset(
    "PATH HOME USER LOGNAME SHELL LANG LANGUAGE TERM TZ TMPDIR XDG_RUNTIME_DIR "
    "SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS REQUESTS_CA_BUNDLE CURL_CA_BUNDLE "
    "HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy BOXD_VM_ID BOXD_VM_NAME BOXD_VM_HOST".split()
)
ENV_NAME = re.compile(r"[A-Z_][A-Z0-9_]{0,63}")
ENV_LIMIT = 64
# boxd writes the machine's variables here at every boot; a command that does not start a login shell lacks them.
PROFILE_ENV = "/etc/profile.d/boxd-env.sh"


def env_names(value):
    """The variable names a request declares: a sorted, checked list."""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > ENV_LIMIT or not all(isinstance(name, str) and ENV_NAME.fullmatch(name) for name in value):
        fail("NAME_INVALID", f"env must be a list of at most {ENV_LIMIT} variable names such as GH_TOKEN")
    if "OPENCODE_PASSWORD" in value:
        fail("NAME_INVALID", "env cannot declare OPENCODE_PASSWORD: the helper sets it")
    return sorted(set(value))


def profile_env():
    """The variables boxd wrote for the machine, by name."""
    found = {}
    try:
        with open(local(PROFILE_ENV), encoding="utf8") as handle:
            for line in handle:
                name, equals, rest = line.strip().removeprefix("export ").partition("=")
                if equals and ENV_NAME.fullmatch(name):
                    try:
                        parts = shlex.split(rest)
                    except ValueError:
                        continue
                    found[name] = parts[0] if parts else ""
    except OSError:
        pass
    return found


def session_env(names):
    """The environment of a work's OpenCode: the machine's basics and the declared names, from this process or the
    machine's own variables file. An undeclared variable is dropped from the server's environment, and so from the commands it starts directly."""
    source = {**profile_env(), **os.environ}
    return {name: value for name, value in source.items() if name in names or name in BASIC_NAMES or name.startswith("LC_")}


def applied_env_names():
    """The names the running server was started with; None when the helper never recorded them."""
    try:
        with open(ENV_NAMES, encoding="utf8") as handle:
            names = json.load(handle)
    except (OSError, ValueError):
        return None
    return names if isinstance(names, list) else None


def start_server(names=None):
    """Starts `opencode serve` on localhost with the guest password, detached, logging to server.log. It runs with the
    machine's basics and the declared names only; without names it keeps the ones it was last started with."""
    ensure_password()
    if names is None:
        names = applied_env_names() or []
    write_file(ENV_NAMES, json.dumps(names).encode(), 0o600)
    env = session_env(names)
    env["OPENCODE_PASSWORD"] = read_password()
    with open(SERVER_LOG, "ab") as log:
        os.chmod(SERVER_LOG, 0o600)
        process = subprocess.Popen(
            ["opencode", "serve", "--hostname", "127.0.0.1", "--port", str(PORT)],
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            env=env,
            cwd=local(HOME) if os.path.isdir(local(HOME)) else None,
        )
    write_file(SERVER_PID, str(process.pid).encode(), 0o600)


def stop_server():
    pid = pid_alive(SERVER_PID)
    if pid:
        try:
            os.killpg(pid, signal.SIGTERM)
        except OSError:
            pass
        for _ in range(50):
            if not pid_alive(SERVER_PID):
                break
            time.sleep(0.1)
    try:
        os.unlink(SERVER_PID)
    except OSError:
        pass


def server_state(request):
    if server_up(request):
        return "up"
    return "starting" if pid_alive(SERVER_PID) else "down"


# ── Files ─────────────────────────────────────────────────────────────────────────────────────────────────────────


def write_file(path, data, mode=0o600):
    """A new file beside the old one, then one rename: a reader never sees half a file."""
    temp = f"{path}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
    with open(temp, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temp, mode)
    os.replace(temp, path)


def digest(path):
    hasher = hashlib.sha256()
    size = 0
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(block)
            size += len(block)
    return size, hasher.hexdigest()


def remove(path):
    """Removes a file or a folder; true when something was there."""
    if os.path.islink(path) or os.path.isfile(path):
        os.unlink(path)
        return True
    if os.path.isdir(path):
        shutil.rmtree(path)
        return True
    return False


# ── Sessions ──────────────────────────────────────────────────────────────────────────────────────────────────────


def session_info(request, sid):
    try:
        return http(request, "GET", f"/api/session/{sid}")
    except GuestError as error:
        if error.error == "HTTP 404":
            return None
        raise


def all_sessions(request):
    """Every session the server lists, newest first, following `cursor.next` through every page.

    The server pages `/api/session` (50 a page by default), so one page is not a work's tree. A page that fails, or a
    listing that repeats a cursor or outlives SESSION_PAGES, fails the read: a partial tree must never read as idle.
    """
    listed, seen, cursors = [], set(), set()
    path = "/api/session"
    for _ in range(SESSION_PAGES):
        payload = http_raw(request, "GET", path)
        if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
            fail("GUEST_FAILED", "the session listing did not answer a data list")
        for item in payload["data"]:
            if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"] not in seen:
                seen.add(item["id"])
                listed.append(item)
        cursor = payload.get("cursor")
        following = cursor.get("next") if isinstance(cursor, dict) else None
        if following is None:
            return listed
        if not isinstance(following, str) or not following or following in cursors:
            fail("GUEST_FAILED", "the session listing did not answer a usable cursor")
        cursors.add(following)
        path = "/api/session?" + urllib.parse.urlencode({"cursor": following})
    fail("GUEST_FAILED", f"the session listing did not finish within {SESSION_PAGES} pages")


def tree(request, root_id, listed=None):
    """The root session and every session under it, parents first. `listed` reuses the /api/session pages already read."""
    sessions = all_sessions(request) if listed is None else listed
    children = {}
    for item in sessions:
        children.setdefault(item.get("parentID"), []).append(item["id"])
    if not any(item["id"] == root_id for item in sessions) and session_info(request, root_id) is None:
        fail("SESSION_MISSING", root_id)
    order, queue = [], [(root_id, None)]
    while queue:
        sid, parent = queue.pop(0)
        if any(sid == seen for seen, _ in order):
            continue
        order.append((sid, parent))
        queue.extend((child, sid) for child in sorted(children.get(sid, [])))
    return order


def export_of(request, sid):
    exported = http(request, "GET", f"/api/experimental/session/{sid}/export", timeout=20)
    if not isinstance(exported, dict) or not isinstance(exported.get("messages"), list):
        fail("EXPORT_INVALID", f"{sid} exported no messages")
    return exported


def marks(exported, sid, parent):
    """The session's own marks, which drop compares with what the harvest stored."""
    messages = exported["messages"]
    last = messages[-1] if messages else None
    info = exported.get("info") if isinstance(exported.get("info"), dict) else {}
    updated = (info.get("time") or {}).get("updated") if isinstance(info.get("time"), dict) else None
    return {
        "id": sid,
        "parentId": parent,
        "lastMessageId": last.get("id") if isinstance(last, dict) and isinstance(last.get("id"), str) else None,
        "messages": len(messages),
        "updated": updated if isinstance(updated, (int, float)) and not isinstance(updated, bool) else 0,
    }


def message_text(message, limit=TEXT_LIMIT):
    content = message.get("content") if isinstance(message.get("content"), list) else []
    parts = [part["text"] for part in content if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str)]
    if not parts and isinstance(message.get("text"), str):
        parts = [message["text"]]
    return " ".join(parts).strip()[:limit] or None


def newest(request, sid, kind, limit=1):
    """The session's newest messages of one type, newest first; a server that ignores the filter is checked here."""
    listed = http(request, "GET", f"/api/session/{sid}/message?type={kind}&order=desc&limit={limit}") or []
    return [item for item in listed if isinstance(item, dict) and item.get("type") == kind] if isinstance(listed, list) else []


def stamp(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def session_times(session):
    """One session's own time stamps: the last change, and when its current or last run started and ended."""
    time_info = session.get("time") if isinstance(session, dict) and isinstance(session.get("time"), dict) else {}
    return [stamp(time_info.get(key)) for key in ("updated", "busy", "idle")]


def iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, tz=datetime.timezone.utc).isoformat().replace("+00:00", "Z") if ms else None


OUTCOMES = {"succeeded": "completed", "completed": "completed", "ok": "completed", "failed": "failed", "interrupted": "aborted", "aborted": "aborted"}


def waiting(request, sid):
    """The prompts waiting in the session's inbox, by how they were admitted: a steer unless it says queue."""
    counts = {"steer": 0, "queue": 0}
    try:
        inbox = http(request, "GET", f"/api/session/{sid}/inbox") or []
    except GuestError:
        return counts
    for item in inbox if isinstance(inbox, list) else []:
        if isinstance(item, dict) and item.get("type") == "user":
            counts["queue" if item.get("delivery") == "queue" else "steer"] += 1
    return counts


def needs_input(request, sid):
    """A pending form or permission ask: a person must answer it, so automation never sleeps the work."""
    for kind in ("permission", "form"):
        try:
            pending = http(request, "GET", f"/api/session/{sid}/{kind}")
        except GuestError:
            continue
        if isinstance(pending, list) and pending:
            return kind
    return None


def reading():
    """What the guest costs now: resident memory (total less available) and the 1-minute load."""
    memory = meminfo()
    load = loadavg()
    resident = max(0, memory.get("MemTotal", 0) - memory.get("MemAvailable", 0))
    return {"residentGiB": round(resident / 1024 / 1024, 3), "load1": load if load is not None else 0}


def meminfo():
    values = {}
    try:
        with open("/proc/meminfo", encoding="utf8") as handle:
            for line in handle:
                key, _, value = line.partition(":")
                if key in ("MemTotal", "MemAvailable"):
                    values[key] = int(value.split()[0])
    except (OSError, ValueError, IndexError):
        pass
    return values


def loadavg():
    try:
        with open("/proc/loadavg", encoding="utf8") as handle:
            return float(handle.read().split()[0])
    except (OSError, ValueError, IndexError):
        return None


# ── Read actions ──────────────────────────────────────────────────────────────────────────────────────────────────


def action_serve(request):
    answer = {"server": server_state(request), "opencode": None}
    if answer["server"] == "up":
        answer["opencode"] = server_version(request)
    directory = request.get("directory")
    if directory is not None:
        state = clone_state(work_directory(directory))
        if state:
            answer["clone"] = state.get("status")
    emit(answer)


def action_phase(request):
    """The work's phase over its whole session tree; lastText, tail, waiting and needsInput are the root coordinator's."""
    sid = session_id(request.get("sessionId"))
    full = request.get("full")
    if full is not None and not isinstance(full, bool):
        fail("NAME_INVALID", "full must be true or false")
    version = server_version(request)
    info = session_info(request, sid)
    base = {"waiting": {"steer": 0, "queue": 0}, "guestVersion": version, "outcome": None, "reading": reading()}
    if not isinstance(info, dict):
        emit({"phase": "missing", **base})
        return
    tail = request.get("tail")
    tail = min(tail, TAIL_LIMIT) if isinstance(tail, int) and not isinstance(tail, bool) and tail > 0 else 0
    active = http(request, "GET", "/api/session/active") or {}
    # The work is its root coordinator's tree: the root and every subagent session under it. The /api/session pages
    # carry each session's time stamps; every page is read, and a listing that cannot finish fails the read, so a busy
    # tree can never read as idle.
    listed = all_sessions(request)
    if not any(item["id"] == sid for item in listed):
        listed = listed + [info]
    sessions = tree(request, sid, listed)
    records = {item["id"]: item for item in listed}
    records[sid] = info
    time_info = info.get("time") if isinstance(info.get("time"), dict) else {}
    answer = {**base, "waiting": waiting(request, sid)}
    stamps = []
    present = []
    for tree_id, _parent in sessions:
        record = records.get(tree_id)
        times = session_times(record)
        if tree_id != sid and not any(value is not None for value in times):
            # A listing without times leaves one read per such session; one gone in between is skipped, not failed.
            record = session_info(request, tree_id)
            if not isinstance(record, dict):
                continue
            times = session_times(record)
        present.append(tree_id)
        stamps += times
    if any(tree_id in active for tree_id in present):
        answer["phase"] = "busy"
    else:
        answer["phase"] = "idle"
        busy, idle = stamp(time_info.get("busy")), stamp(time_info.get("idle"))
        if busy is not None and (idle is None or busy > idle):
            # A busy stamp with no run in the server is a run the server died in.
            answer["outcome"] = "aborted"
        else:
            answer["outcome"] = OUTCOMES.get(info.get("outcome"))
            try:
                last = newest(request, sid, "idle")
            except GuestError:
                last = []
            if last:
                answer["outcome"] = answer["outcome"] or OUTCOMES.get(last[0].get("outcome"))
                failure = last[0].get("error")
                if answer["outcome"] == "failed" and isinstance(failure, dict):
                    answer["error"] = {"type": str(failure.get("type") or "error")[:60], "message": str(failure.get("message") or "")[:400]}
    # The coordinator's own report stays the root's: lastText, tail, waiting and needsInput are not widened to children.
    try:
        recent = newest(request, sid, "assistant", max(1, tail))
    except GuestError:
        recent = []
    if recent:
        times = recent[0].get("time") if isinstance(recent[0].get("time"), dict) else {}
        stamps += [stamp(times.get("completed")), stamp(times.get("created"))]
        text = message_text(recent[0], FULL_TEXT_LIMIT if full else TEXT_LIMIT)
        if text:
            answer["lastText"] = text
    if tail:
        answer["tail"] = []
        for item in reversed(recent[:tail]):
            text = message_text(item)
            if text:
                times = item.get("time") if isinstance(item.get("time"), dict) else {}
                at = stamp(times.get("completed")) or stamp(times.get("created"))
                answer["tail"].append({"text": text, **({"at": iso(at)} if at else {})})
    known = [value for value in stamps if value is not None]
    if known:
        answer["lastActivityAt"] = iso(max(known))
    pending = needs_input(request, sid)
    if pending:
        answer["needsInput"] = pending
    cost = info.get("cost")
    if isinstance(cost, (int, float)) and not isinstance(cost, bool):
        answer["modelCost"] = cost
    emit(answer)


def action_read(request):
    max_bytes = request.get("maxBytes")
    if not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or not 1 <= max_bytes <= 262144:
        fail("NAME_INVALID", "maxBytes must be 1 to 262144")
    tail = request.get("tail")
    tail = tail if isinstance(tail, int) and not isinstance(tail, bool) and 1 <= tail <= 2000 else None
    if request.get("log") == "server":
        path, name = SERVER_LOG, "server.log"
        if not os.path.isfile(path):
            emit({"binary": False, "path": name, "bytes": 0, "truncated": False, "text": ""})
            return
    else:
        root = work_directory(request.get("directory"))
        name = relative(request.get("path"))
        path = inside(root, os.path.join(root, name))
        if not os.path.isfile(path):
            fail("NAME_INVALID", f"{name} is not a file in the work tree")
    size = os.path.getsize(path)
    with open(path, "rb") as handle:
        if tail:
            handle.seek(max(0, size - max_bytes * 4))
            data = handle.read()
        else:
            data = handle.read(max_bytes + 1)
    try:
        text = data.decode("utf8")
    except UnicodeDecodeError:
        if tail:
            text = data.decode("utf8", errors="ignore")
        else:
            total, sha = digest(path)
            emit({"binary": True, "path": name, "bytes": total, "sha256": sha})
            return
    truncated = size > len(data)
    if tail:
        lines = text.splitlines()
        text = "\n".join(lines[-tail:])
    encoded = text.encode("utf8")
    if len(encoded) > max_bytes:
        text = encoded[len(encoded) - max_bytes:].decode("utf8", errors="ignore") if tail else encoded[:max_bytes].decode("utf8", errors="ignore")
        truncated = True
    emit({"binary": False, "path": name, "bytes": size, "truncated": truncated, "text": text})


def action_health(request):
    """Why the machine may not answer: memory, load and the heaviest processes, by command name only (never their
    arguments, which can hold a secret). It reads /proc and never talks to OpenCode."""
    memory = meminfo()
    processes = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/status", encoding="utf8", errors="replace") as handle:
                fields = dict(line.rstrip("\n").split(":\t", 1) for line in handle if ":\t" in line)
            rss = int(fields.get("VmRSS", "0 kB").split()[0]) // 1024
        except (OSError, ValueError, IndexError):
            continue
        processes.append({"name": fields.get("Name", "?").strip()[:32], "rssMb": rss})
    processes.sort(key=lambda item: item["rssMb"], reverse=True)
    load = loadavg()
    emit(
        {
            "reading": reading(),
            "memory": {"totalMb": memory.get("MemTotal", 0) // 1024, "availableMb": memory.get("MemAvailable", 0) // 1024},
            "load": load if load is not None else 0,
            "top": processes[:5],
        }
    )


# ── Change actions ────────────────────────────────────────────────────────────────────────────────────────────────


def clone_key(directory):
    return hashlib.sha256(guest(directory).encode()).hexdigest()[:16]


def clone_state(directory):
    try:
        with open(os.path.join(CLONES, clone_key(directory) + ".json"), encoding="utf8") as handle:
            state = json.load(handle)
    except (OSError, ValueError):
        return None
    if state.get("status") == "running" and not pid_alive(os.path.join(CLONES, clone_key(directory) + ".pid")):
        # The clone process is gone without writing its end: it was killed (a reboot, its own bound).
        state["status"] = "failed"
    return state


def write_clone_state(directory, state):
    os.makedirs(CLONES, mode=0o700, exist_ok=True)
    write_file(os.path.join(CLONES, clone_key(directory) + ".json"), json.dumps(state).encode(), 0o600)


def repo_url(value):
    if isinstance(value, str) and re.fullmatch(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?", value):
        return value
    if ROOT and isinstance(value, str) and value.startswith("file://"):
        return value
    fail("NAME_INVALID", "repo must be an https://github.com/owner/repo URL")


def start_clone(directory, repo, ref):
    """The clone runs detached, in its own process group with its own bound, so a stopped call never cuts it."""
    os.makedirs(CLONES, mode=0o700, exist_ok=True)
    spec = {"directory": guest(directory), "repo": repo, "ref": ref, "status": "running", "at": time.time()}
    write_clone_state(directory, spec)
    with open(SETUP_LOG, "ab") as log:
        os.chmod(SETUP_LOG, 0o600)
        process = subprocess.Popen(
            [sys.executable, HELPER_PATH, "--clone", guest(directory)],
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    write_file(os.path.join(CLONES, clone_key(directory) + ".pid"), str(process.pid).encode(), 0o600)


def run_clone(directory):
    """The detached clone itself: into a temp folder beside the work folder, then one rename, so a half clone is never
    taken for a checkout."""
    state = clone_state(directory) or {}
    temp = f"{directory}.clone-{os.getpid()}"
    remove(temp)
    command = ["timeout", str(CLONE_SECONDS), "git", "clone", "--quiet"]
    if state.get("ref"):
        command += ["--branch", state["ref"]]
    command += ["--", state.get("repo", ""), temp]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode == 0 and os.path.isdir(os.path.join(temp, ".git")):
        if os.path.isdir(directory) and not os.listdir(directory):
            os.rmdir(directory)
        if os.path.exists(directory):
            remove(temp)
            state.update(status="failed", detail="the work folder is not empty")
        else:
            os.replace(temp, directory)
            state.update(status="done")
    else:
        remove(temp)
        state.update(status="failed", detail=(result.stderr or "git clone failed").strip()[-300:])
    state["ended"] = time.time()
    write_clone_state(directory, state)


def git_identity(value):
    if value is None:
        return
    if not isinstance(value, dict):
        fail("NAME_INVALID", "git must be { name, email }")
    name, email = value.get("name"), value.get("email")
    if not isinstance(name, str) or not isinstance(email, str) or not name or not email or any(ch in name + email for ch in "\n\r\x00"):
        fail("NAME_INVALID", "git must be { name, email }")
    for key, text in (("user.name", name), ("user.email", email)):
        subprocess.run(["git", "config", "--global", key, text], check=True, capture_output=True)


# A work acts only with an identity it was given: a boxd secret bound to one host reaches the guest as a placeholder.
PLACEHOLDER = "bxds_"
IDENTITY_ENV = (
    ("GitHub", ("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN")),
    (
        "model",
        ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENCODE_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"),
    ),
    ("cloud", ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AZURE_CLIENT_SECRET", "DIGITALOCEAN_ACCESS_TOKEN", "CLOUDFLARE_API_TOKEN")),
)
# Each file, with the pattern that picks out the value of the login it holds (a user name stands in for a token given
# without a password); a placeholder there is the identity given. A file with content the pattern cannot read is refused.
IDENTITY_FILES = (
    ("GitHub", HOME + "/.git-credentials", r"://(?:[^:/@\s]*:)?([^:/@\s]+)@"),
    ("GitHub", HOME + "/.config/gh/hosts.yml", r"oauth_token[\"']?\s*[:=]\s*[\"']?([^\s\"',]+)"),
    ("cloud", HOME + "/.aws/credentials", r"(?i)aws_secret_access_key\s*[:=]\s*(\S+)"),
    ("cloud", HOME + "/.config/gcloud/application_default_credentials.json", r"refresh_token[\"']?\s*[:=]\s*[\"']?([^\s\"',]+)"),
)
CREDENTIAL_SECONDS = 10
PER_LINE = frozenset((HOME + "/.git-credentials",))


def file_holds(path, pattern):
    """Whether the file may hold a real login: it has content, and it is not shown to hold only bound placeholders."""
    try:
        with open(local(path), "r", errors="replace") as handle:
            text = handle.read(65536)
    except OSError:
        return False
    if not text.strip():
        return False
    # A credentials file holds one login a line, so each line must show its own placeholder.
    parts = [line for line in text.splitlines() if line.strip()] if path in PER_LINE else [text]
    for part in parts:
        values = re.findall(pattern, part)
        if not values or any(not value.startswith(PLACEHOLDER) for value in values):
            return True
    return False


def git_github_login():
    """Whether git would be handed a GitHub login for github.com, as the boxd git integration does: "yes", "unknown" or "no". The value is never read out."""
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never", "GIT_ASKPASS": "", "SSH_ASKPASS": ""}
    try:
        done = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n", env=env, capture_output=True, text=True, timeout=CREDENTIAL_SECONDS)
    except FileNotFoundError:
        return "no"
    except subprocess.TimeoutExpired:
        return "unknown"
    values = [line[len("password="):] for line in done.stdout.splitlines() if line.startswith("password=")]
    given = done.returncode == 0 and any(value and not value.startswith(PLACEHOLDER) for value in values)
    return "yes" if given else "no"


def operator_findings():
    """What would make this machine act as its operator, as short names with no secret value in them."""
    found = []
    # The variables boxd wrote for the machine count too: a command without a login shell lacks them, but the server a work declares them from has them.
    source = {**profile_env(), **os.environ}
    for kind, names in IDENTITY_ENV:
        for name in names:
            value = source.get(name, "")
            if value and not value.startswith(PLACEHOLDER):
                found.append(f"{name} is a real {kind} credential")
    for kind, path, pattern in IDENTITY_FILES:
        if file_holds(path, pattern):
            found.append(f"{path.replace(HOME, '~')} holds a {kind} login")
    login = git_github_login()
    if login == "yes":
        found.append("git is given a GitHub login for github.com")
    elif login == "unknown":
        found.append(f"git did not say within {CREDENTIAL_SECONDS} s whether it is given a GitHub login")
    return found


def refuse_operator():
    found = operator_findings()
    if found:
        fail("ACTS_AS_OPERATOR", "; ".join(found))


def ensure_done_plugin():
    """The completion tool in the guest OpenCode's global plugins folder: written once, and rewritten only when the
    helper's text changed. The server is never restarted for it; OpenCode picks a plugin up from its config folder."""
    data = DONE_PLUGIN.encode()
    try:
        size, sha = digest(PLUGIN_PATH)
        if size == len(data) and sha == hashlib.sha256(data).hexdigest():
            return
    except OSError:
        pass
    os.makedirs(PLUGIN_HOME, mode=0o700, exist_ok=True)
    write_file(PLUGIN_PATH, data, 0o600)


def action_setup(request):
    directory = work_directory(request.get("directory"))
    refuse_operator()
    ensure_password()
    ensure_done_plugin()
    names = env_names(request.get("env"))
    version = opencode_version()
    state = server_state(request)
    if state == "down":
        start_server(names)
        state = "starting"
    elif applied_env_names() != names:
        # The server runs with other variables (or an older helper's whole environment): restart it, never mid-run.
        if http(request, "GET", "/api/session/active"):
            fail("SESSION_BUSY", "the work's OpenCode runs with other variables and is busy; ensure again when it is idle")
        stop_server()
        start_server(names)
        state = "starting"
    git_identity(request.get("git"))
    workspace = "ready"
    if not os.path.isdir(os.path.join(directory, ".git")):
        repo = request.get("repo")
        if repo is None:
            os.makedirs(directory, exist_ok=True)
        else:
            url = repo_url(repo.get("url") if isinstance(repo, dict) else None)
            ref = repo.get("ref") if isinstance(repo, dict) else None
            if ref is not None and (not isinstance(ref, str) or not re.fullmatch(r"[A-Za-z0-9._/-]{1,120}", ref)):
                fail("NAME_INVALID", "bad ref")
            existing = clone_state(directory)
            if existing and existing.get("status") == "running":
                workspace = "cloning"
            elif existing and existing.get("status") == "failed":
                # Reported once; the next setup starts a new clone.
                os.unlink(os.path.join(CLONES, clone_key(directory) + ".json"))
                fail("GUEST_WORKSPACE", existing.get("detail") or "the clone failed")
            else:
                os.makedirs(os.path.dirname(directory), exist_ok=True)
                start_clone(directory, url, ref)
                workspace = "cloning"
    emit({"server": "up" if state == "up" else "starting", "opencode": version or "", "workspace": workspace})


def wait_idle(request, sid, seconds=5):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if sid not in (http(request, "GET", "/api/session/active") or {}):
            return True
        time.sleep(0.1)
    return False


def action_prompt(request):
    directory = work_directory(request.get("directory"))
    refuse_operator()
    text = request.get("text")
    if not isinstance(text, str) or not text:
        fail("NAME_INVALID", "empty prompt")
    delivery = request.get("delivery")
    if delivery not in ("steer", "queue", "interrupt"):
        fail("NAME_INVALID", "delivery must be steer, queue or interrupt")
    model = model_ref(request["model"]) if request.get("model") else None
    title = request.get("title") if isinstance(request.get("title"), str) else "boxd"
    for item in request.get("files") or []:
        staged = local(item.get("staged", "")) if isinstance(item, dict) else ""
        if not staged.startswith(STAGING + "/") or ".." in staged.split("/"):
            fail("NAME_INVALID", "a staged file must be under the helper's staging folder")
        target = os.path.join(directory, relative(item.get("to")))
        inside(directory, os.path.dirname(target))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        os.replace(staged, target)
    sid = request.get("sessionId")
    created = False
    if sid is None:
        body = {"title": title[:200], "location": {"directory": guest(directory)}}
        if model:
            body["model"] = model
        made = http(request, "POST", "/api/session", body)
        sid = made.get("id") if isinstance(made, dict) else None
        session_id(sid)
        created = True
    else:
        session_id(sid)
        if session_info(request, sid) is None:
            fail("SESSION_MISSING", sid)
    running = sid in (http(request, "GET", "/api/session/active") or {})
    before = waiting(request, sid)
    if model and not created and running and delivery != "interrupt":
        fail("SESSION_BUSY", "a running session switches its model only with interrupt")
    interrupted = False
    if delivery == "interrupt" and running:
        http(request, "POST", f"/api/session/{sid}/interrupt", {})
        interrupted = True
        running = not wait_idle(request, sid)
    if model and not created:
        http(request, "POST", f"/api/session/{sid}/model", {"model": model})
    admitted = http(request, "POST", f"/api/session/{sid}/prompt", {"text": text, "delivery": "queue" if delivery == "queue" else "steer"})
    inbox_id = None
    if isinstance(admitted, dict):
        inbox_id = admitted.get("id") or admitted.get("inboxID") or admitted.get("messageID")
    answer = {
        "sessionId": sid,
        "delivery": ("queue" if delivery == "queue" else "steer") if running else "started",
        "interrupted": interrupted,
        "inboxId": inbox_id if isinstance(inbox_id, str) else "",
        "waitingBefore": before["steer"] + before["queue"],
    }
    if request.get("model"):
        answer["model"] = request["model"]
    emit(answer)


def action_interrupt(request):
    sid = session_id(request.get("sessionId"))
    http(request, "POST", f"/api/session/{sid}/interrupt", {})
    emit({})


def major(version):
    return int(version.split(".")[0]) if version else 0


def action_upgrade(request):
    target = request.get("version")
    if not isinstance(target, str) or not VERSION.fullmatch(target):
        fail("NAME_INVALID", "version must be a release such as 2.4.1")
    current = opencode_version()
    if current != target:
        if major(current) < major(target):
            subprocess.run(["opencode", "upgrade", "--major"], capture_output=True, text=True, timeout=120)
        result = subprocess.run(["opencode", "upgrade", target], capture_output=True, text=True, timeout=120)
        current = opencode_version()
        if current != target:
            fail("GUEST_FAILED", f"opencode upgrade {target} left {current or 'no version'}: {(result.stderr or result.stdout).strip()[-200:]}")
        # The session database stays on disk; only the server restarts on the new release.
        stop_server()
        start_server()
    emit({"opencode": current})


def export_run(request, sid, active):
    """The root session's last run, for the export's answer, read as phase reads it: a root that is running has no
    outcome yet (a partial export of a live run), and only a busy stamp with no run in the server is an aborted run."""
    if sid in active:
        return {"outcome": None}
    info = session_info(request, sid)
    if not isinstance(info, dict):
        return {"outcome": None}
    time_info = info.get("time") if isinstance(info.get("time"), dict) else {}
    busy, idle = stamp(time_info.get("busy")), stamp(time_info.get("idle"))
    if busy is not None and (idle is None or busy > idle):
        return {"outcome": "aborted"}
    run = {"outcome": OUTCOMES.get(info.get("outcome"))}
    try:
        last = newest(request, sid, "idle")
    except GuestError:
        last = []
    if last:
        run["outcome"] = run["outcome"] or OUTCOMES.get(last[0].get("outcome"))
        failure = last[0].get("error")
        if run["outcome"] == "failed" and isinstance(failure, dict):
            run["error"] = {"type": str(failure.get("type") or "error")[:60], "message": str(failure.get("message") or "")[:400]}
    return run


def action_export(request):
    """Exports the tree, after its own busy check in this one exec: a running tree answers `busy` and writes nothing,
    unless the harvest is partial."""
    root = session_id(request.get("rootId"))
    partial = request.get("partial") is True
    version = server_version(request) or opencode_version() or ""
    sessions_tree = tree(request, root)
    active = http(request, "GET", "/api/session/active") or {}
    running = [sid for sid, _parent in sessions_tree if sid in active]
    if running and not partial:
        emit({"outcome": "busy", "reason": f"{len(running)} session(s) of the tree are running; a harvest needs the tree idle, or partial: true.", "guestVersion": version})
        return
    os.makedirs(EXPORTS, mode=0o700, exist_ok=True)
    sessions = []
    for sid, parent in sessions_tree:
        exported = export_of(request, sid)
        path = os.path.join(EXPORTS, f"{sid}.json")
        write_file(path, json.dumps(exported, separators=(",", ":")).encode(), 0o600)
        size, sha = digest(path)
        sessions.append({**marks(exported, sid, parent), "file": guest(path), "bytes": size, "sha256": sha})
    # A run that started while the tree was written (a person on boxd connect, a queued item) makes this copy partial.
    after = http(request, "GET", "/api/session/active") or {}
    running = running or [sid for sid, _parent in sessions_tree if sid in after]
    emit({"outcome": "exported", "busy": bool(running), "run": export_run(request, root, after), "sessions": sessions, "guestVersion": version})


def action_import(request):
    directory = work_directory(request.get("directory"))
    files = request.get("files")
    if not isinstance(files, list) or not files or len(files) > 500:
        fail("NAME_INVALID", "files must list 1 to 500 exports")
    loaded = []
    for name in files:
        path = local(name) if isinstance(name, str) else ""
        if not path.startswith(IMPORTS + "/") or ".." in path.split("/"):
            fail("NAME_INVALID", "an import must be under the helper's imports folder")
        with open(path, encoding="utf8") as handle:
            exported = json.load(handle)
        info = exported.get("info") if isinstance(exported, dict) else None
        if not isinstance(info, dict) or not isinstance(info.get("id"), str) or not isinstance(exported.get("messages"), list):
            fail("EXPORT_INVALID", f"{name} is not a session export")
        loaded.append(exported)
    ids = {item["info"]["id"] for item in loaded}
    roots = [item for item in loaded if item["info"].get("parentID") not in ids]
    if len(roots) != 1:
        fail("EXPORT_INVALID", "the exports do not form one tree")
    done, order = set(), []
    while len(order) < len(loaded):
        ready = [item for item in loaded if item["info"]["id"] not in done and (item["info"].get("parentID") not in ids or item["info"].get("parentID") in done)]
        if not ready:
            fail("EXPORT_INVALID", "the exports hold a cycle")
        for item in ready:
            done.add(item["info"]["id"])
            order.append(item)
    for item in order:
        try:
            http(request, "POST", "/api/experimental/session/import", {"info": item["info"], "messages": item["messages"], "location": {"directory": guest(directory)}}, timeout=30)
        except GuestError as error:
            # The id is already there: an earlier import of the same tree, which this one joins.
            if error.error != "HTTP 409":
                raise
    emit({"rootId": roots[0]["info"]["id"]})


def strip_userinfo(url):
    return re.sub(r"^([a-z][a-z0-9+.-]*://)[^/@]*@", r"\1", url) if url else url


def entry(root, name):
    full = os.path.join(root, name.rstrip("/"))
    if os.path.islink(full):
        return {"path": name, "bytes": 0, "sha256": ""}
    if os.path.isdir(full):
        total = 0
        for folder, _, names in os.walk(full):
            for item in names:
                try:
                    total += os.lstat(os.path.join(folder, item)).st_size
                except OSError:
                    pass
        return {"path": name, "bytes": total, "sha256": ""}
    try:
        size, sha = digest(full)
    except OSError:
        return {"path": name, "bytes": 0, "sha256": ""}
    return {"path": name, "bytes": size, "sha256": sha}


def pinned_git(directory, *args, text=True):
    """git on the work folder alone: discovery stops at the folder's parent (GIT_CEILING_DIRECTORIES), so a work folder
    nested inside another repository is never read as part of it. Every inherited GIT_* variable (GIT_DIR,
    GIT_WORK_TREE, GIT_COMMON_DIR, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY and the rest) is dropped, so the guest's
    environment can neither point git at another repository nor make the read fail."""
    env = {name: value for name, value in os.environ.items() if not name.startswith("GIT_")}
    env["GIT_CEILING_DIRECTORIES"] = os.path.dirname(os.path.realpath(directory))
    return subprocess.run(["git", "-C", directory, *args], capture_output=True, text=text, env=env)


def under(path, root):
    """True when the real path is the root or under it."""
    real, top = os.path.realpath(path), os.path.realpath(root)
    return real == top or real.startswith(top + os.sep)


def own_repository(directory):
    """True when the work folder is the top of its own repository; false when it is in none. A repository whose top is
    elsewhere is refused, and so is one whose git data lies outside the work folder (a `.git` file or symlink linking
    to another repository's gitdir, or a linked worktree): works are plain clones, and another repository's history is
    not the work's."""
    top = pinned_git(directory, "rev-parse", "--show-toplevel")
    if top.returncode != 0:
        return False
    if os.path.realpath(top.stdout.strip()) != os.path.realpath(directory):
        fail("GIT_UNKNOWN", "the work folder is not the top of its own git repository")
    dirs = pinned_git(directory, "rev-parse", "--absolute-git-dir", "--git-common-dir")
    lines = dirs.stdout.strip().split("\n") if dirs.returncode == 0 else []
    if len(lines) != 2:
        fail("GUEST_FAILED", "git rev-parse failed: " + dirs.stderr.strip()[-200:])
    git_dir = lines[0]
    common = lines[1] if os.path.isabs(lines[1]) else os.path.join(directory, lines[1])
    if not under(git_dir, directory) or not under(common, directory):
        fail("GIT_UNKNOWN", "the work folder's git data lies outside it (a .git link to another repository); works are plain clones")
    return True


def unpushed_commits(git):
    """(count, the first commits, known) for local refs and HEAD against every remote ref.

    An empty repository has nothing to lose and is a known 0. A repository whose refs cannot be walked (a ref to a
    missing object, a corrupt object) is unknown: the caller must refuse a destructive action, not guess."""
    head = git("rev-parse", "--verify", "--quiet", "HEAD")
    if head.returncode != 0:
        # No commit at HEAD: either an empty repository or an unborn branch with commits elsewhere.
        counted = git("rev-list", "--count", "--all", "--not", "--remotes")
        text = counted.stdout.strip()
        if counted.returncode != 0 or not text.isdigit():
            return -1, [], False
        count = int(text)
        if count == 0:
            return 0, [], True
        named = git("log", "--all", "--not", "--remotes", "--format=%h %s", "-n", "20")
        commits = [line.strip()[:200] for line in named.stdout.splitlines() if line.strip()] if named.returncode == 0 else []
        return count, commits, True
    counted = git("rev-list", "--count", "--all", "HEAD", "--not", "--remotes")
    text = counted.stdout.strip()
    if counted.returncode != 0 or not text.isdigit():
        return -1, [], False
    count = int(text)
    if count == 0:
        return 0, [], True
    named = git("log", "--all", "HEAD", "--not", "--remotes", "--format=%h %s", "-n", "20")
    commits = [line.strip()[:200] for line in named.stdout.splitlines() if line.strip()] if named.returncode == 0 else []
    return count, commits, True


def action_git(request):
    directory = work_directory(request.get("directory"))
    answer = {"known": False, "remote": None, "branch": None, "sha": None, "dirty": False, "untracked": [], "ignored": [], "unpushed": [], "unpushedCount": 0, "unpushedKnown": True}

    def git(*args, text=True):
        return pinned_git(directory, *args, text=text)

    if own_repository(directory):
        status = git("status", "--porcelain=v1", "-z", "--untracked-files=all")
        # Ignored paths, an ignored folder as one entry ("build/"), so a dependency tree is one path, not thousands.
        listed = git("ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory")
        if status.returncode != 0 or listed.returncode != 0:
            fail("GUEST_FAILED", "git status failed: " + (status.stderr + listed.stderr).strip()[-200:])
        untracked, dirty = [], False
        ignored = [name for name in listed.stdout.split("\x00") if name]
        records = status.stdout.split("\x00")
        index = 0
        while index < len(records):
            line = records[index]
            index += 1
            if len(line) < 4:
                continue
            code, name = line[:2], line[3:]
            if code[0] in "RC":
                index += 1  # A rename's source path follows it.
            if code == "??":
                untracked.append(name)
            else:
                dirty = True
        sha = git("rev-parse", "HEAD")
        remote = git("remote", "get-url", "origin")
        branch = git("branch", "--show-current")
        # Commits a local branch, tag, stash or detached HEAD holds that no remote ref contains (#39): with no remote,
        # every commit is local, so dropping the machine would lose them. The check must fail closed: a count that cannot
        # be read is unknown, never 0, because dropping is destructive.
        unpushed_count, unpushed, unpushed_known = unpushed_commits(git)
        answer.update(
            known=True,
            remote=strip_userinfo(remote.stdout.strip()) or None,
            branch=branch.stdout.strip() or None,
            sha=sha.stdout.strip() or None,
            dirty=dirty,
            untracked=[entry(directory, name) for name in untracked[:LIST_LIMIT]],
            ignored=[entry(directory, name) for name in ignored[:LIST_LIMIT]],
            unpushed=unpushed,
            unpushedCount=unpushed_count,
            unpushedKnown=unpushed_known,
        )
        if dirty:
            # Tracked changes, staged and unstaged together: `git diff` alone misses a staged file.
            patch = git("diff", "--binary", "HEAD", text=False)
            os.makedirs(HARVEST, mode=0o700, exist_ok=True)
            path = os.path.join(HARVEST, "patch.diff")
            write_file(path, patch.stdout, 0o600)
            size, sha256 = digest(path)
            answer["patch"] = {"file": guest(path), "bytes": size, "sha256": sha256}
    root = request.get("rootId")
    if root is not None:
        answer["sessions"] = [marks(export_of(request, sid), sid, parent) for sid, parent in tree(request, session_id(root))]
    emit(answer)


def has_sessions(request):
    """Whether the base's OpenCode database holds any session: the server's list when it runs, else the database."""
    if server_up(request):
        return bool(all_sessions(request))
    database = local(HOME + "/.local/share/opencode/opencode.db")
    if not os.path.exists(database):
        return False
    try:
        connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
        try:
            tables = [row[0] for row in connection.execute("select name from sqlite_master where type = 'table' and name like 'session%'")]
            return any(connection.execute(f'select 1 from "{table}" limit 1').fetchone() for table in tables if re.fullmatch(r"[A-Za-z_]+", table))
        finally:
            connection.close()
    except sqlite3.Error as error:
        fail("GUEST_FAILED", f"the session database could not be read: {error}")


def action_scrub(request):
    """The golden build's last step: nothing of a person, a key or a session stays in the image."""
    if os.path.exists(local(HOME + "/.local/share/opencode/auth.json")):
        emit({"removed": [], "refused": "has-credential"})
        return
    if has_sessions(request):
        emit({"removed": [], "refused": "has-session"})
        return
    stop_server()
    removed = []
    env_file = "/etc/profile.d/boxd-env.sh"
    if os.path.exists(local(env_file)):
        if ROOT:
            os.unlink(local(env_file))
        else:
            # boxd writes it as root at every boot; the helper runs as boxd, which has passwordless sudo.
            subprocess.run(["sudo", "-n", "rm", "-f", env_file], check=True, capture_output=True)
        removed.append(env_file)
    for path in (PASSWORD_PATH, ENV_NAMES, EXPORTS, HARVEST, STAGING, IMPORTS, CLONES, SERVER_LOG, SETUP_LOG, local(WORK_ROOT)):
        if remove(path):
            removed.append(guest(path))
    emit({"removed": removed})


# ── Dispatch ──────────────────────────────────────────────────────────────────────────────────────────────────────

READS = {"serve": action_serve, "phase": action_phase, "read": action_read, "health": action_health}
CHANGES = {
    "setup": action_setup,
    "prompt": action_prompt,
    "interrupt": action_interrupt,
    "upgrade": action_upgrade,
    "export": action_export,
    "import": action_import,
    "git": action_git,
    "scrub": action_scrub,
}


def own_digest():
    return digest(os.path.abspath(__file__))[1]


def install(expected):
    """An uploaded copy checks that it is the copy the laptop sent (its sha256), moves itself to the stable path, then
    acts on its request from there. A copy that does not match is deleted and changes nothing."""
    source = os.path.abspath(__file__)
    if expected != own_digest():
        try:
            os.unlink(source)
        except OSError:
            pass
        fail("HELPER_OUTDATED", "the uploaded helper is not the copy the plugin sent")
    ensure_home()
    if source != HELPER_PATH:
        with open(source, "rb") as handle:
            write_file(HELPER_PATH, handle.read(), 0o700)
        os.unlink(source)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--clone":
        run_clone(work_directory(sys.argv[2]))
        return
    installing = sys.argv[1:] == ["--install"]
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            fail("NAME_INVALID", "the request must be a JSON object")
        action = request.get("action")
        if action in CHANGES:
            expected = request.get("helper")
            if installing:
                install(expected)
            elif expected != own_digest():
                # An older or newer copy changes nothing: the laptop uploads the one it expects, then calls again.
                fail("HELPER_OUTDATED", "this helper is not the copy the plugin expects")
            CHANGES[action](request)
        elif action in READS:
            READS[action](request)
        else:
            fail("NAME_INVALID", "unknown action")
    except GuestError as error:
        sys.stdout.write(json.dumps({"ok": False, "protocol": PROTOCOL, "error": error.error, "detail": str(error.detail)[:400]}) + "\n")
        raise SystemExit(1) from None
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        sys.stdout.write(json.dumps({"ok": False, "protocol": PROTOCOL, "error": "GUEST_FAILED", "detail": f"{type(error).__name__}: {error}"[:400]}) + "\n")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
