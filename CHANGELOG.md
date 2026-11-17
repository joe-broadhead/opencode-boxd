# Changelog

All notable changes to this project are documented here. The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The `boxd.works` source** under the source contract (`package.json`'s `sources`, contract version 1), for Memory's
  collector and other scripts. `events_list` lists each phase change of this laptop's works as one event, oldest first,
  read from the ledger's `events.jsonl` only: no boxd call, no machine woken, no lock taken. An event's title and labels
  are the plugin's own words (the work id, the phase, how a run ended, its code, who put a machine to sleep), never a
  prompt, a transcript or guest text, and a title that holds a secret is refused. The cursor is the log's sequence
  number; one the log no longer keeps answers `gap: { reason: "expired" }`. `probe` names the account (this computer)
  and its owner (`os-user:<user>@<computer>`). Both are tools RPC methods, `boxd_events_list` and `boxd_probe`, which
  every `access` value allows. While the v0 import runs, `events_list` answers `UNAVAILABLE`.
- **`npm run conformance`** runs the source contract's conformance kit over the source and writes
  `reports/conformance-report.json`, which the release attaches.

### Changed

- The tools RPC is the source contract package's `tools-rpc` module (v0.2.0), bundled into `dist/index.js`, in place of
  the copied module; boxd's methods, codes and next steps are unchanged.
- The server bundle, `dist/index.js`, is minified (whitespace and syntax, not names), so the package stays within its
  size budget with the contract's modules inside. The TUI bundle is not, so OpenCode can resolve its host imports.

### Fixed

- A read of the ledger's event log that raced the log's rotation could skip the events the rotation moved, with no
  `gap`, or read as an expired cursor. The two files are now read as one consistent pair, read again while a rotation
  is under way; `boxd_status`'s cursor reads the same way.

## [0.1.0] - 2026-11-16

### Breaking

v0.1.0 redesigns the plugin and breaks compatibility on purpose: the tools, the result shapes, the ledger format, the
options and the guest helper all change. Works that ran on v0.0.x are imported, not stranded.
[docs/v1-design.md](docs/v1-design.md) is the design.

**Upgrading from v0.0.6.** Remove the old entry and add the new tag:
`opencode plugin remove github:joe-broadhead/opencode-boxd#v0.0.6`, then
`opencode plugin add github:joe-broadhead/opencode-boxd#v0.1.0`. If you set the option `snapshot`, remove it first:
remove `snapshot` (images are now built from stock); set `goldenBase` only to build on a hand-made base without model
credentials. A left-over `snapshot` stops the plugin with `OPTIONS_INVALID`. Keep the boxd CLI signed in: the import
below needs it.

**What the first start does.** It imports the v0 ledger, `~/.local/share/opencode-boxd/works/`, once into a new
`~/.local/share/opencode-boxd/v1/`:

- **Every tool waits for it.** Until the import is complete every tool, reads included, answers `LEDGER_IMPORTING`
  with `progress: { done, total }`, and the same call again in a few seconds goes through. Nothing reads a partial
  ledger. A second OpenCode process on the laptop does not import: it answers `LEDGER_IMPORTING` until the first one
  has finished.
- **It reads boxd once.** One fresh `boxd machine list --region all` finds each work's region, and one `machine get`
  per machine found records its id. If the listing fails (signed out, offline), no `v1/` is made: every tool answers
  `IMPORT_V0_FAILED` with the CLI's reason, and the next tool call after 30 s, or a restart, tries again. A work whose
  machine is in no region reads as `gone`.
- **Crash-safe, all or nothing.** The import builds the whole ledger in a staging folder of its own,
  `v1.importing-<pid>-<random>/`, and publishes it as `v1/` in one rename, after it has written its `complete` marker. A
  crash, a quit or a reload before that leaves no `v1/`: the next start deletes the staging folder and imports again,
  from the untouched v0 records. Exports, patches and untracked files are copied, never linked, so the import needs the
  disk space of one more copy of them.
- **A bad record blocks only its own work.** A v0 record that cannot be read or mapped is listed with its reason in
  `v1/import-v0.json`, its file is left as it is, and that work id alone answers `IMPORT_V0_FAILED`. Fix or remove the
  file and restart OpenCode: the id is imported into `v1/` then.
- **The v0 records are not changed.** The one addition is a folder, `works/README-MOVED-TO-v1/`, holding only a
  `README.md` that says the works moved and when going back is safe. It is a folder, not a file, so v0.0.6 skips it.
- **After the import.** A laptop copy of a transcript harvested twice under v0 may be the older one (F1): every imported
  work with a harvest is marked as an unverified laptop copy, `boxd_status` lists them under `laptop-copy`, and
  `boxd_harvest({ works })` replaces them in one call. **Harvest imported works before dropping them:** until a
  harvest has verified its laptop copy, `boxd_drop` refuses such a work (`NOT_SAVED`, next `boxd_harvest`),
  `select: "saved-finished"` skips it, `select: "unsaved-finished"` takes it, and `/boxd-cleanup` offers it under
  "Harvest imported works first", never under the drop. A running v0 machine keeps running, busy or not: reads use its
  own v0 helper, read-only, and the first change tool for it copies its server password to `~/.opencode-boxd/`. A v0
  machine whose `/tmp` a reboot cleared answers `GUEST_FAILED` until `boxd_ensure({ workId })` sets it up again.

**Going back to v0.0.6** is safe **only before v0.1.0's first change** (a submit, harvest, drop or reassign). After
one, the v0 records still carry their old proof, and v0's drop could accept a proof that a later prompt made stale and
destroy work that was never harvested. To go back: `opencode plugin remove github:joe-broadhead/opencode-boxd#v0.1.0`,
then `opencode plugin add github:joe-broadhead/opencode-boxd#v0.0.6`, and take out every option v0.0.6 does not know
(it accepts only `snapshot`, `allowUntestedHost`, `allowedRoots` and `access`). What it keeps: v0.0.6 reads `works/`
exactly as it was before the upgrade. It sees nothing in `v1/`: no work v0.1.0 created, and none of its submits,
harvests, drops or reassigns. The machines v0.1.0 created stay, and bill until destroyed: boxd hibernates each after
its idle timeout (2 h by default), and `boxd machine remove oc-<work id> -y` destroys one. `v1/` stays on disk;
upgrading again uses it as it is and imports nothing new, so a work v0.0.6 created after the rollback is not in it.

**Renamed and removed, at a glance.** The tool `boxd_image` is gone; `boxd_golden` builds images instead, and never
saves a work's machine. The option `snapshot` is removed: images are now built from stock, and `goldenBase` is only
the hand-made base a build may start from. Inputs and fields: `vcpu` is `size`, `queued` is `delivery`, `pending` is
`waiting`, `proof` is `saved`; the phases `empty` and `missing` are gone. The codes
`NOT_PROVEN`, `SNAPSHOT_MISSING`, `GUEST_RUN_FAILED`, `PARENT_MISSING` and `SNAPSHOT_EXISTS` are renamed or gone, as
below. The details:

- **Tools.** `boxd_image` is replaced by `boxd_golden`; `boxd_read`, `boxd_exec` and `boxd_reassign` are new, so there
  are twelve. Every result has `state`, a refusal too (`refused`, `failed`, `unreachable`, `busy`, `starting`, `gone`,
  `asleep`, `cancelled`) beside `error`, `message` and `next`, and `next` is one concrete call. List forms take
  `works: [...]` (1 to 300) and return `{ state, counts, results }`, in input order.
- **Words.** `proof` is now `saved` (`fresh`, `stale`, `none`). One phase vocabulary for every tool: `creating`,
  `starting`, `ready`, `busy`, `idle`, `asleep`, `gone`, `unreachable`, `closed`; `empty` and `missing` are gone.
- **Codes.** `NOT_PROVEN` is `NOT_SAVED`; `SNAPSHOT_MISSING` is `GOLDEN_MISSING`; `GUEST_RUN_FAILED` is `RUN_FAILED`;
  `PARENT_MISSING` is folded into `EXPORT_INVALID`; `SNAPSHOT_EXISTS` is gone. New: `NOT_REASSIGNABLE`,
  `MACHINE_LIMIT`, `SIZE_UNAVAILABLE`, `GOLDEN_BUILD_FAILED`, `GOLDEN_HAS_CREDENTIAL`, `MACHINE_ASLEEP`,
  `AGENT_UNREACHABLE`, `SESSION_MISSING`, `IMPORT_FAILED`, `CANCELLED`, `LEDGER_LOCKED`, `LEDGER_IMPORTING`,
  `IMPORT_V0_FAILED` and `BUDGET_REACHED`, and the warnings `UNHARVESTED_SLEEP`, `BUDGET_WARN`, `BUDGET_UNKNOWN`, `LEASE_EXPIRING`,
  `AUTOMATION_BLOCKED` and `NO_MODEL_CREDENTIAL`.
- **`boxd_submit`.** `queued` is replaced by `delivery` (`steer`, `queue`, `started`), and `mode` (`steer`, `queue`,
  `interrupt`) chooses it: the old submit already steered, and called it queued.
- **`boxd_ensure`.** `vcpu` is now `size` (`1x4`, `2x8`, `4x16`, `8x32`), applied by the image rather than a resize;
  `wait` is now `"ready" | "created" | "none"` and defaults to `"ready"` (`"created"` for a list of more than 50);
  `region` picks `fra` or `nyc`; `repo`, `ref` and `git` set the guest up in the same call.
- **`boxd_status`.** It lists only the works that need a decision (`attention`, worst first, at most `limit`, with
  `more`), folds repeated causes into `groups`, returns a `cursor` that `since` takes, and adds `regions`, `orphans`,
  `fleet`, `cost`, `cleanup`, `automation` and `health`. It never reads an idle or hibernated guest. `credentials`,
  per-work cost, golden images and closed works come only with `include`.
- **`boxd_job`.** `pending` is replaced by `waiting: { steer, queue }`; `tail` takes 1 to 20; `cost` adds the work's
  machine and model cost. It answers a hibernated work from the listing and the ledger, and never wakes it.
- **The ledger** moves to `~/.local/share/opencode-boxd/v1/`; v0 records are imported once, all or nothing, and left
  untouched apart from a `works/README-MOVED-TO-v1/` note folder (above). Until the import is complete every tool
  answers `LEDGER_IMPORTING`. **Going back to v0.0.6 is safe only before v0.1.0's first change** (a submit, harvest,
  drop or reassign): after that, v0's drop could accept a stale proof and destroy unharvested work.
- **By id.** Every change acts on the machine id the ledger recorded; a name that now points at another machine is
  refused with `NOT_OURS`, and no adoption takes a machine another open work records, even with `adopt: true`. A
  machine counts as gone only when a fresh all-region listing and a `get` of the recorded id find it nowhere.
- **Golden images.** The option `snapshot` is gone (`goldenBase` is only a build's base); images are built by the plugin from a recipe,
  per region and size, and named `<goldenPrefix>-<opencode version>-<size>`. `boxd_golden` never saves a work's machine,
  so `boxd_image`'s path is gone.
- **Model credentials are never baked into an image.** A base that holds `auth.json` is refused
  (`GOLDEN_HAS_CREDENTIAL`), so v0's fallback of `opencode auth login` on the image builder is gone. Give works a key
  as a sealed, host-bound `boxd env` secret, a secret per provider, or sign in on one work's own machine after
  `boxd connect`.
- **Notices** go only to the work's root coordinator: the session that started or last drove it from the model path,
  found by walking up from a subagent. A script's own session gets none unless it names one with `notify`. At most one
  notice a minute per coordinator, and never a guest's text.
- **The guest helper** lives in `~/.opencode-boxd/` on the machine, not `/tmp`, and a read never uploads it.
- **Harvest** never overwrites the last good export until the new one is verified, and drop also checks the guest's own
  session marks, so a prompt that bypassed the plugin blocks the destroy.
- **Cost and cleanup.** Every new work machine is created with auto-suspend off, auto-hibernate at 2 h and
  `idle.ignore-outbound` off, at every `access` level. At `access: "all"` the plugin now harvests a finished work
  and then hibernates it after 10 idle minutes, orphans included; at "ask-changes" and "read-only" only with
  `automation: "on"`, which is the person's consent. It never drops anything by itself. `boxd_status` adds `cost` and
  `cleanup`; `boxd_sleep`, `boxd_harvest` and `boxd_drop` take `select`; `/boxd-cleanup` is new and confirms each
  action with a permission prompt only a person answers. A coordinator session gets one short fleet line at the end of
  a request when the fleet changed; the system prompt is never changed, so the prompt cache holds. The new options are
  `automation`, `leaseDays` and `budget`; the last two are off by default.
- **Options.** New: `region`, `keepFree`, `size`, `git`, `goldenPrefix`, `goldenBase`, `goldenSetup`, `buildGolden`,
  `notices`, `autoHibernateMinutes`, `automation`, `autoSleepMinutes`, `orphanHours`, `leaseDays`, `budget`,
  `costContext` and `idleCheck`. Removed: `snapshot`.
- **`/boxd-status`** shows the golden image, works by phase, the works that need a decision, each region's machines,
  a Cost row, automation and notices, and health; the Snapshot row is gone.

### Added

- One runner owns every child process: at most 12 boxd processes for tool calls and reads, 4 for `boxd_exec` and 2
  laptop imports, each with a timeout, the call's stop signal and an output cap. Status reports the worst event-loop
  delay of the last 5 minutes.
- The watcher: a sweep while any work is busy, which appends each phase change to `events.jsonl` and hands it to
  automation and the notices.

### Fixed

- A second harvest now replaces the laptop's copy of the transcript (F1).
- Stop now ends a tool call and its processes (F2).
- A missing machine is read only from boxd's exact not-found words in the region asked, so an unknown flag or a machine
  in the other region is never read as missing (F4).
- A laptop upgrade no longer blinds reads: `boxd_status` and `boxd_job` work across guest versions (F6).
- On a slower laptop with many busy works, every guest read queued behind the others still runs: a read whose listing
  aged in the queue retries on a fresh one in order, until the call's bound, rather than reading as stale after ten
  tries.

### Changed

- The host range is unchanged: `>=2.2.3 <2.4.0`, tested on 2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7 and 2.3.0.

## [0.0.6] - 2026-11-15

### Added

- **For jelly:** `jelly.cost`, the line jelly shows on the plugin's review before it installs: "boxd bills your boxd
  account or organisation for each machine the plugin creates: compute and disk while it runs, disk only while it
  hibernates, until boxd_drop destroys it. An idle machine hibernates, and boxd_job never wakes one."

### Changed

- The host range is unchanged: `>=2.2.3 <2.4.0`, tested on 2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7 and 2.3.0.

## [0.0.5] - 2026-11-15

### Added

- `boxd_status` reads the whole fleet in one call (#1): each work's `phase` (`busy`, `idle`, `empty`, `asleep`,
  `starting`, `gone`, `missing` or `unreachable`) and last `outcome`, and for a running work whose last prompt is not
  harvested, `lastActivityAt`, `lastText` and `pending`, read from every guest in parallel with a bound per machine. A
  guest that does not answer is `unreachable` with its code, reason and next step, and the other works still report. A
  harvested work's guest is not read, so a status loop does not keep an idle machine awake. `/boxd-status` is unchanged.
- `boxd_status` lists the account's sealed variables as `credentials`: name, scope and bound hosts, never a value.
- `boxd_job` takes `tail` (1 to 10) and returns the session's newest assistant messages, oldest first, redacted and cut
  to 300 characters each, without a harvest.
- `model` on `boxd_ensure` (the work's default, for the session its first prompt creates) and on `boxd_submit` (a new
  session starts on it; an idle one switches to it; a running one refuses with `SESSION_BUSY`).
- `vcpu` on `boxd_ensure`: 1, 2, 4 or 8. boxd keeps a snapshot's size on a machine made from it, so the size is applied
  by a resize right after the create, before anything runs, and again when `boxd_resume` rebuilds the machine. A machine
  that is already there keeps its size, and the answer says so.
- `wait: true` on `boxd_ensure` and `boxd_submit` waits up to 30 s for the machine and its OpenCode instead of answering
  `starting`.

### Changed

- Every answer has a `state`, a refusal too: `{ workId, machine, state, error, message, next }`, with `state`
  `unreachable`, `starting`, `gone`, `busy`, `failed` or `refused`, so a status loop reads one shape.
- `NAME_INVALID` and `PATH_REFUSED` name the input that failed and why (`localDirectory: "…" does not exist.`,
  `files[0].from: …`), with `field` in the result; `NAME_INVALID`'s next step says to fix that input.
- `UNTRACKED` names the first ten paths and counts the rest, and the result carries `kind`, `count` and the first 50
  `paths`. A harvest's next step names at most ten paths too.
- `SESSION_BUSY`'s next step is to make the call again once `boxd_job` reports idle, and `MACHINE_STARTING`'s names
  `wait: true`.

- The host range is unchanged: `>=2.2.3 <2.4.0`, tested on 2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7 and 2.3.0.
### Fixed

- A harvest reports the guest's git remote without its user information, so a remote such as
  `https://x-access-token:<placeholder>@github.com/…` no longer puts a credential placeholder in a result.

## [0.0.4] - 2026-11-15

### Changed

- Admits OpenCode 2.3: the host range is `>=2.2.3 <2.4.0`, tested on 2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7 and 2.3.0. CI now
  installs a stock binary for every release in `TESTED_HOSTS`, read by `scripts/tested-hosts.mjs`, rather than a fixed
  list, so the prover and pack stages run on 2.2.7 and 2.3.0. An out-of-range example is now 2.4.0.

## [0.0.3] - 2026-11-14

### Fixed

- A work that never had a prompt can be harvested and dropped (#2). `boxd_harvest` no longer refuses it with `NOT_OURS`
  and a next step that pointed back at `boxd_ensure`: it imports no transcript, records the guest's git state and marks
  the proof fresh, so `boxd_drop` applies its usual guard, and a clean tree drops while a tree with untracked, ignored
  or uncommitted files still refuses.

### Added

- Status shows the boxd CLI's sign-in as its first row, **boxd CLI**: signed in when the CLI answered the machine listing
  status already makes, or not signed in or not reachable with the CLI's reason, and then the next step is
  `boxd auth login`. `boxd_status` returns it as `cli`, and the status RPC as `signedIn` and `signInError`. The Account
  row is gone; its sentence is part of the new row.
- A status reason is redacted for email addresses and the user name in a home folder too, beside the token shapes. The
  boxd CLI's reason in `boxd_status` goes through the same redaction and is cut to 160 characters.

### Changed

- `package.json` is `"private": true`, so nothing can be published to npm; installs from the GitHub tag are unaffected.
- `docs/jelly.md` says what Jelly does with the declaration: Jelly applies the `access` setting itself from each tool's
  `readOnly` (the two reads run at every value; the seven machine changes ask at Ask before changes and are denied at
  Read only), in place of the sentence that a declared `allow` changes nothing in Jelly. It counts the declared tools
  and says where the boxd CLI's sign-in shows. The declaration is unchanged.
- The jelly test runs the family's shared declaration kit (`test/support/jelly-kit.ts`, pinned by
  `scripts/check-copies.mjs`).
- The icon is now boxd's own mark, boxd.sh's `favicon.svg`, unmodified, on a rounded holding tile in boxd.sh's page colour (#0a0c12), in place of the family's drawn mark; `opencode.vendor.mark` is `true`.

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
