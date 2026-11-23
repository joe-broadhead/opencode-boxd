# boxd for OpenCode

Runs OpenCode sessions on private [boxd](https://boxd.sh) machines, one work per machine, and keeps the transcripts on
your laptop.

Unofficial; not affiliated with boxd.

boxd is a trademark of Azin Tech Operating Company B.V.; this unofficial plugin is not endorsed by them.

## Requirements

- OpenCode `>=2.2.3 <2.4.0` (2.2.3 or a later 2.2 or 2.3 release), tested on 2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7, 2.3.0, 2.3.1 and 2.3.2.
- The laptop [boxd CLI](https://boxd.sh), signed in, on your `PATH`. The CLI that runs inside a boxd machine is refused.
- A model key the guests can reach: a sealed, host-bound `boxd env` secret is the way
  ([golden images](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/images.md) says how). The plugin
  builds the golden images itself, from stock boxd, the first time a work needs one.
- macOS or Linux on the laptop.

## Install

```sh
opencode plugin add github:joe-broadhead/opencode-boxd#v0.1.4
```

Run `opencode reload`, or restart OpenCode, then run `/boxd-status`.

Each release has its own tag, and a Git install does not update by itself. To move to a newer release, remove the entry
with the exact tag you installed, `opencode plugin remove github:joe-broadhead/opencode-boxd#v<installed version>`, then
add the new tag with `opencode plugin add github:joe-broadhead/opencode-boxd#v<version>`.

Or add the plugin to `opencode.json` instead, with the same spec:

```json
{ "plugins": [{ "package": "github:joe-broadhead/opencode-boxd#v0.1.4" }] }
```

The install takes the GitHub release tag. Its commit carries the built `dist/`, so the install runs no build.

**Upgrading from the v0.0 line.** The first v1 release broke compatibility: tools, results, options and the ledger
changed, and this release does not change them again. That release removed `boxd_image` (`boxd_golden` builds images,
and never saves a work's machine) and added `boxd_read`, `boxd_exec` and `boxd_reassign`. Remove `snapshot` (images are
built from stock); set `goldenBase` only to build on a hand-made base without model credentials. Do it before you
upgrade: a left-over `snapshot` stops the plugin with `OPTIONS_INVALID`. Keep the boxd CLI signed in for the first v1
start.

The first v1 start imports the earlier ledger, `~/.local/share/opencode-boxd/works/`, once into
`~/.local/share/opencode-boxd/v1/`:

- Until the import is complete, every tool answers `LEDGER_IMPORTING` with `progress`; the same call again in a few
  seconds goes through. It reads boxd once (one all-region listing, one `get` per machine); if that listing fails, no
  ledger is made, tools answer `IMPORT_V0_FAILED`, and the next call after 30 s, or a restart, tries again.
- It is crash-safe, all or nothing: it builds in a staging folder and publishes `v1/` in one rename, so a crash or quit
  leaves no `v1/`, and the next start imports again from the untouched records. A record it cannot read blocks only its
  own work (`IMPORT_V0_FAILED`, with the reason in `v1/import-v0.json`) until the file is fixed or removed and OpenCode
  restarts.
- The earlier records are left as they are; the one addition is a note folder, `works/README-MOVED-TO-v1/`. A work
  harvested before may hold an older laptop copy of its transcript: `boxd_status` lists it under `laptop-copy`, and
  `boxd_harvest({ works })` replaces it.
- **Harvest imported works before dropping them.** Until a harvest has verified its laptop copy, `boxd_drop` refuses
  an imported work (`NOT_SAVED`), `select: "saved-finished"` skips it, and `/boxd-cleanup` offers it under "Harvest
  imported works first" instead of the drop.

Going back is safe only before the first mutation (a submit, harvest, drop or reassign) made by a release in the 0.1
line or later: after that, the old drop could accept a stale record and destroy unharvested work. To go back, remove the
exact tag you installed, `opencode plugin remove github:joe-broadhead/opencode-boxd#v<installed version>`, then
`opencode plugin add github:joe-broadhead/opencode-boxd#v0.0.6`, and keep only the options it knows (`snapshot`,
`allowUntestedHost`, `allowedRoots`, `access`). It reads `works/` as it was before the v1 upgrade and sees nothing v1
did; the machines v1 created keep billing until you destroy them. `v1/` stays, and upgrading again uses it as it is,
without importing again. The
[CHANGELOG](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/CHANGELOG.md) lists every breaking change.

## Sign in

The plugin never reads your boxd account or credentials; it runs your own `boxd` CLI, so sign in the way you always do:

```sh
boxd auth login
```

`/boxd-status` shows the sign-in as its first row, **boxd CLI**: `signed in` when the CLI answered its machine listing,
or `not signed in, or not reachable`, and then the next step is `boxd auth login`. The machine cost in status needs an
organisation owner's or admin's sign-in; a member sees the estimate only.

## Use

A **work** is one task with one id, one machine (`oc-<work id>` in its region) and one root session. Each tool takes
one work, or `works: [...]` for up to 300 at once, and returns one object with a `state`; a list call returns
`{ state, counts, results }` with the results in input order.

1. `boxd_ensure` makes a work exist, set up and ready, in one call: it picks the region with the most free machines
   (`region`, default `"auto"`), creates `oc-<work id>` from the golden image for that region, its `size` and this
   laptop's OpenCode (building the image first when it is missing), clones `repo`, sets the guest's `git` identity, and
   waits up to 90 s for the guest's OpenCode. Calling it again converges an existing work: it wakes, resizes or upgrades
   it in place. The guest always works in `/home/boxd/work/<work id>`; `directory` names the laptop folder.
2. `boxd_submit` admits a prompt and returns; it does not wait for the model. `mode` decides how it reaches a running
   session: `"steer"` (the default) at its next step boundary, `"queue"` after the run, `"interrupt"` at once, stopping
   the run. `files: [{ from, to }]` copies laptop files into the work tree first.
3. A **notice** says when works change: one line in the coordinating session, at most once a minute, naming the works
   and the cursor to read the rest with. `boxd_job` reads one work or many live, and `boxd_status` the whole fleet.
4. `boxd_harvest` brings the work's transcript and git to this laptop. Each session is copied, verified, and then
   replaces the laptop's copy; the last good copy is never overwritten before the new one is verified. `files` brings
   outputs back.
5. `boxd_sleep` hibernates (it always works, saved or not), `boxd_resume` wakes or rebuilds from the saved transcript,
   and `boxd_drop` destroys a finished, saved work.

The other tools: `boxd_read` reads one file or the guest's server log without a harvest; `boxd_exec` runs one command
with a timeout; `boxd_reassign` moves an unstarted work's machine to another work id, so capacity at the machine limit
is reused; `boxd_golden` builds, lists or prunes golden images.

`saved` says whether this laptop holds the work: `fresh` when a harvest ran after the last prompt, `stale` when a
prompt came later, `none` otherwise. Every change acts on the machine id the ledger recorded, and refuses `NOT_OURS`
when the name now points at another machine.

`boxd_drop` destroys nothing the laptop cannot account for. It refuses when:

- the work is not saved, or the guest's own sessions moved on since the harvest: a later message or a new session
  (`NOT_SAVED`);
- the guest folder is not a git repository (`GIT_UNKNOWN`);
- the tree has untracked or ignored paths that the last harvest did not copy back at the digest the guest still has
  (`UNTRACKED`);
- the tree is dirty and no patch was stored (`DIRTY`).

A work whose machine is gone in every region closes without destroying anything, and says what was not saved.

The plugin also declares `boxd.works` and the list snapshot `boxd.works.list` under the source contract (`package.json`'s `sources`), for
Memory's collector and other scripts, not for answering questions. `events_list` (`boxd_events_list`) lists each phase
change of this laptop's works as one event, oldest first, from the ledger's event log only: no boxd call, no machine
woken, no lock taken. Each event's title is the plugin's own sentence (the work id, its phase, how a run ended, its
code), never a prompt, a transcript or anything a guest wrote. `probe` (`boxd_probe`) names whose ledger it is: this
computer and its OS user. Both are tools RPC methods, not model tools, and every `access` value allows them.
[docs/scripting.md](docs/scripting.md#the-boxdworks-source) describes the calls.

### What it costs

boxd bills a running machine for its active CPU and its resident memory, a hibernated one for its disk only, and a
dropped one nothing. An idle running work costs about as much as one in standby, so hibernation is the saving. Every new
work machine is created with auto-suspend off, auto-hibernate after 2 hours idle (`autoHibernateMinutes`) and
`idle.ignore-outbound` off, at every `access` level, so a forgotten work stops costing memory within 2 hours even with
the laptop off. With `access: "all"` the plugin also harvests a finished work and then hibernates it after 10 idle
minutes (`autoSleepMinutes`); at the other levels only with `automation: "on"`, which is your consent. It never drops
anything by itself. Automation consent is per OpenCode process, and the ledger is one per laptop, so a process at
`access: "all"` also acts on works another project created at `"ask-changes"`. `boxd_status` carries `cost` and
`cleanup` (today's cost is boxd's machine cost only; model spend is not measured), and `/boxd-cleanup` shows what costs
money and confirms each cleanup action with a permission prompt that only you answer.

## Files in and out

A work moves data both ways, and each call records the file's name, size and sha256 in the ledger, never its content.

- **In:** `boxd_submit` copies `files` to the machine before the prompt. Paths are relative to the work tree, and 8 MiB
  a file and 32 MiB a call are the caps.
- **Out:** `boxd_harvest` copies `files` back, into the work's laptop folder or `to`. A copy goes to a temp file, is
  verified, and is renamed into place; a symlink is refused, and a file edited on the laptop since the last harvest is
  never overwritten (`FILE_CONFLICT`).

Laptop paths must be inside the project or a folder named in the `allowedRoots` option, and a symlink is never followed.
When the host asks, allow the path with the `external_directory` rule as well as the path rule:

```jsonc
{ "permissions": [{ "action": "external_directory", "resource": "/srv/work/*", "effect": "allow" }] }
```

See [docs/scripting.md](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/scripting.md) for a worked
example.

## Permissions

**Every tool is allowed by default.** The plugin inserts this block into every agent that has a base `* * allow`,
directly after it:

```json
[
  { "action": "boxd_*", "resource": "*", "effect": "allow" },
  { "action": "boxd_cleanup", "resource": "*", "effect": "ask" },
  { "action": "boxd_status", "resource": "*", "effect": "allow" },
  { "action": "boxd_job", "resource": "*", "effect": "allow" },
  { "action": "boxd_read", "resource": "*", "effect": "allow" },
  { "action": "boxd_events_list", "resource": "*", "effect": "allow" },
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
`boxd_harvest` writes this laptop, `boxd_sleep`, `boxd_resume`, `boxd_reassign`, `boxd_golden` and `boxd_exec` change
or run on machines, and `boxd_drop` destroys one. `boxd_status`, `boxd_job` and `boxd_read` are the reads, and so are
`boxd_events_list` and `boxd_probe`, the `boxd.works` source's methods.
`boxd_cleanup` is `/boxd-cleanup`'s own action, not a tool: it asks at every level, so each cleanup action is your
answer to a prompt.

The guards that do not depend on a prompt stay: a machine that idles hibernates, `boxd_sleep` always works, drop's own
guard refuses anything the laptop cannot account for, and every create is recorded in the ledger before it runs.

To restrict, choose one of three:

1. **`access`**, one option for the plugin: `"all"` (the default), `"ask-changes"` (reads run, every change asks) or
   `"read-only"` (reads run, every change is denied).
2. **An agent's own rules**, such as a read-only agent: `"permissions": [{ "action": "boxd_*", "resource": "*", "effect":
   "deny" }, { "action": "boxd_status", "resource": "*", "effect": "allow" }, { "action": "boxd_job", "resource": "*",
   "effect": "allow" }]`.
3. **A per-tool rule** in your `opencode.json`: `{ "action": "boxd_drop", "resource": "*", "effect": "ask" }`, or
   `"deny"` to turn one tool off.

The last matching rule wins, so a later rule of yours still decides. Agents without a base allow are left alone, and
`/boxd-status` names any agent that does not carry the block, with the rules to paste.

## Configure

See [docs/configuration.md](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/configuration.md) for the
options, the permission rules and every error code.

## Organisation rollout

The region choice, the CI reserve and the image recipe are the policies worth setting centrally:

```jsonc
// /etc/opencode/opencode.json on Linux
// /Library/Application Support/opencode/opencode.json on macOS
{
  "plugins": [{
    "package": "github:joe-broadhead/opencode-boxd#v0.1.4",
    "options": { "region": "auto", "keepFree": { "fra": 20, "nyc": 0 }, "size": "2x8" }
  }]
}
```

Each member still needs the boxd CLI signed in on their own laptop, and a model key as a sealed, host-bound secret.

## Troubleshooting

A tool that fails returns `state`, `error` (the code), `message` (what happened) and `next` (the one call to make).

| Code | What to do |
|---|---|
| `HOST_UNTESTED` | Use OpenCode `>=2.2.3 <2.4.0`, or set `"allowUntestedHost": true` to run anyway. |
| `OPTIONS_INVALID` | Fix the plugin options in `opencode.json`, then restart OpenCode. A removed option, such as `snapshot`, says what to do instead. |
| `STATUS_UNAVAILABLE` | Restart OpenCode, then run `/boxd-status` again. |
| `SKILLS_INVALID` | Reinstall the plugin so its skill file is present, then restart OpenCode. |
| `NAME_INVALID` | An input failed its rule; `field` names it. Fix that input, then call again. |
| `PATH_REFUSED` | A laptop path is outside the project and the allowed roots, or is a symlink. Name its root in `allowedRoots`, and allow it with the `external_directory` rule. |
| `FILE_TOO_LARGE` | A file is over 8 MiB, or the call is over 32 MiB. Move a smaller file, or split it. |
| `FILE_CONFLICT` | A harvested file changed on the laptop since the last harvest, so it was not overwritten. Keep the edit and leave that path out, or restore it and harvest again. |
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
| `GUEST_VERSION` | The guest's OpenCode differs from this laptop's, and the call moves a transcript. `boxd_ensure` upgrades it in place once the session is idle. |
| `GUEST_UNRESPONSIVE` | The guest is short of memory or overloaded; the message names the largest processes. Tell the user, or stop them with `boxd_exec`. |
| `GUEST_SERVER_DOWN` | Nothing listens on the guest's OpenCode port. `boxd_ensure` starts it. |
| `GUEST_FAILED` | The guest helper failed; its words are in the message. `boxd_ensure`; if it repeats, `boxd_read({ workId, log: "server" })`. |
| `GUEST_WORKSPACE` | The guest folder could not be made or cloned. Fix the clone's access or the disk, then `boxd_ensure`. |
| `NOT_SAVED` | The work is not saved, or the guest's sessions moved on since the harvest. `boxd_harvest`, then drop again. |
| `UNTRACKED` | Untracked or ignored paths were not harvested; `paths`, `count` and `kind` name them. Harvest them with `files`, or delete them on the machine, then harvest again. |
| `DIRTY` | The guest has uncommitted work and no stored patch. `boxd_harvest`, then drop again. |
| `GIT_UNKNOWN` | The guest folder is not a git repository. Make it one, or `boxd_sleep` instead. |
| `EXPORT_INVALID` | A transcript failed its checks; the stored copy is unchanged. `boxd_harvest` again from an idle session. |
| `IMPORT_FAILED` | This laptop's `opencode session import` failed; the export is kept. `boxd_harvest` again. |
| `BOXD_FAILED` | The boxd CLI failed in a way the plugin does not know; its words are in the message, redacted. Read it, and run `boxd_status` before trying again. |
| `BOXD_MISSING` | No laptop boxd CLI: it is missing, not signed in, or the in-VM CLI. Install the laptop CLI on the server's `PATH` and run `boxd auth login`. |
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

- **No live check has run against this release.** Not one of the live checks L1 to L13 in
  [docs/live-check.md](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/live-check.md) has run: L1 (regions,
  ids and the listing's keys), L2 (the creation flags and idle billing), L3 (the machine limit and usage shapes), L4
  (boxd's not-found words), L5 (the machine limit's refusal), L6 (many resizes and the VM agent), L7 (golden builds),
  L8 (steer, queue and interrupt on a real model), L9 (rename and labels), L10 (a second harvest and a bypassing
  prompt), L11 (the import of a real earlier ledger), L12 (the parallel-ensure stall on the owner's Mac) and L13 (the
  macOS paths). The release rests on the unit and host suites and on the boxd behaviour measured for earlier releases,
  against one account, which
  [docs/architecture.md](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/architecture.md) records.
- **The machine limit and usage are read from boxd's documentation.** Until L3 runs, the per-region shape of
  `manage machine-limit --json` and the keys of `manage usage --json` are read as boxd's documentation describes them,
  unconfirmed against real boxd; the region headroom in status, `MACHINE_LIMIT`'s numbers, `auto`'s region choice and
  the machine cost rest on that reading, and L3 may change it.
- **A call waits at most 4 minutes, measured up to 10.** A tool call answers its real state (`creating`, `starting`)
  with a `next` after at most 4 minutes. Calls of 2, 5 and 10 minutes finished on every tested OpenCode, through Code
  Mode and the tools RPC; whether a longer call would be cut was not measured.
- **Model spend is not measured.** `cost.today`, the budget and `/boxd-cleanup` count boxd's machine cost only, as boxd
  estimates it, and the per-hour figure is the plugin's estimate from boxd's rates; what the guests' models cost is not
  in any figure.
- **Automation consent is per OpenCode process.** `automation` and `access` are read by each OpenCode process, and the
  ledger is one per laptop: a process at `access: "all"`, or with `automation: "on"`, also harvests and hibernates the
  finished works that a project at `"ask-changes"` created.
- **A harvest's copy can be raced by your own user.** Each laptop path is checked before the copy (inside a root, no
  symlink) and the file is renamed into place after it is verified; a process running as your own user that swaps a
  folder on that path for a symlink in between can still redirect the file. Another user cannot.
- **The import of earlier works is time-limited.** This release imports the ledger of the earlier releases once, and
  reads and adopts a guest still running the earlier helper; the v0.2 line removes that import, so a laptop that skips
  this release cannot bring its earlier works forward.
- **The laptop's boxd CLI only.** The CLI inside a boxd machine acts in one region and has no organisation usage, so
  every tool answers `BOXD_MISSING` on it, and no machine is changed.
- **"Gone" takes two checks.** A work's machine counts as gone only when a fresh all-region listing has no
  `oc-<work id>` and a `get` of the recorded machine id is not found in every region; any other failure keeps the work
  open with `BOXD_FAILED`.
- **One race in the read rule.** A read runs only on a machine a listing at most 2 s old shows running; a machine that
  hibernates inside those 2 s is woken by the read. boxd has no "exec without waking" yet.
- **A create can land after boxd stops answering.** `boxd_ensure` adopts the machine when it appears, and answers
  `CREATE_UNCERTAIN` until then.
- **Prompts that bypass the plugin.** A person on `boxd connect`, or another laptop, can prompt a guest; drop compares
  the guest's own session marks with the harvest's, so such a prompt makes it refuse `NOT_SAVED`.
- **Steer waits for the current step.** OpenCode cannot inject text into a step that is running: a step blocked in a
  long tool call takes a steered prompt when that call returns, and only `mode: "interrupt"` reaches it sooner.
- **Model credentials stay out of images.** A guest gets its key from a sealed, host-bound `boxd env` secret, or from a
  person's `opencode auth login` on that one machine; a guest session cannot finish an interactive sign-in by itself.
  A token that expires stops every guest that uses it, and `boxd_status` folds those failures into one line.
- **Cost figures are estimates** until boxd marks the day's usage complete, up to 25 minutes later, and machine cost
  needs an owner's or admin's sign-in.
- **Notices wake the coordinator.** With `notices: "wake"` (the default), a coordinator that is idle starts a turn at
  most once a minute; `"queue"` waits for its next turn instead.
- In Jelly, the `access` setting is drawn as a choice of three, which needs a Jelly that reads declared choices: an
  older Jelly refuses the plugin's whole declaration.
- Updates are not automatic for a Git install, and `opencode plugin update` and `opencode plugin check` do not work on
  one: to move to a newer release, remove the old entry and add the new tag.

## Uninstall

```sh
opencode plugin remove github:joe-broadhead/opencode-boxd#v0.1.4
```

The ledger is yours to keep or delete. Machines are boxd's: `boxd machine remove oc-<work id> -y` destroys one.

## Links

- [Configuration, permission rules and errors](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/configuration.md)
- [Architecture](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/architecture.md)
- [Scripting](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/scripting.md)
- [Golden images](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/images.md)
- [Jelly](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/jelly.md)
- [Live check against real boxd](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/live-check.md)
- [The design](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/v1-design.md)
- [Changelog](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/CHANGELOG.md)
- [Licence](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/LICENSE)
