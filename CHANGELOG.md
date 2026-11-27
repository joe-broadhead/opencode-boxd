# Changelog

## Unreleased

- A work's OpenCode server starts with the machine's basics and the variable names the work declares in `ensure` as
  `env`, without the operator's other variables. A session can still read them from boxd's variables file, a login shell
  or sudo.

## 0.0.0 (2026-11-25)

The first release: an OpenCode plugin for boxd, on OpenCode 2.4.1 and plugin-contract v0.

- One `contract.register` call wires 14 methods through the agent tool, Code Mode and one RPC id `boxd`.
- The `capabilities` manifest declares the methods and their classes, two sources (`boxd.works` events and
  `boxd.works.list` snapshot), the `changed` bus event and the local machine identity (no plugin-held accounts).
- `events_list` is a tool too (`boxd_events_list`), declared once with its source.
- No plugin-held accounts: the boxd CLI's sign-in is external, no method takes an `account` input, `probe` reports the
  local machine identity, and `status` has an empty account list.
- Access rules come from the contract's `access` module at `all`, `ask-changes` and `read-only`; `exec` asks even at
  `all`.
- Every write emits `changed`.
- The ledger records every work; `/boxd` reports the cost, the fleet and one next step, and the `boxd-sessions` skill
  guides an agent through ensure, submit, harvest, sleep and drop. Its loader parses YAML frontmatter with `yaml@2.9.1`,
  so folded and literal descriptions register their text.
- The docs are generated from the manifest with `plugin-kit docs`.
- Tests: unit, the contract's conformance without plugin-held accounts, the host proof on 2.4.1 (tools, skill, command and
  parity), and pack.
