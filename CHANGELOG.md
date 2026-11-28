# Changelog

## Unreleased

- **The works of a build before the rebuild are taken over in place.** `boxd_ensure({ select: "orphans" })` adopts a
  machine the old build started with its running OpenCode server and its root session, so the same conversation
  continues, and fences the old build off with a stub that answers `WORK_MOVED`. The guest helper gains the `legacy`
  change action. See [docs/upgrading.md](docs/upgrading.md).

## 0.1.0 (2026-11-28)

Warm images, slots on shared machines, the done signal, labelled work events, machine-hours and cost in the ledger, a
durable copy of the ledger on a registry machine, caps by label, and per-work secrets. Still on OpenCode 2.4.1 and
plugin-contract v0.

### Upgrading

Moving from 0.0.0 needs no option change: every 0.0.0 option keeps its name and meaning, and the ledger at
`~/.local/share/boxd-plugin/v1` is read as it is, with no migration. Change the plugin entry's tag to `v0.1.0`
and reload. These are the changes an operator must know before that:

- **A work refuses to act as its operator.** `boxd_ensure` and `boxd_submit` now answer `ACTS_AS_OPERATOR` when the
  work's machine holds a real GitHub, model or cloud credential instead of a `bxds_` placeholder bound to its host,
  including the real github.com git login that boxd's git integration gives a private machine. Give each work a
  sealed secret (`boxd env set <KEY> <value> --secret --domains <hosts>`) or a `workSecrets` entry, run
  `boxd manage integrations disconnect git`, and unset any real token on the machine. A running work is refused at its
  next `boxd_submit` until its machine passes.
- **A work's OpenCode server starts with only the variables it declares.** It gets the machine's basics and the names
  given to `boxd_ensure` as `env`, not the operator's other variables. A work that relied on another variable needs it
  named in `env`. A server that is already running keeps its environment until it restarts.
- **A registry machine appears.** The watcher's sweep creates `oc-reg-<ledger id>` in the first work's region on first
  need, labelled `owner=boxd`, `role=registry` and `ledger=<id>`, with daily disk backups, and copies the ledger there.
  It is never an orphan and does not count against `budget.machines`; do not remove it.
- **Machines get new labels.** Every work's machine carries `ledger=<id>`; the automation pass adds it once to an open
  work's machine that lacks it. A machine carrying another ledger's label is that ledger's work, and is never adopted
  without `adopt: true`.
- **New guest helper.** The helper on a work's machine is replaced by the next `boxd_ensure` or `boxd_submit` on that
  work, which answers the old copy's `HELPER_OUTDATED` by uploading this one. Until then reads use the copy already
  there.
- **Events carry a `change:` label.** An automation can key on `change:started`, `change:waiting`,
  `change:finished`, `change:failed` or `change:idle`; the `phase:`, `outcome:` and `needs:` labels stay. On the first
  sweep, every work already closed gets one cost event for its whole life, dated at its close, so an events page may
  show an older close date beside new ones.
- **A slot work is not rebuilt.** `boxd_resume` answers `SLOT_UNSUPPORTED` for a slot work whose shared machine is
  gone, as `boxd_drop` and `boxd_sleep` already did.

Moving from a build before the 0.0.0 rebuild, such as `github:joe-broadhead/opencode-boxd#v0.1.2`, is a new install
with its own ledger: see [docs/upgrading.md](docs/upgrading.md).

### Changes

- Every work's machine runs one work in its own slot, or several works share one machine: `boxd_ensure` with
  `machine: "<name>"` puts a work in a slot on `oc-shared-<name>`, up to `slotsPerMachine` (4 by default). Each slot has
  its own password, port, OpenCode server, logs and files, and every read, submit and harvest reaches the work's own
  slot.
- `boxd_golden` with `repo` builds a repository's warm image from the version's golden image, with the checkout, the
  toolchain and the dependencies the `warm` option's `setup` script installs.
- `boxd_ensure` takes `product`, `role`, `feature` and `task` labels, records them, and sets them as `work.*` labels on
  a machine of the work's own; an adopted orphan reads them back, a rebuild keeps them, and `boxd_job` and the works
  list return them.
- `workSecrets` mints a work's own secrets here with the command you name, copies each value straight to the work's
  machine and gives it to the work's OpenCode under its name, and revokes it at drop. Only the name is recorded.
- The ledger keeps a durable copy on its registry machine, through staged files, so a failed copy leaves the last good
  one whole. `/boxd` and the fleet status name the machine, the last complete copy, the works it holds, and warn when the
  copy failed or is more than one sweep behind.
- The guest's OpenCode gains a `boxd_done({ summary, prs })` tool. Its report rides into the ledger record,
  `boxd_job`, `boxd_status`, the works list and the idle event; a new submit clears it, and the skill teaches
  coordinators to read it rather than treat `outcome: completed` as the task's end.
- Each work event carries at most one `change:` label, the works source appends an event when a work starts or stops
  waiting for input, and the watcher nudges `changed` for every tick that appends or tails an event.
- The fleet status shows the organisation's machines against boxd's limit, by state and by region, beside the machine
  classes and orphans.
- `budget.machineHours` caps the running hours of this ledger's works per local day, counted from the ledger, so it
  needs no owner's sign-in.
- CI runs every job on the `boxd-public` runner.

- Each work's ledger record counts its machine's existed, running and asleep seconds, and prices every interval at
  boxd's rates as it is counted, in the rates' currency. `boxd_job` and `boxd_status` with `include: ["cost"]` show
  `hours.seconds` and `hours.estimate`, and the cost block sums them for this ledger, today and since the oldest open
  work; a slot work is charged its share of its shared machine, and a work joining or closing splits every open slot's
  interval there.
- The works source appends one cost event for each work for every local day that ended, and one for its whole life when
  it closes: the day's existed, running and asleep seconds, and its estimate, currency and rates. The record keeps the
  last day it reported, so a restart, a second OpenCode process or a missed sweep writes no day twice. On the first tick
  after this release, a work already closed gets its one life event then, dated at its close, so an events page may show
  an older close date beside a new one.
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
  create; `daily` is now optional, and a wake never counts as a new machine. `budget.labels` caps the machines,
  machine-hours and cost per day of the works that match one label, and `boxd_status` and `/boxd` show each cap with
  its use.

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
