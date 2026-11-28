# Changelog

## Unreleased

- Each work's ledger record counts its machine's existed, running and asleep seconds, and prices every interval at
  boxd's rates as it is counted, in the rates' currency. `boxd_job` and `boxd_status` with `include: ["cost"]` show
  `hours.seconds` and `hours.estimate`, and the cost block sums them for this ledger, today and since the oldest open
  work; a slot work is charged its share of its shared machine, and a work joining or closing splits every open slot's
  interval there.
- The fleet status classifies every machine in the organisation: a work here, another ledger's work, kept by a `keep`
  selector, a golden builder, or an orphan with its reason and whether the plugin may act on it. `boxd_ensure` with
  `select: "orphans"` adopts every actionable orphan from its guest's `describe`, writing a record and this ledger's
  labels without setup, clone, upgrade or resize.
- A work with a `repo` starts from that repository's warm image when one exists for its size in an allowed region, and
  from the version's golden image with a clone otherwise. `ensure` answers `warm` and, for a work this version made,
  once it is ready, `readySeconds`, the seconds from its first ensure to its first ready.
- Every work's machine carries the label `ledger=<id>`, naming the ledger that registered it. `boxd_ensure` sets it on a
  create and on an adoption, and the automation pass adds it once to an open work's machine that lacks it.
- The guest helper's `phase` and `export` read the newest completed `boxd_done` call after the root's latest prompt
  as `done: { at, summary, prs }`, only while the whole tree is idle and the last run did not fail or abort.
- A work's OpenCode server starts with the machine's basics and the variable names the work declares in `ensure` as
  `env`, without the operator's other variables. A session can still read them from boxd's variables file, a login shell
  or sudo.
- The `budget` option takes `machines`, the most machines this ledger may hold, and `orgMachines`, the organisation's
  count at which this plugin stops creating. `boxd_ensure`, and `boxd_resume` when it rebuilds, check both before a
  create; `daily` is now optional, and a wake never counts as a new machine.

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
