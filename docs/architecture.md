# Architecture

The plugin has one job: keep the transcript on the laptop while the session runs on a boxd machine.

```
OpenCode (laptop)                     boxd machine                   laptop
┌──────────────────┐   boxd CLI   ┌────────────────────┐   export   ┌──────────────┐
│ boxd_* tools     │ ───────────▶ │ OpenCode on :4096  │ ─────────▶ │ opencode     │
│ ledger + status  │ ◀─────────── │ guest/guest.py     │            │ session      │
└──────────────────┘  JSON lines  └────────────────────┘            │ import       │
        │                                                           └──────────────┘
        └── ~/.local/share/opencode-boxd/works/<id>/  (exports, patch, work.json)
```

## The pieces

- `src/plugin.ts` — one `Plugin.define`: options, host check, the fleet, the default rules, the skill, `/boxd-status`,
  the status RPC, the tools RPC and the tool transform.
- `src/fleet.ts` — the control plane: ensure, submit, job, harvest, sleep, resume, image, drop. It refuses to sleep,
  image or drop work whose laptop import is not fresh, and refuses to drop a machine it does not own.
- `src/cli-boxd.ts`, `src/cli-guest.ts`, `src/prover.ts` — the three ports, each a thin wrapper over a command. Every
  argument is an argv array, never a shell string.
- `guest/guest.py` — the helper copied to the machine. It speaks one JSON object in and one out, and talks only to
  `127.0.0.1`.
- `src/ledger.ts` — the laptop's store: atomic writes, one lock per work, 0700/0600 modes.
- `src/status.ts` — one model for the tool, the command, the dialog and the RPC.
- `src/tools.ts` — one table of nine tools: name, class, schema, description and run. The tools RPC, the transform, the
  default rules and status all derive from it.

## Why the guest is not the session

A boxd snapshot is an image. Booting one restores a disk, not a transcript, and a shared machine deletes OpenCode's
sign-in. So the transcript moves by export and import: the guest exports the session tree, this laptop imports it parents
first, and only then may the machine sleep, be imaged or be destroyed.

## Platform facts

- `opencode session import` keeps the transcript's id on 2.2.3–2.2.6, and answers `Session already exists` (exit 0, no
  id) for an id already present. `test/unit/prover.test.ts` runs this against each stock binary.
- The ledger writes atomically (a unique temp file, a rename) and serialises per work, so two tools in one script cannot
  lose each other's fields. `submit` stamps `lastSubmitAt` before the prompt, so a crash fails towards "stale".
- The import runs with `--standalone`, so it never depends on a service being up.
- `POST /api/session` creates a session, `POST /api/session/<id>/prompt` admits one, and
  `GET /api/experimental/session/<id>/export` and `POST /api/experimental/session/import` move one. The guest helper is
  the only code that speaks these.

### The boxd CLI, confirmed against 0.2.29

Measured on 2026-11-07 against `boxd` 0.2.29 (`brew`-style `~/.local/bin/boxd`) and one real account.

- `machine new <name> --from-snapshot <snapshot> --label role=session --label work=<id> --json` is accepted, and the labels
  are set. `--label` is repeatable, `key=value`. A `work=` value is an opaque string; the plugin's short lowercase rule
  is its own, not boxd's.
- **`machine new --json` is not a machine.** It answers `{"boot":"11ms","id":…,"name":…,"paused_automations":0,
  "source":"snapshot/<name>","url":…}`: no `status`, no `sharing`, no `isolated`. The CLI wrapper therefore reads the
  machine back with `machine get` after a create; otherwise the create turn cannot see a shared or isolated machine,
  and a `boot` duration such as `"11ms"` parses as no status at all.
- `machine get <name> --json` prints `name, id, status, size, url, ssh, public_ip, domains, source, created,
  auto_suspend, auto_hibernate, idle_ignore_outbound, bot_protection, auto_destroy, delete_after, sharing, networks,
  isolated, egress, labels, vcpu, memory_bytes`. **`isolated` is the string `"no"` or `"yes"`, not a boolean**, and
  `auto_hibernate`/`auto_suspend` are durations such as `"14400s"` or `"off"`.
- The lifecycle strings `machine get` prints are `running`, `starting`, `hibernated`, `standby`, `stopped`, and
  `hibernating`/`rebooting`/`waking` while a transition is in flight. `hibernate` answers `hibernating`, `wake` answers
  `waking`, `pause` answers `standby`, `resume` answers `running`, `stop` answers `stopped`, `start` answers `starting`,
  and `remove --json` answers `{"name":…,"status":"destroyed"}`. A removed machine's `get` is
  `error: VM '<name>' not found` on stderr with exit 1, which the plugin reads as `missing`; `destroyed` is only the
  remove command's answer. `suspended`, which an older mapping expected, is never printed.
- `machine list --json` lists every machine in the account with `name, status, size, url, source, sharing, ttl, labels,
  delete_at_ms, vcpu, memory_bytes` — no `isolated` and no `id`.
- `machine config set <name> auto-hibernate.timeout <seconds>` and `… idle.ignore-outbound on|off` are accepted; the
  matching `config get` answers `{"key":…,"value":"1800s"}` and `{"key":…,"value":"off"}`. A new machine defaults to
  `auto_hibernate: "14400s"`, `auto_suspend: "off"`, `idle_ignore_outbound: "off"`, `bot_protection: "on"`.
- `machine cp - <name>:/path` reads stdin (`copied - → <name>:/path (N bytes)`) and `machine cp <name>:/path -` writes
  stdout. `machine exec <name> -- <cmd>` passes stdin through and returns the command's stdout; `--json` wraps it as
  `{"output":"…","exit_code":0}`. A command that reads stdin works without `--tty`.
- `snapshots save <machine> <name> --json` answers `{"name":…,"paused_automations":0,"size_bytes":…,
  "snapshot_id":…,"status":"ready","version":1}`; a 9 GiB disk took 2 s. `snapshots list --json` prints
  `name, version, status, storage, archived, size, used`. `snapshots remove <name> -y --json` exists and answers
  `{"deleted":…}`.
- `machine pause` returns `{"status":"standby","suspend_us":…}` and `machine resume` `{"status":"running","resume_us":…}`;
  a paused machine stays `standby` in `get`. `stop` keeps the disk and clears the running state; `hibernate` writes memory
  and disk. Both come back by `machine wake`, not by `machine start`.
- `boxd auth` with no subcommand lists the signed-in account and its orgs; `auth login` is the browser sign-in the plugin
  never runs. One account can see exactly one org's machines and snapshots.
- Two `boxd` commands can run at once (a concurrent `machine list` and `snapshots list` both exited 0); the client does
  not serialise them behind a lock that a second command would fail on.

### Provisioning and money

- A create from a 9 GiB snapshot answered in **0.55 s** wall time (the reported `boot` was 11 ms) and the machine was
  `running` on the first `get`. A standalone create answered in 0.005 s of reported boot. The plugin's 30 s create
  timeout was never approached, so its timed-out-create adoption path cannot be reached by a healthy account; it stays
  covered only by the unit and host tests.
- `machine usage --json` reports `running_seconds`, `standby_seconds`, `hibernated_seconds`, `stopped_seconds`,
  `vcpu_hours`, `ram_gib_hours`, `disk_gib_hours`, `cost_micro` and the rate card (`vcpu_hour_micro: 39000`,
  `ram_gib_hour_micro: 12000`, `disk_gib_hour_micro: 80` for a 2 vCPU / 8 GiB / 100 GiB machine). A `manage usage` window
  shows the same states per machine.
- A hibernated machine bills **disk only**: boxd's own FAQ says a machine "hibernates and pays for disk only". Compute
  (vCPU and RAM hours) accrues only while running or in standby. `stop` and `hibernate` both bill disk only while down;
  they differ in what survives (`hibernate` keeps memory and running processes, `stop` keeps the disk).
- `auto-hibernate.timeout` is **14400 s (4 h)** on a new machine, before the plugin sets 1800 s. A `wake` does **not**
  reset it: a machine the plugin put at 1800 s was still 1800 s after a hibernate/wake cycle.
- With `idle.ignore-outbound off`, **inbound `machine exec` traffic resets the idle clock**: a machine with a 60 s
  timeout auto-hibernated after 75 s of silence, and stayed `running` for 75 s when an exec arrived every 25 s. That is
  the basis for the claim that a crashed laptop stops paying after the 30-minute bound: no calls, no traffic, sleep.

### The golden image

The account this was checked against had no `opencode-claude-final` snapshot, so the golden image was rebuilt for the
run from a stock machine, deleted afterwards:

- The stock boxd image (2 vCPU / 8 GiB, `source: "standalone"`) carries `python3` 3.12.3, `git` 2.43.0, Node 24, the
  in-VM `boxd` CLI at `/usr/local/bin/boxd`, and **OpenCode 1.19.5** at `/usr/local/bin/opencode` →
  `/home/boxd/.opencode/bin/opencode`.
- `opencode upgrade 2.2.5` from 1.x refuses: "OpenCode 2.2.5 is OpenCode 2. Upgrade with `opencode upgrade --major`".
  `opencode upgrade --major` installs the latest 2.x (2.2.6); a following `opencode upgrade 2.2.5` pins 2.2.5. Both
  steps take about 4 s.
- On 2.2.5, `opencode serve --hostname 127.0.0.1 --port 4096` reads **`OPENCODE_PASSWORD`** (falling back to
  `OPENCODE_SERVER_PASSWORD`): `/api/info` answered 401 without credentials and 200 with `opencode:<password>`, and
  reported `"version":"2.2.5"`. On 1.19.5 the same command ignores `OPENCODE_PASSWORD`, warns that the server is
  unsecured, and `/api/info` answers 200 to everyone.
- Port 4096 listens on `127.0.0.1` only (`ss -ltn`), and a machine created without `--shared`/`--isolated` prints
  `sharing: "private"`, `isolated: "no"`, `domains: "-"`: the port is not published.
- `checkGuest` compares `opencode --version` on the machine with the host's own. A machine from the stock 1.19.5 image
  fails it with `GUEST_VERSION`, and `boxd_sleep` still hibernates it.
- The guest's OpenCode is unauthenticated. A prompt is admitted, the session goes idle, and the export/import round trip
  still works; no model answer is produced without provider credentials, which the plugin never copies to a machine.

## The tools RPC

`boxd.machines.tools` is the family's v2 module, copied verbatim outside its plugin block: a script calls each tool with
no model, as a session and its agent. The rules decide: only a resolved `allow` runs, an `ask` is refused because no one
can answer it, and every change still asserts inside its own run.
