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
`register` builds the tool, the Code Mode entry and the RPC method from that one table, resolves the account, checks the
input and the answer, asserts the permission, and maps a failure to the contract's codes.

## The provider client

`src/provider/` is the only place a binary is named: `boxd` and this machine's `opencode`. Every child process goes
through one runner with a pool and a cap, an explicit timeout, the call's signal and an output cap. The boxd CLI port
parses `--json` answers and maps stderr through one error table. The guest port runs `python3 ~/.opencode-boxd/guest.py`
over `boxd machine exec`, uploads the helper with `machine cp` when it is missing or older, and never uploads on a read.
`guest/guest.py` is the helper itself; it talks to the guest's OpenCode server and imports/export sessions.

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
