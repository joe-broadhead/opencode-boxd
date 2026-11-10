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
- `src/paths.ts` — the laptop path policy for files in and out: the project and `allowedRoots`, no symlink, an 8 MiB file
  and a 32 MiB call, and a temp-then-rename write that never replaces a local edit.
- `src/status.ts` — one model for the tool, the command, the dialog and the RPC.
- `src/tools.ts` — one table of nine tools: name, class, schema, description and run. The tools RPC, the transform, the
  default rules and status all derive from it.

## The work tree and the file trip

Every work has two folders, both recorded in the ledger: the laptop folder it belongs to (the project by default), and
the guest's own `/home/boxd/work/<work id>`, which the plugin creates and prepares. A laptop path is never sent to the
machine: the guest's `mkdir`/`clone` runs only under `/home/boxd/work`, and a guest that cannot prepare its own folder
fails `GUEST_WORKSPACE` with the guest's own words.

Data moves in and out of the work tree, never the whole disk:

- `boxd_submit` reads each `files` entry's laptop file, checks it (inside a root, not a symlink, within the caps), uploads
  it with `machine cp` before the prompt, and records name, size and sha256.
- `boxd_harvest` copies the requested work-tree paths back after the transcript import, through a temp file and a rename,
  0600, and refuses a symlink, a cap and a local edit since the last harvest. It records the same three facts.
- `boxd_drop` counts a harvested path as recovered while the guest still has the digest that was harvested, so a task
  that wrote `SUMMARY.md` can be dropped; a file that changed, or was never harvested, keeps the refusal.

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

Measured against `boxd` 0.2.29.

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
  **The round trip is byte-exact**: a text file and a JSON file uploaded from stdin and downloaded to stdout kept their
  sha256 on both sides, and so did a file the guest wrote with `machine exec`. Upload and download both use the work's
  guest directory (`/home/boxd/work/<work id>`), never a laptop path.
- **`boxd_ensure`'s `directory` is a laptop folder**, inside the project or an allowed root; the folder is created when
  it does not exist, and the ledger records it as `laptopDirectory` beside the fixed guest folder
  `/home/boxd/work/<work id>`. A laptop path never reaches the guest.
- **boxd 0.3.3 changed the missing-machine wording.** 0.2.29 answered `error: VM '<name>' not found`; 0.3.3 answers
  `error: no machine "<name>" in <region>` (for example `fra`). The plugin treats both as `missing`; a build that matched only
  "not found" failed every `boxd_ensure` with `BOXD_FAILED` until it was widened. `machine list --json` and
  `snapshots list --json` kept the same keys in 0.3.3.
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

The golden image is built from a stock machine. It carries OpenCode 2.2.5 and holds no credential file of its own:

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
- **A service-account key may not call model providers.** A provider answered a service-account key with 403
  `provider.auth`, saying it covers workspace members, not service accounts. The route works; use a personal key with a
  spending limit.
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

### boxd 0.3.3, measured on 2026-11-10

Measured with `boxd` 0.3.3 on one account, a golden image on OpenCode 2.2.6, and throwaway machines named `oc-lc-*`, all
removed afterwards. Each item gives the command and what it answered.

**Argv and CLI shapes**
- `machine new <name> --from-snapshot opencode-golden --label role=session --label work=<id> --json` answered
  `{"boot":"10ms","name":…,"source":"snapshot/opencode-golden","url":…}`. The create took 1 s. `machine get --json`
  then gave `auto_hibernate: "14400s"`, `auto_suspend: "off"`, `idle_ignore_outbound: "off"`, `sharing: "private"`,
  `isolated: "no"`, and the labels.
- `machine config set <name> auto-hibernate.timeout 1800` answered `auto-hibernate for <name>: 1800s`, and
  `config get <name> auto-hibernate.timeout --json` answered `{"key":"auto-hibernate.timeout","value":"1800s"}`. The
  same for `idle.ignore-outbound on` and `off`.
- `machine hibernate` answered `{"status":"hibernating"}`, `wake` answered `waking`, `stop` `stopped`, `start` `starting`,
  `pause` `{"status":"standby","suspend_us":…}` and `resume` `{"status":"running",…}`. `machine remove <name> -y --json`
  answered `{"name":…,"status":"destroyed"}`.
- `snapshots save <machine> <name> --json` answered `{"size_bytes":…,"status":"ready","version":1}` in 2 s for a
  9 GiB disk.
- `machine cp - <name>:<path>` read stdin and answered `copied - → <name>:<path> (12739 bytes)`. `machine exec <name> --
  python3 <path>` passed stdin through and returned the helper's JSON. Downloading the helper back to stdout matched the
  repository copy byte for byte.

**Billing and idleness**
- `boxd manage usage --json` reports `running_seconds`, `standby_seconds`, `hibernated_seconds` and `stopped_seconds` per
  machine, with `ram_gib_hours`, `vcpu_hours`, `disk_gib_hours` and a cost in micro-EUR. The rates are 12000 for RAM,
  39000 for vCPU and 80 for disk, per hour. Its values can lag by several minutes (`complete: false`).
- Hibernated time bills disk only. Over 300 s of hibernation: `hibernated_seconds` +300, `running_seconds`
  unchanged, `ram_gib_hours` and `vcpu_hours` unchanged, `disk_gib_hours` +0.62, cost +50 micro-EUR.
- `wake` did not reset a configured `auto-hibernate.timeout`: 1800 s before the hibernate and after the wake.
- With a 90 s timeout and `idle.ignore-outbound off`, one inbound `machine exec` at +60 s reset the timer. The machine
  was still running at +128 s and hibernated by +220 s.
- With a 90 s timeout and `idle.ignore-outbound on`, outbound requests from the guest did not keep the machine awake: it
  was hibernated at +128 s while the requests ran until about +120 s.
- Hibernate keeps the guest's memory: a background process survived hibernate and wake. `stop` and `start` clear `/tmp`
  and the running processes, and keep `/home`.
- Stop and hibernate cost are not separated by this run: the usage report lagged across the stop window.

**Provisioning**
- A create from the golden snapshot took 1 s.
- A client killed 0.3 s and 0.8 s into `machine new` left no machine. Killed at 1.2 s, the machine landed and was
  `running`. `boxd_status` listed it as an orphan, and `boxd_ensure` with the matching work id adopted it. Adoption
  leaves its old `work=` label in place.

**Status strings from `machine get --json`**
- `running`; `hibernated` (for a few seconds after `hibernate`, `get` read `standby`); `standby` after `pause`; `stopped`
  after `stop`; `starting` after `start`.
- A removed or never-created machine: `error: no machine "<name>" in fra` on stderr, exit 1. `remove` answers
  `destroyed` before that.

**Golden image on OpenCode 2.2.6**
- `opencode --version` is `2.2.6`. `git`, `python3` and `boxd` are present. `OPENCODE_API_KEY` is set in the environment
  (its value was not printed), and `/etc/profile.d/boxd-env.sh` exists.
- `OPENCODE_PASSWORD=probe opencode serve --hostname 127.0.0.1 --port 4096` answered `/api/info` with 401 without
  credentials and 200 with `opencode:probe`. It listened on `127.0.0.1` only, and a connection from the laptop to the
  machine's public address on port 4096 failed.

**Work path**
- `boxd_ensure`, `boxd_submit`, `boxd_job` (`idle`, `completed`), `boxd_harvest` (`proven`, `completed`), `boxd_sleep`
  (`hibernated`) and `boxd_resume` (`wake`) ran in that order on one work.
- After a `machine remove` from the CLI, `boxd_resume` rebuilt the work from the golden snapshot and imported the
  transcript (`resumed: import`). This happened twice, and the guest helper was uploaded each time, with the same
  sha256 as the repository's `guest/guest.py`.
- `boxd_image` from a machine with a fresh proof saved the snapshot (`state: saved`).
- A machine on OpenCode 2.2.5, made from a snapshot taken with the CLI: `boxd_ensure` answered `error: GUEST_VERSION`, and
  `boxd_sleep` hibernated it.
- With `opencode serve` killed during a run, `boxd_job` answered `MACHINE_STARTING` and `boxd_harvest` answered
  `SESSION_BUSY`. `boxd_resume` restarted the server and answered `state: busy`, with no coded error. `boxd_sleep`
  hibernated the machine.
- A session whose run was killed stays busy. The guest's `time.busy` stays later than `time.idle` with nothing active,
  so `boxd_job` never reports idle. A new prompt through `boxd_submit` ran to `idle` and `completed`, and that cleared it.
- Drop refusals and the one drop that succeeded: a non-git guest folder gives `GIT_UNKNOWN`. An untracked file gives
  `UNTRACKED`, and so does an ignored file, which harvest lists under `ignored`. A staged change gives harvest
  `dirty: true, patchStored: true`, and `boxd_drop` then answers `state: dropped` and the machine is gone.
- `boxd_job` on a hibernated work answered `asleep` with `machineStatus: hibernated`. The machine stayed hibernated, and
  its usage did not change.
- After a wake from `boxd_ensure` or `boxd_resume`, `auto-hibernate.timeout` was 1800 s and `idle.ignore-outbound` was
  `off`.
- `boxd_sleep` on a work that never had a prompt warned that its prompt was not harvested. It now warns only when a
  prompt was submitted.
- Harvest's next step said "the tree is clean" for a tree with a stored patch. It now says the change is kept as a patch.
- `SESSION_BUSY`'s next step said to wait for idle. After a killed run that never comes, so it now also names a new
  prompt through `boxd_submit`.
- The first `boxd_submit` after an image answered `GUEST_FAILED`, and `boxd_job` 30 s later answered `MACHINE_STARTING`,
  while the server process was still listed. It did not recur, and its cause is not known.

**Concurrency**
- A `boxd_submit` and a `boxd_harvest` on one work, in flight together, both returned. The ledger kept the root session,
  the submit's `lastSubmitAt` and the proof. The harvest was recorded after the submit's stamp, so the proof was fresh.
  A submit made after a harvest marks the proof `stale` at once: status showed `stale`, and a harvest made it `fresh`.
- Two `boxd machine config set` calls on one machine at once both exited 0, neither was refused, and one value stayed.

## The tools RPC

`boxd.machines.tools` is the family's v2 module, copied verbatim outside its plugin block: a script calls each tool with
no model, as a session and its agent. The rules decide: only a resolved `allow` runs, an `ask` is refused because no one
can answer it, and every change still asserts inside its own run.
