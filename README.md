# boxd for OpenCode

Runs OpenCode sessions on private [boxd](https://boxd.sh) machines, one work per machine, and brings each transcript,
its files and its git back here. A work is one task with one id, one machine (`oc-<work id>`) and one root session; the
machine is a cache with more CPU, and the ledger here is the source of truth.

Unofficial; not affiliated with boxd.

boxd is a trademark of Azin Tech Operating Company B.V.; this unofficial plugin is not endorsed by them.

## Requirements

- OpenCode `>=2.4.1 <2.5.0`, tested on 2.4.1.
- The boxd CLI, signed in, on the `PATH` of the machine running OpenCode. The CLI that runs inside a boxd machine is
  refused.
- A model key the guests can reach: a sealed, host-bound `boxd env` secret, or `opencode auth login` on one machine
  (`docs/images.md` and the skill say how). The plugin builds golden images itself, from stock boxd, the first time a
  work needs one.
- Linux or macOS where OpenCode runs.

## Install

Install from a release: `opencode plugin add github:we-the-rebel-alliance/boxd-plugin#v<version>`. The first release on
plugin-contract is v0.0.0 (phase 4b).

Run `opencode reload`, or restart OpenCode, then run `/boxd-status`.

Or add the plugin to `opencode.json` with the same release tag:

```json
{ "plugins": [{ "package": "github:we-the-rebel-alliance/boxd-plugin#v<version>" }] }
```

Each release has its own tag, and a Git install does not update by itself: remove the exact tag you installed and add
the new one.

## Sign in

The plugin never reads your boxd account or credentials; it runs your own `boxd` CLI, so sign in the way you always do:

```sh
boxd auth login
```

`/boxd-status` shows it as its first row, **boxd CLI**: `signed in` when the CLI answered its machine listing, or
`not signed in, or not reachable`, with `boxd auth login` as the next step. The machine cost in status needs an
organisation owner's or admin's sign-in; a member sees the estimate only.

## Use

Each tool takes one work, or `works: [...]` for up to 300 at once, and returns one object with a `state`; a list call
returns `{ state, counts, results }` with the results in input order. Read a tool's description before its first call.

1. `boxd_ensure` makes a work exist, set up and ready: it picks the region with the most free machines (`region`,
   default `"auto"`), creates `oc-<work id>` from the golden image for that region, its `size` and this OpenCode
   (building the image first when it is missing), clones `repo`, sets the guest's `git` identity, and waits up to 90 s
   for the guest's OpenCode. Calling it again converges an existing work: it wakes, resizes or upgrades it in place.
2. `boxd_submit` admits a prompt and returns; it does not wait for the model. `mode` decides how it reaches a running
   session: `"steer"` (the default) at its next step boundary, `"queue"` after the run, `"interrupt"` at once. `files`
   copies files from here into the work tree first.
3. A **notice** says when works change, once per change per coordinating session: one line naming the works and the
   cursor to read the rest with. `boxd_job` reads one work or many live, `boxd_status` the whole fleet, and
   `boxd_events_list` the ledger's phase changes as events.
4. `boxd_harvest` brings the work's transcript and git back here. Each session is copied, verified, and then replaces
   this machine's copy; the last good copy is never overwritten before the new one is verified. `files` brings outputs
   back, and `git` reports a commit no remote ref holds.
5. `boxd_sleep` hibernates (it always works, saved or not), `boxd_resume` wakes or rebuilds from the saved transcript,
   and `boxd_drop` destroys a finished, saved work.

The other tools: `boxd_read` reads one file or the guest's server log without a harvest; `boxd_exec` runs one command
with a timeout; `boxd_reassign` moves an unstarted work's machine to another work id; `boxd_golden` builds, lists or
prunes golden images. The `boxd.works` source's `events_list` is also a tool (`boxd_events_list`), and its `probe` is
available over the tools RPC.

`saved` says whether this machine holds the work: `fresh` when a harvest ran after the last prompt, `stale` when a
prompt came later, `none` otherwise.

`boxd_drop` destroys nothing this machine cannot account for. It refuses when the work is not saved or the guest's
sessions moved on (`NOT_SAVED`), the folder is not a git repository (`GIT_UNKNOWN`), a local branch, tag, stash or
detached HEAD holds a commit no remote ref contains (`UNPUSHED`), it cannot tell whether that is so
(`UNPUSHED_UNKNOWN`), untracked or ignored paths were not harvested (`UNTRACKED`), or the tree has uncommitted work and
no stored patch (`DIRTY`).

### What it costs

boxd bills a running machine for its CPU and resident memory, a hibernated one for its disk only, and a dropped one
nothing. An idle running work costs about as much as one in standby, so hibernation is the saving. A new machine is
created with auto-suspend off, auto-hibernate after 2 hours (`autoHibernateMinutes`) and `idle.ignore-outbound` off.
With `access: "all"` the plugin also harvests a finished work and then hibernates it after 10 idle minutes
(`autoSleepMinutes`); at the other levels only with `automation: "on"`, which is your consent. It never drops anything
by itself. `boxd_status` carries `cost` and `cleanup` (machine cost only; model spend is not measured), and
`/boxd-cleanup` confirms each cleanup action with a permission prompt that only you answer.

## Permissions

**Every tool is allowed by default.** The plugin inserts this block into every agent that has a base `* * allow`,
directly after it:

```json
[
  { "action": "boxd_*", "resource": "*", "effect": "allow" },
  { "action": "boxd_cleanup", "resource": "*", "effect": "ask" },
  { "action": "boxd_status", "resource": "*", "effect": "allow" },
  { "action": "boxd_events_list", "resource": "*", "effect": "allow" },
  { "action": "boxd_job", "resource": "*", "effect": "allow" },
  { "action": "boxd_read", "resource": "*", "effect": "allow" },
  { "action": "boxd_probe", "resource": "*", "effect": "allow" },
  { "action": "boxd_ensure", "resource": "*", "effect": "allow" },
  { "action": "boxd_submit", "resource": "*", "effect": "allow" },
  { "action": "boxd_harvest", "resource": "*", "effect": "allow" },
  { "action": "boxd_sleep", "resource": "*", "effect": "allow" },
  { "action": "boxd_resume", "resource": "*", "effect": "allow" },
  { "action": "boxd_reassign", "resource": "*", "effect": "allow" },
  { "action": "boxd_golden", "resource": "*", "effect": "allow" },
  { "action": "boxd_exec", "resource": "*", "effect": "allow" },
  { "action": "boxd_drop", "resource": "*", "effect": "allow" }
]
```

That includes the changes: `boxd_ensure` creates a billing machine, `boxd_submit` starts a model run on it,
`boxd_harvest` writes this machine, `boxd_sleep`, `boxd_resume`, `boxd_reassign`, `boxd_golden` and `boxd_exec` change
or run on machines, and `boxd_drop` destroys one. `boxd_status`, `boxd_events_list`, `boxd_job`, `boxd_read` and
`boxd_probe` are the reads. `boxd_cleanup` is `/boxd-cleanup`'s own action, not a tool: it asks at every level.

The guards that do not depend on a prompt stay: a machine that idles hibernates, `boxd_sleep` always works, drop's own
guard refuses anything this machine cannot account for, and every create is recorded in the ledger before it runs.

To restrict, choose one of three:

1. **`access`**, one option for the plugin: `"all"` (the default), `"ask-changes"` (reads run, every change asks) or
   `"read-only"` (reads run, every change is denied).
2. **An agent's own rules**, such as a read-only agent.
3. **A per-tool rule** in your `opencode.json`: `{ "action": "boxd_drop", "resource": "*", "effect": "ask" }`, or
   `"deny"` to turn one tool off.

The last matching rule wins, so a later rule of yours still decides. Agents without a base allow are left alone, and
`/boxd-status` names any agent that does not carry the block, with the rules to paste.

## Configure

See [docs/configuration.md](https://github.com/we-the-rebel-alliance/boxd-plugin/blob/master/docs/configuration.md) for
every option, the permission rules for each access level, and the error table.

## Troubleshooting

A tool that fails returns `state`, `error` (the code), `message` (what happened) and `next` (the one call to make).

| Code | What to do |
|---|---|
| `HOST_UNTESTED` | Use OpenCode `>=2.4.1 <2.5.0`, or set `"allowUntestedHost": true` to run anyway. |
| `OPTIONS_INVALID` | Fix the plugin options in `opencode.json`, then restart OpenCode. An unknown option or a value outside its rule is named in the message. |
| `STATUS_UNAVAILABLE` | Restart OpenCode, then run `/boxd-status` again. |
| `SKILLS_INVALID` | Reinstall the plugin so its skill file is present, then restart OpenCode. |
| `NAME_INVALID` | An input failed its rule; `field` names it. Fix that input, then call again. |
| `PATH_REFUSED` | A path here is outside the project and the allowed roots, or is a symlink. Name its root in `allowedRoots`, and allow it with the `external_directory` rule. |
| `FILE_TOO_LARGE` | A file is over 8 MiB, or the call is over 32 MiB. Move a smaller file, or split it. |
| `FILE_CONFLICT` | A harvested file changed here since the last harvest, so it was not overwritten. Keep the edit and leave that path out, or restore it and harvest again. |
| `NOT_OURS` | No open work has this id, or `oc-<work id>` now has another machine id than the ledger records, or two regions hold it, or the machine to adopt is another open work's (even with `adopt: true`). Nothing was changed. `boxd_ensure` for an unknown id; otherwise look at the machines the message names. |
| `NOT_REASSIGNABLE` | `from` has a session, uploaded files or a dirty tree, or `to` is an open work. Drop it after a harvest, or reassign a work with no prompt yet. |
| `MACHINE_LIMIT` | No region has room; `limit`, `inUse` and `free` are given per region. Pass the other `region` when it has room; otherwise free machines with `boxd_drop` or `boxd_reassign`, or have the owner raise the limit. |
| `SIZE_UNAVAILABLE` | The organisation's quota does not allow this size. Pick a smaller `size`. |
| `GOLDEN_MISSING` | No golden image for this region, size and OpenCode, and `buildGolden` is `"never"`. Call `boxd_golden({ region, size })`. |
| `GOLDEN_BUILD_FAILED` | A golden image build failed at the step the message names. Fix `goldenSetup` or the base, then `boxd_golden` again. |
| `GOLDEN_HAS_CREDENTIAL` | The base holds `~/.local/share/opencode/auth.json`. Model credentials are never baked into an image: build from stock, and give works a key as a sealed, host-bound `boxd env` secret. |
| `MACHINE_SHARED` | The machine is shared, which deletes the guest's sign-in. Unshare it, or drop it and ensure again. |
| `MACHINE_ISOLATED` | The machine is isolated: no git integration and no in-VM CLI. Drop it and ensure again. |
| `MACHINE_STARTING` | The machine is still starting after the call's wait. Make the same call again; it waits. |
| `MACHINE_GONE` | A fresh all-region listing and a `get` of the recorded machine id found the machine nowhere. `boxd_resume` rebuilds it; `boxd_drop` closes the work. |
| `MACHINE_ASLEEP` | A read or `boxd_exec` found the machine hibernated and did not wake it. `boxd_resume`, or `wake: true` for `boxd_exec`. |
| `AGENT_UNREACHABLE` | boxd's VM agent on the machine does not answer. `boxd_ensure({ workId, repair: "reboot" })`; a reboot ends a running run. |
| `SESSION_BUSY` | The session is running and the call needs it idle. Wait for the notice, or pass `mode: "interrupt"` to `boxd_submit`, or `partial: true` to `boxd_harvest`. |
| `SESSION_MISSING` | The guest no longer has the work's session. `boxd_resume` imports the saved transcript. |
| `RUN_FAILED` | The last run failed; `error` is its one line. Read `lastText` with `boxd_job`, then `boxd_submit` again. |
| `RUN_INTERRUPTED` | The guest's OpenCode stopped mid-run. `boxd_harvest`, then `boxd_submit` again. |
| `GUEST_AUTH_FAILED` | The model provider or a pushed host refused the credential, or the guest has none. Set or rotate the sealed, host-bound `boxd env` secret, then `boxd_submit` again. |
| `GUEST_VERSION` | The guest's OpenCode differs from the OpenCode here, and the call moves a transcript. `boxd_ensure` upgrades it in place once the session is idle. |
| `GUEST_UNRESPONSIVE` | The guest is short of memory or overloaded; the message names the largest processes. Tell the user, or stop them with `boxd_exec`. |
| `GUEST_SERVER_DOWN` | Nothing listens on the guest's OpenCode port. `boxd_ensure` starts it. |
| `GUEST_FAILED` | The guest helper failed; its words are in the message. `boxd_ensure`; if it repeats, `boxd_read({ workId, log: "server" })`. |
| `GUEST_WORKSPACE` | The guest folder could not be made or cloned. Fix the clone's access or the disk, then `boxd_ensure`. |
| `UNPUSHED` | A local branch, tag, stash or detached HEAD has commits that no remote ref contains, so `boxd_drop` refused: `count` and `commits` name them. Push every branch and tag from the machine with `boxd_exec({ workId, command: ["sh", "-c", "git push --all origin && git push --tags origin"] })` (a detached HEAD by name), then drop again. |
| `UNPUSHED_UNKNOWN` | The guest could not tell whether every commit is on a remote ref, so `boxd_drop` refused rather than risk losing one. Run the check with `boxd_exec({ workId, command: ["git", "rev-list", "--count", "--all", "HEAD", "--not", "--remotes"] })`, push whatever it counts, then drop again. |
| `NOT_SAVED` | The work is not saved, or the guest's sessions moved on since the harvest. `boxd_harvest`, then drop again. |
| `UNTRACKED` | Untracked or ignored paths were not harvested; `paths`, `count` and `kind` name them. Harvest them with `files`, or delete them on the machine, then harvest again. |
| `DIRTY` | The guest has uncommitted work and no stored patch. `boxd_harvest`, then drop again. |
| `GIT_UNKNOWN` | The guest folder is not a git repository. Make it one, or `boxd_sleep` instead. |
| `EXPORT_INVALID` | A transcript failed its checks; the stored copy is unchanged. `boxd_harvest` again from an idle session. |
| `IMPORT_FAILED` | The OpenCode here could not import the session; the export is kept. `boxd_harvest` again. |
| `BOXD_FAILED` | The boxd CLI failed in a way the plugin does not know; its words are in the message, redacted. Read it, and run `boxd_status` before trying again. |
| `BOXD_MISSING` | No boxd CLI on the host's `PATH`: it is missing, not signed in, or the in-VM CLI. Install the host CLI and run `boxd auth login`. |
| `TIMEOUT` | A step did not answer in its bound; the message names the step. Make the same call in a later turn. |
| `CANCELLED` | The call was stopped; `uncertain` is true when a write was in flight. Read the work with `boxd_job` before acting again. |
| `CREATE_UNCERTAIN` | A create timed out and no machine was found yet. `boxd_ensure` again: it adopts the machine if one landed. |
| `LEDGER_FAILED` | Check that the ledger folder is writable, then restart OpenCode. |
| `LEDGER_LOCKED` | Another OpenCode process holds this work's lock. The same call again in a few seconds. |
| `LEDGER_IMPORTING` | The import of earlier works is not complete yet; `progress` says how far. The same call again in a few seconds. |
| `IMPORT_V0_FAILED` | The import could not list the machines (sign the CLI in and call again), or one earlier record could not be read (that work id is blocked; fix or remove that file and restart OpenCode). |
| `BUDGET_REACHED` | Today's machine cost reached `budget.daily` with `action: "refuse"`. Lower the cost with `boxd_sleep({ select: "idle" })` and `boxd_drop({ select: "saved-finished" })`, or raise the budget. |
| `RULES_NOT_ADDED` | The default permission rules could not be added, so a change may run without asking. Restart OpenCode, then run `/boxd-status`. |

Warnings sit beside a result that succeeded, never in place of one:

- `UNHARVESTED_SLEEP`: a work was hibernated before its last prompt was saved. `boxd_resume`, then `boxd_harvest`.
- `BUDGET_WARN`: today's machine cost reached `budget.daily` with `action: "warn"`.
- `BUDGET_UNKNOWN`: machine usage is for organisation owners and admins, so the budget cannot be measured; `refuse`
  then acts as `warn`.
- `LEASE_EXPIRING`: a `leaseDays` timer ends within 24 hours, and boxd deletes the machine whatever it holds.
- `AUTOMATION_BLOCKED`: the automatic harvest or sleep of a work failed at the step the message names.
- `NO_MODEL_CREDENTIAL`: a golden build found no provider key among the account's secrets.

The `/boxd` dialog and `/boxd-status` show the same status: the boxd CLI's sign-in, connection, access, the golden
image, the guest version, works by phase, the works that need a decision, each region's machines, the cost, automation
and notices, health, tools, agents without the default rules, the OpenCode version and one next step.

## Known limits

- **The machine limit and usage are read as boxd documents them.** The per-region shape of `manage machine-limit
  --json` and the keys of `manage usage --json` are not confirmed against every boxd release; the region headroom in
  status, `MACHINE_LIMIT`'s numbers, `auto`'s region choice and the machine cost rest on that reading.
- **A call waits at most 4 minutes, measured up to 10.** A tool answers its real state (`creating`, `starting`) with a
  `next` after at most 4 minutes.
- **Model spend is not measured.** `cost.today`, the budget and `/boxd-cleanup` count boxd's machine cost only.
- **Automation consent is per OpenCode process.** The ledger is one per machine, so a process at `access: "all"`, or
  with `automation: "on"`, also harvests and hibernates finished works another project created at `"ask-changes"`.
- **A harvest's copy can be raced by your own user.** Each path is checked before the copy and the file is renamed into
  place after it is verified; a process running as your own user that swaps a folder for a symlink in between can still
  redirect the file.
- **The boxd CLI here only.** The CLI inside a boxd machine acts in one region and has no organisation usage, so every
  tool answers `BOXD_MISSING` on it.
- **Prompts that bypass the plugin** make drop refuse: it compares the guest's own session marks with the harvest's.
- **A commit on no remote ref stops drop.** A harvest stores no commits, so `boxd_drop` answers `UNPUSHED` until every
  ref is pushed from the machine, and `UNPUSHED_UNKNOWN` when the guest cannot walk its refs.
- **Steer waits for the current step.** OpenCode cannot inject text into a step that is running: a step blocked in a
  long tool call takes a steered prompt when that call returns, and only `mode: "interrupt"` reaches it sooner.
- **Model credentials stay out of images.** A guest gets its key from a sealed, host-bound `boxd env` secret, or from a
  person's `opencode auth login` on that one machine.
- **Notices wake the coordinator.** With `notices: "wake"` (the default), an idle coordinator starts a turn at most
  once a minute, and each change is announced once even across a restart; `"queue"` waits for its next turn instead.

## Uninstall

```sh
opencode plugin remove github:we-the-rebel-alliance/boxd-plugin#v<version>
```

The ledger is yours to keep or delete. Machines are boxd's: `boxd machine remove oc-<work id> -y` destroys one.

## Links

- [Configuration, permission rules and errors](https://github.com/we-the-rebel-alliance/boxd-plugin/blob/master/docs/configuration.md)
- [Architecture](https://github.com/we-the-rebel-alliance/boxd-plugin/blob/master/docs/architecture.md)
- [Scripting](https://github.com/we-the-rebel-alliance/boxd-plugin/blob/master/docs/scripting.md)
- [Golden images](https://github.com/we-the-rebel-alliance/boxd-plugin/blob/master/docs/images.md)
- [Live check against real boxd](https://github.com/we-the-rebel-alliance/boxd-plugin/blob/master/docs/live-check.md)
- [Changelog](https://github.com/we-the-rebel-alliance/boxd-plugin/blob/master/CHANGELOG.md)
- [Licence](https://github.com/we-the-rebel-alliance/boxd-plugin/blob/master/LICENSE)
