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
  guides an agent through ensure, submit, harvest, sleep and drop.
- The docs are generated from the manifest with `plugin-kit docs`.
- Tests: unit, the contract's conformance with the one local account, the host proof on 2.4.1, and pack.
