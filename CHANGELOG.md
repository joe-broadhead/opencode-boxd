# Changelog

All notable changes to this project are documented here. The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The icon is now boxd's own mark, boxd.sh's `favicon.svg`, unmodified, in place of the family's drawn mark; `opencode.vendor.mark` is `true`.

## [0.0.2] - 2026-11-13

### Added

- The `jelly` settings declare their choices: `access` is drawn as Allowed, Ask before changes or Read only, with
  Jelly's own line for each (needs a jelly that includes app#1301).

## [0.0.1] - 2026-11-12

### Added

- `GUEST_UNRESPONSIVE` and `GUEST_SERVER_DOWN`: a guest call that times out is followed by one probe of the machine,
  which reads `/proc` and the server's port and never talks to OpenCode. A machine under a tenth of its memory or over
  four load per CPU answers `GUEST_UNRESPONSIVE` with the free memory, the load and the three largest processes, and
  its one next step is to tell the user; one with nothing on the OpenCode port answers `GUEST_SERVER_DOWN`, which the
  next `boxd_job` fixes. A machine that looks well keeps `TIMEOUT`, with the facts, and a probe that does not answer,
  or answers with a line that is not JSON, keeps the plain timeout.
- `boxd_job` says what the session last did: `lastText`, its newest assistant text, redacted and cut to 300
  characters; `lastActivityAt`; and `pending`, the prompts waiting in its inbox. A run that completed but says its
  task did not happen, such as a push refused with 401, no longer reads like a finished one.
- `boxd_submit` answers `queued: true` when the session was still running, so the prompt waits in its inbox for that
  run. The read is a report, not a gate: a server that cannot say which sessions run still takes the prompt. A message
  of another kind than the one asked for is never read as the assistant's last words or a run's outcome.
- A machine that is down says why. `boxd_job`'s `asleep` answer and each work in status carry `asleepBy`:
  `boxd_sleep`, with the `sleptAt` the ledger recorded, or `idle_or_cli` for the idle bound or the boxd CLI. The plugin
  clears the record when it wakes or recreates the machine. A wake outside the plugin followed by a later idle
  hibernation still reads `boxd_sleep` with the older time: the plugin cannot see that wake.

- The skill covers many works from one Code Mode loop, where a guest's credentials come from and what a session should
  do on a 401, and how to look at a slow guest with the boxd CLI. The README and the golden-image page say that a
  short-lived token stops every guest once nothing renews it.

- The boxd CLI that runs inside a boxd machine is refused. It takes `--vm <name>` where the laptop CLI takes the machine
  as an argument, so the plugin's commands failed one by one and the awake bound ended as `AWAKE_UNBOUND`. Every tool now
  reads `boxd --help` once and, when it carries both phrases the in-VM CLI's help uses, answers `BOXD_MISSING`, saying the plugin drives remote machines from the laptop's CLI,
  before it changes anything. A CLI that cannot answer `--help` is not refused.

### Fixed

- `boxd_ensure` on an open work rewrote its ledger record from a short list of fields and dropped the rest: the files
  moved in and out and the last run's outcome. A drop then refused an output that a harvest had already brought back,
  and status lost a failed run. Ensure now keeps every field and clears only the create intent.
- `boxd_job` could report an earlier run's error, or none, for a failed run. The guest's message list is newest first,
  and the helper walked it oldest first and stopped at the first idle message. It now asks for the newest idle message
  only, so a credential failure after a completed run reports `GUEST_AUTH_FAILED` with its own error.
- A coded error's tool result kept only `error` and `next`, so a Code Mode program or a script never saw what happened.
  It is now `{ error, message, next }`. A timeout names its step, such as the guest's `phase` on `oc-<work id>`, and a
  `GUEST_FAILED` message carries the helper's error and detail, redacted, or the last line the machine wrote.
- `docs/scripting.md` said a plugin code arrives as the RPC error `failed`. It arrives as the method's output; only the
  four RPC codes are errors.
- A machine that rebooted, for example after a resize, lost the guest helper with its `/tmp`, and every tool call failed
  with `GUEST_FAILED` until OpenCode restarted. A call that gets no answer now lists `/tmp`, and only when the folder is
  clearly gone copies the helper again and runs once more. A crash, or a boxd CLI that failed, keeps its own error and
  is never run twice.
- The skill said `directory` moves the guest's folder and that `boxd_job` answers only busy, idle or missing. It now
  says `directory` is the laptop folder, names every job state, and says what `proof` `fresh`, `stale` and `missing`
  mean.

## [0.0.0] - 2026-11-10
<!-- kit-release: the GitHub release v0.0.0 -->

### Added

- Jelly shows and sets the `access` option, so the same restriction is one setting in every host (default `all`).
- Nine tools: `boxd_status`, `boxd_job`, `boxd_ensure`, `boxd_submit`, `boxd_harvest`, `boxd_sleep`, `boxd_resume`,
  `boxd_image` and `boxd_drop`. A tool returns when its request is admitted; nothing waits for a model.
- A ledger at `~/.local/share/opencode-boxd/works/`: the export, the patch and the git record are the laptop's copy of
  the session. Sleep, image and drop refuse until a harvest has proven the import on this laptop.
- Default permission rules, generated from the tool table and the `access` option, inserted directly after each agent's
  base allow. `boxd_drop` is allowed rather than denied, because its own guard makes data loss impossible and a deny
  would leave a machine billing.
- `/boxd-status` and the `/boxd` dialog, both rendering one status model, and the `boxd.machines` status RPC.
- Every tool as a method of the `boxd.machines.tools` RPC, with its class, so a script can call it with no model.
- A skill, `boxd`, and the `jelly` declaration with its icon.
- The plugin runs on OpenCode 2.2.3, 2.2.4, 2.2.5 and 2.2.6. The guest must run the same OpenCode version as the laptop.
- [docs/golden-image.md](docs/golden-image.md): how to build the image every machine boots from, and how to keep a model
  credential out of it.
- The `snapshot` option defaults to `opencode-golden`. Status says whether this account has it, and `boxd_ensure` and
  `boxd_resume` refuse with `SNAPSHOT_MISSING` before creating a machine.
- A missing machine is recognised on boxd 0.2 and on boxd 0.3, so `boxd_ensure` adopts it instead of failing.
- Files move in and out of a work. `boxd_submit` copies `files` in before the prompt; `boxd_harvest` copies them back
  after the transcript, into the work's laptop folder or `to`. A file is at most 8 MiB and a call at most 32 MiB, and
  each file is recorded by name, size and sha256.
- `allowedRoots` names laptop folders outside the project that work files may use.
- [docs/scripting.md](docs/scripting.md) has a worked `bookmarks.json` → `SUMMARY.md` example and the `external_directory`
  rule.

### Changed

- Every tool is allowed by default, reads and machine changes alike. The generated block allows `boxd_*` and each of
  the nine tools for `access: "all"` (the default), so an agent can create, run, save and destroy a billing machine
  without a prompt, and a tool a later release adds is allowed at once. `access` is the one option to restrict it:
  `"ask-changes"` lets the reads run and asks for every machine change, and `"read-only"` lets the reads run and denies
  the changes. A user's own rules come later and still win. The guards that do not depend on a prompt stay: a machine
  that idles hibernates, `boxd_sleep` always works, drop's own guard refuses anything the laptop cannot account for,
  and the ledger records a create before it runs.
- Every work has a laptop folder and a guest folder. The guest always works in `/home/boxd/work/<work id>`, and a laptop
  path is never sent to the machine. `boxd_ensure`'s `directory` names the laptop folder.
- A read never wakes a machine. `boxd_job` reports `asleep` for a hibernated work, with `boxd_resume` as the next step.
- Every wake arms the awake bound: 30 minutes, with `idle.ignore-outbound off`.
- `boxd_sleep` works when the guest cannot be harvested. It records a warning, and hibernating keeps the disk.
- `boxd_drop` refuses a directory that is not a git repository, and any untracked or ignored path that a harvest did not
  copy back. It stores tracked changes as `git diff HEAD` plus the untracked files' contents.
- The ledger is written per work, atomically through a unique temp file, and fails with `LEDGER_FAILED`. The ledger
  folder is 0700 and its files 0600.
- A session tree with a cycle fails with `EXPORT_INVALID` instead of recursing.
