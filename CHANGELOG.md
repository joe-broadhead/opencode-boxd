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

### Fixed

- A second harvest of the same session now proves the import instead of failing: stock OpenCode answers
  `Session already exists` with no id, and the plugin uses the transcript's own id.
- The laptop import no longer matches the word "session" as a session id.
- `boxd_image` refuses a machine that no ledger work owns.
- The guest check compares against this laptop's OpenCode, not a hard-coded release.
