# Changelog

## 0.0.0 (2026-11-25)

The first release: an OpenCode plugin for boxd, on OpenCode 2.4.1 and plugin-contract v0.

- One `contract.register` call wires 14 methods through the agent tool, Code Mode and one RPC id `boxd`.
- The `capabilities` manifest declares the methods and their classes, two sources (`boxd.works` events and
  `boxd.works.list` snapshot), the `changed` bus event and the local account.
- `events_list` is a tool too (`boxd_events_list`), declared once with its source.
- Accounts are local: one account, `default`, the machine's identity; no sign-in input on any method.
- Access rules come from the contract's `access` module at `all`, `ask-changes` and `read-only`; `exec` asks even at
  `all`.
- Every write emits `changed`.
- The ledger records every work; `/boxd` reports the cost, the fleet and one next step, and the `boxd-sessions` skill
  guides an agent through ensure, submit, harvest, sleep and drop. Its loader parses YAML frontmatter with `yaml@2.9.1`,
  so folded and literal descriptions register their text.

- The docs are generated from the manifest with `plugin-kit docs`.
- Tests: unit, the contract's conformance with the one local account, the host proof on 2.4.1 (tools, skill, command and
  every v0.1.4 capability), and pack.

### Removed since v0.1.4

- `/boxd-status` is renamed `/boxd`: the one report command; the old name is gone, and the report still carries the
  fleet, the cost and the next step.
- The `boxd` skill is renamed `boxd-sessions`: the old id was shadowed by the VM's own `boxd`; the guidance now names
  the contract's `tools.boxd.*` methods, and the skill is registered for the first time.
- `/boxd-cleanup` and its `./tui` export and view are removed. Cleanup is `boxd_sleep`, `boxd_harvest` and `boxd_drop`
  per work under `access`; the automation never drops, and destructive bulk cleanup is not a second path.
- The cost-line hooks (`context`, `compaction`, `experimental.idle`) and the `session.deleted`/`session.archived` event
  wiring are removed. Cost and the one next step live in `/boxd` and `status`; nothing runs per request.
- The `costContext` and `idleCheck` options are removed with those hooks.
- The `snapshot` option, already rejected in v0.1.4, is not back: `goldenBase` is the only base option.
