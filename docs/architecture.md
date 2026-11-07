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
- A session's last run is `info.outcome` (`succeeded`, `failed`, `interrupted`) on `GET /api/session/<id>`, and the
  same outcome with the failure's structured error on the last `idle` message from `GET /api/session/<id>/message`. An
  export carries both, so a harvest reads the outcome from the transcript and `boxd_job` from the live session: no model
  call either way. `src/outcome.ts` maps them to `completed`, `failed` and `aborted`.
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

`opencode-golden` now exists in the account (version 1, 10.5 GiB, `ready`), built on 2026-11-07 from a stock machine.
It carries OpenCode 2.2.5 and holds no credential file of its own:

- The stock boxd image (2 vCPU / 8 GiB, `source: "standalone"`) carries `python3` 3.12.3, `git` 2.43.0, Node 24, the
  in-VM `boxd` CLI at `/usr/local/bin/boxd`, and **OpenCode 1.19.5** at `/usr/local/bin/opencode` →
  `/home/boxd/.opencode/bin/opencode`. There is no stock snapshot to name: a stock machine is created with no
  `--from-snapshot`.
- `opencode upgrade 2.2.5` from 1.x refuses: "OpenCode 2.2.5 is OpenCode 2. Upgrade with `opencode upgrade --major`".
  `opencode upgrade --major` installs the latest 2.x (2.2.6); a following `opencode upgrade 2.2.5` pins 2.2.5. Both
  steps take about 4 s.
- On 2.2.5, `opencode serve --hostname 127.0.0.1 --port 4096` reads **`OPENCODE_PASSWORD`** (falling back to
  `OPENCODE_SERVER_PASSWORD`): `/api/info` answered 401 without credentials and 200 with `opencode:<password>`, and
  reported `"version":"2.2.5"`. On 1.19.5 the same command ignores `OPENCODE_PASSWORD`, warns that the server is
  unsecured, and `/api/info` answers 200 to everyone.
- **`opencode auth login` needs a login shell.** `boxd machine exec --tty … -- opencode auth login` exits silently with
  no picker (`test -t 0` is true and `TERM` is set); `ssh -t <name>.boxd opencode auth login` and
  `boxd machine connect <name>` then `opencode auth login` both show it. `opencode auth list` names providers that come
  from environment variables as well as stored credentials (`… environment`), so a bare list is not proof of a sign-in.
- **`boxd-takeoff` injects the org and personal `boxd env` variables at every boot** into `/etc/profile.d/boxd-env.sh`
  (root, 0644), with the domain-bound values and boxd's CA bundle. The image can therefore hold no key: delete the file
  before `snapshots save`, and a machine created from the image regenerates it at boot (its mtime landed after the
  create). `auth.json` stayed absent, and `OPENCODE_API_KEY` was set in the new machine's environment.
- **A Go Teams service-account key does not call Go models.** The first real prompt on `opencode-golden` reached
  provider `opencode-go`, model `hy4`, and answered 403 `provider.auth`: "Go Teams covers workspace members, not service
  accounts. Use a personal API key to call Go models." The route works; the injected key was the wrong kind. Use a
  personal key with a spending limit.
- The 2.2.5 session export is `{info, messages}`, where each message is `{id, time, type, text?, model?, content?,
  finish?, error?}` and the session info carries `cost`, `tokens` and `outcome` (`ok`/`failed`). An assistant error is
  recorded on the message and the session outcome is `failed`, with cost 0.
- Port 4096 listens on `127.0.0.1` only (`ss -ltn`), and a machine created without `--shared`/`--isolated` prints
  `sharing: "private"`, `isolated: "no"`, `domains: "-"`: the port is not published.
- `checkGuest` compares `opencode --version` on the machine with the host's own. A machine from the stock 1.19.5 image
  fails it with `GUEST_VERSION`, and `boxd_sleep` still hibernates it.
- Two tools in one `Promise.all`: a `boxd_submit` and a `boxd_harvest` on the same work both returned; the admitted
  prompt made the guest busy, the harvest answered `SESSION_BUSY`, and the submit's `lastSubmitAt` left the previous
  proof `stale` in `boxd_job`. The ledger kept both calls' fields.

## The tools RPC

`boxd.machines.tools` is the family's v2 module, copied verbatim outside its plugin block: a script calls each tool with
no model, as a session and its agent. The rules decide: only a resolved `allow` runs, an `ask` is refused because no one
can answer it, and every change still asserts inside its own run.
