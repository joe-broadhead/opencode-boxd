#!/usr/bin/env python3
"""OpenCode guest helper. One JSON object on stdin, one JSON object on stdout.

Talks only to a localhost OpenCode server. Never starts a blocking agent command.
"""

import base64
import json
import os
import secrets
import subprocess
import sys
import urllib.error
import urllib.request

PORT = 4096
PASSWORD_PATH = "/tmp/opencode-boxd/password"


class GuestError(Exception):
    def __init__(self, error, detail=""):
        self.error = error
        self.detail = detail


def fail(error, detail=""):
    raise GuestError(error, detail)


def emit(payload):
    sys.stdout.write(json.dumps({"ok": True, **payload}) + "\n")


def base_url(request):
    base = request.get("base") or f"http://127.0.0.1:{PORT}"
    if not (base.startswith("http://127.0.0.1:") or base.startswith("http://localhost:")):
        fail("base must be localhost")
    return base.rstrip("/")


def session_id(value):
    if not isinstance(value, str) or not value.startswith("ses"):
        fail("bad session id")
    allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
    if any(char not in allowed for char in value[3:]):
        fail("bad session id")
    return value


def directory(value):
    if not isinstance(value, str) or not value.startswith("/") or ".." in value.split("/"):
        fail("bad directory")
    allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_./-")
    if any(char not in allowed for char in value):
        fail("bad directory")
    return value


def guest_password():
    try:
        with open(PASSWORD_PATH, encoding="utf8") as handle:
            return handle.read().strip()
    except OSError:
        return ""


def http(method, url, body=None):
    data = None if body is None else json.dumps(body).encode()
    headers = {"content-type": "application/json", "accept": "application/json"}
    password = guest_password()
    if password:
        token = base64.b64encode(f"opencode:{password}".encode()).decode()
        headers["authorization"] = f"Basic {token}"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            raw = response.read().decode()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        fail(f"HTTP {error.code}", error.read().decode()[:400])
    except urllib.error.URLError as error:
        fail("unreachable", str(error.reason))


def unwrap(payload):
    if isinstance(payload, dict) and "data" in payload:
        return payload["data"]
    return payload


def action_info(request):
    unwrap(http("GET", base_url(request) + "/api/info"))
    emit({"server": "up"})


def action_serve(request):
    try:
        http("GET", base_url(request) + "/api/info")
        emit({"server": "up"})
        return
    except GuestError as error:
        if error.error.startswith("HTTP"):
            emit({"server": "up"})
            return
        if error.error != "unreachable":
            raise
    os.makedirs("/tmp/opencode-boxd", exist_ok=True)
    if not os.path.exists(PASSWORD_PATH):
        with open(PASSWORD_PATH, "w", encoding="utf8") as handle:
            handle.write(secrets.token_hex(16))
        os.chmod(PASSWORD_PATH, 0o600)
    log = open("/tmp/opencode-boxd.log", "ab")
    env = os.environ.copy()
    env["OPENCODE_PASSWORD"] = guest_password()
    subprocess.Popen(
        ["opencode", "serve", "--hostname", "127.0.0.1", "--port", str(PORT)],
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
        env=env,
    )
    emit({"server": "starting"})


def action_list(request):
    data = unwrap(http("GET", base_url(request) + "/api/session"))
    sessions = []
    for item in data or []:
        sessions.append({"id": item.get("id"), "parentID": item.get("parentID")})
    emit({"sessions": sessions})


def action_create(request):
    body = {"title": request.get("title") or "boxd"}
    created = unwrap(http("POST", base_url(request) + "/api/session", body))
    emit({"id": created.get("id")})


def action_prompt(request):
    sid = session_id(request.get("sessionID"))
    text = request.get("text")
    if not isinstance(text, str) or not text:
        fail("empty prompt")
    http("POST", base_url(request) + f"/api/session/{sid}/prompt", {"text": text})
    emit({"admitted": sid})


def action_export(request):
    sid = session_id(request.get("sessionID"))
    payload = http("GET", base_url(request) + f"/api/experimental/session/{sid}/export")
    emit({"export": payload})


def action_import(request):
    transfer = request.get("transfer")
    if not isinstance(transfer, dict) or "info" not in transfer or "messages" not in transfer:
        fail("import needs info and messages")
    body = {"info": transfer["info"], "messages": transfer["messages"]}
    if request.get("directory"):
        body["location"] = {"directory": directory(request["directory"])}
    try:
        imported = unwrap(http("POST", base_url(request) + "/api/experimental/session/import", body))
    except GuestError as error:
        # 2.2.6 keeps the transcript id. A second import of the same id is a conflict, not a failure.
        if error.error == "HTTP 409":
            emit({"id": transfer["info"]["id"]})
            return
        raise
    emit({"id": imported.get("id")})


def action_phase(request):
    sid = session_id(request.get("sessionID"))
    base = base_url(request)
    try:
        info = unwrap(http("GET", base + f"/api/session/{sid}"))
    except GuestError as error:
        if error.error.startswith("HTTP 404"):
            emit({"phase": "missing"})
            return
        raise
    if not isinstance(info, dict):
        emit({"phase": "missing"})
        return
    active = unwrap(http("GET", base + "/api/session/active")) or {}
    time = info.get("time") or {}
    busy = time.get("busy")
    idle = time.get("idle")
    if sid in active or (isinstance(busy, (int, float)) and (not isinstance(idle, (int, float)) or busy > idle)):
        emit({"phase": "busy"})
        return
    emit({"phase": "idle"})


def action_git(request):
    path = directory(request.get("directory"))
    status = subprocess.run(["git", "-C", path, "status", "--porcelain"], capture_output=True, text=True)
    if status.returncode != 0:
        fail("git status failed", status.stderr[-200:])
    sha = subprocess.run(["git", "-C", path, "rev-parse", "HEAD"], capture_output=True, text=True)
    remote = subprocess.run(["git", "-C", path, "remote", "get-url", "origin"], capture_output=True, text=True)
    branch = subprocess.run(["git", "-C", path, "branch", "--show-current"], capture_output=True, text=True)
    dirty = bool(status.stdout.strip())
    patch = ""
    if dirty:
        diff = subprocess.run(["git", "-C", path, "diff"], capture_output=True, text=True)
        patch = diff.stdout
    emit(
        {
            "remote": remote.stdout.strip() or None,
            "branch": branch.stdout.strip() or None,
            "sha": sha.stdout.strip() or None,
            "dirty": dirty,
            "patch": patch,
        }
    )


def action_prepare(request):
    path = directory(request.get("directory"))
    repo = request.get("repo")
    probe = subprocess.run(["git", "-C", path, "rev-parse", "--is-inside-work-tree"], capture_output=True, text=True)
    if probe.returncode == 0:
        emit({"prepared": path})
        return
    if not repo:
        subprocess.run(["mkdir", "-p", path], check=True)
        emit({"prepared": path})
        return
    if not isinstance(repo, str) or not repo.startswith("https://github.com/"):
        fail("repo must be an https GitHub URL")
    subprocess.run(["git", "clone", "--", repo, path], check=True)
    emit({"prepared": path})


ACTIONS = {
    "info": action_info,
    "serve": action_serve,
    "list": action_list,
    "create": action_create,
    "prompt": action_prompt,
    "export": action_export,
    "import": action_import,
    "phase": action_phase,
    "git": action_git,
    "prepare": action_prepare,
}


def main():
    try:
        request = json.load(sys.stdin)
        action = request.get("action")
        if action not in ACTIONS:
            fail("unknown action")
        ACTIONS[action](request)
    except GuestError as error:
        sys.stdout.write(json.dumps({"ok": False, "error": error.error, "detail": error.detail}) + "\n")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
