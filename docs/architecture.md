# Architecture

## Layers

| Layer | Where | Provides |
|---|---|---|
| Plugin entry | `src/index.ts` | one `Plugin.define` → `assertHost` → `register`, and the setup order |
| Handlers | `src/handlers/` | one file per method: its schema, its description and its run |
| Provider | `src/provider/` | the runner, the boxd CLI port, the guest helper and this machine's `opencode` |
| Ledger | `src/ledger/` | copy-on-write records, the append-only event log and the cross-process locks |
| Fleet | `src/fleet/` | the status read, the machine runs and the session runs |
| Watch | `src/watch.ts` | one sweep of the fleet, the event log's tail and the notices |
| Cost | `src/cost/` | boxd's rates, today's usage and the cleanup suggestions |
| Status | `src/status.ts` | the `/boxd` report and the works list snapshot |

Every method is declared in `package.json` `capabilities.methods` and written once in `src/handlers/`. The contract's
`register` builds the tool, the Code Mode entry and the RPC method from that one table, checks the input and the answer,
asserts the permission, and maps a failure to the contract's codes. The plugin declares no accounts, so there is no
account to resolve; the local identity is only via `probe`/status.

## The provider client

`src/provider/` is the only place a binary is named: `boxd` and this machine's `opencode`. Every child process goes
through one runner with a pool and a cap, an explicit timeout, the call's signal and an output cap. The boxd CLI port
parses `--json` answers and maps stderr through one error table. The guest port runs `python3 ~/.boxd-plugin/guest.py`
over `boxd machine exec`, uploads the helper with `machine cp` when it is missing or older, and never uploads on a read.
`guest/guest.py` is the helper itself; it talks to the guest's OpenCode server, imports and exports sessions, and
writes one plugin into the guest's global plugins folder: `boxd_done`, the work's completion tool. An operator can
turn it off with `"-boxd.done"` in a work's `opencode.json` plugins list.

## The ledger label

Every work's machine carries the label `ledger=<id>`, next to `owner=boxd`, `role=session` and `work=<id>`. The id names
the ledger that registered the machine. It is ten lowercase hex digits, made once on first use and kept in the file
`ledger-id` in the ledger's root, so it is a valid boxd label value and survives restarts. `boxd_ensure` sets the label
when it creates a machine and when it adopts one, and `boxd_reassign` sets it with the other labels. The automation pass,
held by one process, sets it once per process on every open work's machine that has none; a machine that already carries
another ledger's label is left alone. `boxd_ensure` refuses to adopt such a machine, and only `adopt: true` replaces the
label. A shared machine carries `shared=<name>` instead of `work=<id>`, and every work in a slot records the same machine
id; the ledger label is still its operator's. The label lets one operator tell another operator's live work from a
machine that no work owns, because a ledger lives on its operator's machine.

## The registry copy

The ledger keeps a durable copy of itself on a registry machine, `oc-reg-<ledgerId>`, labelled `owner=boxd`,
`role=registry` and `ledger=<id>`. The watcher's sweep makes it on first need in the region of the ledger's first work,
sets `backups.period` to `24h`, and leaves boxd's own auto-hibernate on. It copies the `ledger-id` file, every work
record, every stored export, every patch and each `untracked/` set whose digest changed, and never a lock, a temp file,
`index.json` or `events.jsonl`. A file arrives at a staged path and is renamed over its old copy, and an `untracked/`
set moves only after every file in it arrived, so a failed copy leaves the last good copy whole. No tool call waits for
the copy. The registry class is never an orphan, is never adoptable and is not counted against `budget.machines`. The
copy is append-only: a work whose files leave the local ledger stays on the registry, while status's `works` names the
records the latest sync found in the local ledger. `/boxd` and `status` show the machine, the time of the last complete
copy, the works it holds and a warning when the copy is more than one sweep behind or failed.

## Machine classes and orphans

The fleet status classifies every machine in the organisation: a work in this ledger, its registry machine, a work in
another ledger (its `ledger=` label is not this ledger's id), a kept machine (it matches a selector in the `keep`
option), a golden builder, or an orphan. An orphan also says why it has no owner: no ledger label, this ledger's label
without a record, or only the
plugin's legacy labels. Only a session machine is actionable: `role=session`, or an `oc-<id>` name with the legacy
labels. Any other orphan is listed with the next step "label it, or add a selector to keep", and no rule ever acts on it.

`boxd_ensure({ select: "orphans" })` adopts every actionable orphan: it reads the guest's `describe`, writes a record
from the machine's own folder, repository and root session, and sets this ledger's labels. It changes nothing on the
machine's tree, OpenCode or sessions: no setup, clone, upgrade or resize. A busy orphan, or one waiting on a person, is
adopted and left running. A hibernated orphan is woken for the read and left running. An orphan whose `describe` fails is
skipped with its error, and no record is written from a guess.

## What is cached

- One machine listing is shared by every caller that accepts an age; a read that needs a fresh one (the "gone" rule)
  takes its own.
- The machine limit is kept for 60 s; snapshots for 5 minutes; the organisation's rates for a day; today's usage for
  10 minutes.
- The watcher keeps each work's last observed phase and activity time in memory; the ledger is the truth across
  restarts.
- `status` never reads a guest, so opening it never wakes a machine and never keeps an idle one awake.

## OpenCode APIs

Only the public `@opencode/plugin` 2.4.1 API: `ctx.app.version` for the host gate, `ctx.tool` and `ctx.rpc` through
`register`, `ctx.agent` for the access rules and the status read, `ctx.session.synthetic` for a notice and
`ctx.command` for `/boxd`, `ctx.skill` for the skill, and `ctx.options` for the plugin options. The plugin reads no
OpenCode database and imports no internal module.
