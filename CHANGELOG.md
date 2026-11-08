# Changelog

All notable changes to this project are documented here. The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.0] - Unreleased

### Added

- Nine tools: `boxd_status`, `boxd_job`, `boxd_ensure`, `boxd_submit`, `boxd_harvest`, `boxd_sleep`, `boxd_resume`,
  `boxd_image` and `boxd_drop`. A tool returns when its request is admitted; nothing waits for a model.
- A ledger at `~/.local/share/opencode-boxd/works/`: the export, the patch and the git record are the laptop's copy of
  the session. Sleep, image and drop refuse until a harvest has proven the import here.
- Default permission rules: the two reads run, and every machine change asks. `boxd_drop` asks rather than being off,
  because its own guard makes data loss impossible and a deny would leave a machine billing.
- `/boxd-status` and the `/boxd` dialog, both rendering one status model, and the `boxd.machines` status RPC.
- Every tool as a method of the `boxd.machines.tools` RPC, with its class, so a script can call it with no model.
- A skill, `boxd`, and the `jelly` declaration with its icon.
- The plugin runs on OpenCode 2.2.3, 2.2.4, 2.2.5 and 2.2.6. The guest must run the same version as the laptop.
- [docs/golden-image.md](docs/golden-image.md): how to build the image every machine boots from, sign its OpenCode in to a
  provider on the machine, and what a credential-holding snapshot discloses.
- The `snapshot` option defaults to `opencode-golden`. Status says whether this account has it, and `boxd_ensure` and
  `boxd_resume` refuse with `SNAPSHOT_MISSING` before creating a machine.

### Changed

- Every work has a laptop folder and a guest folder: the guest always works in `/home/boxd/work/<work id>`, and a laptop
  path is never sent to the machine. `boxd_ensure`'s `directory` names the laptop folder.
- `boxd_submit` copies `files` to the machine before the prompt, and `boxd_harvest` copies `files` back after the
  transcript: 8 MiB a file, 32 MiB a call, no symlinks, inside the project or `allowedRoots`, recorded by name, size and
  sha256. `boxd_drop` counts a harvested output as recovered.
- `docs/scripting.md` has a worked `bookmarks.json` → `SUMMARY.md` example and the `external_directory` rule.
- `boxd_job` checks the guest server before reporting `empty`; `boxd_status` checks the snapshot with no work open;
  `BOXD_MISSING` names the CLI on the server's PATH and its config in the server's HOME.
- `allowedRoots` names laptop folders outside the project that work files may use.

### Fixed

- A second harvest of the same session now proves the import instead of failing: stock OpenCode answers
  `Session already exists` with no id, and the plugin uses the transcript's own id.
- The laptop import no longer matches the word "session" as a session id.
- `boxd_image` refuses a machine that no ledger work owns.
- The guest check compares against this laptop's OpenCode, not a hard-coded release.
- A read never wakes a machine: `boxd_job` reports `asleep`, with `boxd_resume` as the next step.
- Every wake arms the awake bound (30 minutes, `idle.ignore-outbound off`), and a failure is a status problem.
- `boxd_resume` rebuilds a machine any number of times in one OpenCode run: the guest helper is uploaded again.
- `boxd_sleep` works when the guest cannot be harvested, with a recorded warning; hibernating keeps the disk.
- `boxd_drop` refuses a non-git directory and any untracked or ignored path, and stores tracked changes as
  `git diff HEAD` plus the untracked files' contents.
- The ledger serialises per work, writes atomically through a unique temp file, and fails with `LEDGER_FAILED`.
- A timed-out `machine new` is adopted when the machine appears, and `boxd_status` names `oc-*` machines no work records.
- The ledger folder is 0700 and its files 0600; the guest's log is 0600; the guest password goes only to its own address.
- A session tree with a cycle fails with `EXPORT_INVALID` instead of recursing.
- `boxd_harvest` refuses a local directory that does not exist.
