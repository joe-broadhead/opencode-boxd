# boxd for OpenCode

Runs OpenCode sessions on private [boxd](https://boxd.sh) machines, one work per machine, and brings each transcript,
its files and its git back here. A work is one task with one id, one machine (`oc-<workId>`) and one root session plus
the child sessions its subagents start; the machine is a cache with more CPU, and this machine is the source of truth.

## Requirements

- OpenCode `>=2.4.1 <2.5.0`, tested on 2.4.1.
- The boxd CLI, signed in, on the `PATH` of the machine running OpenCode.
- A model key the guests can reach: a sealed, host-bound `boxd env` secret, or `opencode auth login` on one machine.
- Linux or macOS where OpenCode runs.

## Install

Install from a release tag:

```sh
opencode plugin add github:we-the-rebel-alliance/boxd-plugin#v0.0.0
```

The tag is `v0.0.0`. A Git install does not update by itself: remove the exact tag you installed and add the new one.

Then run `opencode reload`, or restart OpenCode, and run `/boxd`.

## Sign in

There is no sign-in in the plugin: it holds no account or credential. Sign in with the boxd CLI; the plugin runs your
own signed-in `boxd` CLI and never reads your boxd account or credentials. `probe` reports the local machine identity,
and `/boxd` says whether the CLI answered.

## Access

`access` is `all` (the default), `ask-changes` or `read-only`. Reads always run; `all` runs every change, `ask-changes`
asks first, and `read-only` turns changes off. `exec` asks even at `all`, because it runs arbitrary argv on the guest.
The plugin's methods, their classes and their operations are in the capabilities table below and in
[docs/capabilities.md](docs/capabilities.md).

## Options

Set options under the plugin entry in `opencode.json`: `access` (`all`, `ask-changes` or `read-only`), `regions` (where a
new machine and a new golden image may be placed), `region`, `size`, `keep` (label selectors for machines owned
elsewhere, such as leads and runners), `automation` (the plugin's own harvest and hibernation of finished works),
`autoSleepMinutes`, `budget`, `git` and `allowUntestedHost`. Every option and its default is in
[docs/configuration.md](docs/configuration.md).

## Capabilities

<!-- generated:capabilities -->
### Methods

| Method | Class | Accounts | Operations |
|---|---|---|---|
| `status` | read | none | `boxd.machine.list`, `boxd.manage.machine-limit`, `boxd.manage.usage`, `boxd.env.list`, `boxd.snapshots.list`, `boxd.machine.exec`, `boxd.local.ledger.read` |
| `events_list` | read | none | `boxd.local.ledger.read` |
| `job` | read | none | `boxd.machine.list`, `boxd.machine.exec`, `boxd.local.ledger.read` |
| `read` | read | none | `boxd.machine.list`, `boxd.machine.exec` |
| `probe` | read | none | — |
| `ensure` | admin | none | `boxd.machine.new`, `boxd.machine.get`, `boxd.machine.list`, `boxd.machine.label.set`, `boxd.machine.resize`, `boxd.machine.reboot`, `boxd.machine.wake`, `boxd.machine.config.set`, `boxd.snapshots.save`, `boxd.machine.cp`, `boxd.machine.exec`, `boxd.manage.machine-limit` |
| `submit` | write | none | `boxd.machine.list`, `boxd.machine.wake`, `boxd.machine.cp`, `boxd.machine.exec` |
| `harvest` | export | none | `boxd.machine.wake`, `boxd.machine.exec`, `boxd.machine.cp`, `boxd.local.session.import` |
| `sleep` | write | none | `boxd.machine.get`, `boxd.machine.hibernate` |
| `resume` | admin | none | `boxd.machine.list`, `boxd.machine.get`, `boxd.machine.new`, `boxd.machine.wake`, `boxd.machine.cp`, `boxd.machine.exec`, `boxd.manage.machine-limit` |
| `reassign` | admin | none | `boxd.machine.get`, `boxd.machine.list`, `boxd.machine.rename`, `boxd.machine.label.set` |
| `golden` | admin | none | `boxd.snapshots.list`, `boxd.snapshots.save`, `boxd.snapshots.remove`, `boxd.machine.new`, `boxd.machine.get`, `boxd.machine.resize`, `boxd.machine.reboot`, `boxd.machine.remove`, `boxd.machine.cp`, `boxd.machine.exec`, `boxd.env.list` |
| `exec` | admin | none | `boxd.machine.get`, `boxd.machine.wake`, `boxd.machine.exec` |
| `drop` | delete | none | `boxd.machine.get`, `boxd.machine.list`, `boxd.machine.exec`, `boxd.machine.remove` |

### Sources

| Source | Kind | Reads or output | Method | Cost |
|---|---|---|---|---|
| `boxd.works` | events | `x-boxd/work` | `events_list` | free |
| `boxd.works.list` | snapshot | `list` | `status` | free |

### Actions

None.

### Bus events

`rpc.boxd.changed`
<!-- /generated:capabilities -->

## Errors

Every failure reads `CODE: What happened. Next step: What to do.` The plugin uses the contract's codes; the table below
is the contract's whole set.

<!-- generated:errors -->
| Code | Meaning |
|---|---|
| `NEEDS_SIGN_IN` | the account is not signed in |
| `SCOPE_MISSING` | the call needs a scope the person has not confirmed |
| `ACCOUNT_REQUIRED` | the plugin serves several accounts and the call names none |
| `ACCOUNT_UNKNOWN` | the call names an alias the plugin does not serve |
| `ACCOUNT_MISMATCH` | the item belongs to another account |
| `CURSOR_INVALID` | the cursor is malformed, or belongs to another source, account or scope |
| `CURSOR_EXPIRED` | the provider no longer keeps the history the cursor names |
| `RATE_LIMITED` | the provider asked the plugin to slow down |
| `BUDGET_EXCEEDED` | the read would cost more than the person allows |
| `SOURCE_DISABLED` | the person turned this source or action off |
| `TOO_LARGE` | the answer is larger than the source's maxBytes |
| `INPUT_INVALID` | the input does not match the method's schema |
| `SOURCE_UNKNOWN` | the plugin declares no such source |
| `SCHEMA_VIOLATION` | an answer does not keep the contract's shape |
| `PERMISSION_DENIED` | the person's grant does not cover the call |
| `PLAN_INVALID` | the plan is missing, or belongs to another method |
| `PLAN_USED` | the plan was already used by an earlier commit |
| `GRANT_INVALID` | the action grant did not verify, or was already spent |
| `HOST_UNTESTED` | OpenCode is outside the plugin's tested range |
| `OPTIONS_INVALID` | the plugin's options do not match their schema |
| `UNAVAILABLE` | the provider could not be reached |
<!-- /generated:errors -->

## Troubleshooting

| What you see | What to do |
|---|---|
| `NEEDS_SIGN_IN` | Run `boxd auth login` in a terminal, then check that the `boxd` CLI is on OpenCode's `PATH`. |
| `HOST_UNTESTED` | Use OpenCode 2.4.1, or set `allowUntestedHost: true` if you accept an untested release. |
| `PERMISSION_DENIED` | The access level or a session rule refused the call; change `access`, or ask the person to allow it. |
| `UNAVAILABLE` | The machine, the CLI or the guest could not answer; read the sentence and its next step, then retry. A drop refused for unpushed commits says to push first. |
| `INPUT_INVALID` | The input or the work id is not what the method describes; read the field the message names. |
| `BUDGET_EXCEEDED` | Today's machine cost or machine-hours reached `budget.daily` or `budget.machineHours` with `action: "refuse"`, or a shared machine reached `slotsPerMachine`; sleep or drop unused works, use another machine name, or raise the cap. |

Run `/boxd` for the fleet, the cost and the one next step, and `boxd_status` from an agent session for the contract
status.

## Docs

- [Capabilities](docs/capabilities.md): every method, source, action and bus event, with notes.
- [Configuration](docs/configuration.md): every option and examples.
- [Accounts](docs/accounts.md): no plugin-held accounts, and the local identity probe reports.
- [Automations](docs/automations.md): the timer recipe for the works source.
- [Architecture](docs/architecture.md): layers, the provider client, caches and host APIs.
- [Security](docs/security.md): what leaves the machine, redaction and the drop guard.
- [plugin-contract](https://github.com/we-the-rebel-alliance/plugin-contract): the manifest, accounts, methods and access
  the plugin implements.
