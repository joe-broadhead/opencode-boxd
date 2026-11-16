# Configuration

## Options

All options go in the plugin entry in `opencode.json`, and every one is optional:

```jsonc
{
  "plugins": [{
    "package": "github:joe-broadhead/opencode-boxd#v0.0.6",
    "options": { "region": "auto", "size": "2x8", "notices": "wake" }
  }]
}
```

| Option | Default | What it does |
|---|---|---|
| `access` | `"all"` | What the plugin's own tools may do without asking: `"all"` allows everything, `"ask-changes"` allows the reads and asks for every change, `"read-only"` allows the reads and denies every change. A later rule of the user's still wins. |
| `allowedRoots` | `[]` | Absolute laptop folders a work may read and write besides the project. A path outside both is refused. |
| `allowUntestedHost` | `false` | Run on an OpenCode outside `>=2.2.3 <2.4.0`. Status then says the host is untested. |
| `region` | `"auto"` | Where a new work goes: `"auto"` picks the region with the most free machines after `keepFree`, preferring one that already has the golden image; or `"fra"` or `"nyc"`. |
| `keepFree` | `{ "fra": 0, "nyc": 0 }` | Machines `"auto"` leaves free in each region, such as the organisation's CI pool. |
| `size` | `"2x8"` | A new work's size: `"1x4"`, `"2x8"`, `"4x16"` or `"8x32"` (vCPU x GiB). |
| `git` | none | `{ "name", "email" }`: the guest's git identity for every new work. Never a token. |
| `goldenPrefix` | `"oc-golden"` | Golden image names are `<goldenPrefix>-<opencode version>-<size>`, such as `oc-golden-2.2.6-2x8`. |
| `goldenBase` | `"stock"` | What a golden build starts from: stock boxd, or a snapshot name in the region it lives in. A base that holds model credentials is refused; [images.md](images.md) gives the recipe. |
| `goldenSetup` | none | An absolute laptop path to a script, inside the project or an allowed root, run on every golden builder before the scrub. |
| `buildGolden` | `"auto"` | `"auto"` builds a missing golden image when a work needs it; `"never"` answers `GOLDEN_MISSING` instead. |
| `notices` | `"wake"` | How a work's change reaches its coordinator: `"wake"` posts a notice that starts an idle coordinator's turn, `"queue"` posts one that waits for its next turn, `"off"` posts nothing. At most one notice a minute per coordinator. |
| `autoHibernateMinutes` | `120` | The platform's idle bound, set on every new work machine at creation (30 to 1440). Auto-suspend is always off: standby bills resident memory too. |
| `automation` | `"auto"` | Whether the plugin harvests and then hibernates finished and orphaned works by itself: `"auto"` is on at `access: "all"` and off otherwise; `"on"` is your standing consent at every access level; `"off"` is never. It never drops anything. Consent is per OpenCode process, and the ledger is one per laptop: a process at `access: "all"` (or with `automation: "on"`) also harvests and hibernates the finished works another project created at `"ask-changes"`. |
| `autoSleepMinutes` | `10` | Idle minutes before automation harvests and hibernates a finished work; `0` turns that step off. Setting it is not consent. |
| `orphanHours` | `12` | A running, not busy work that no plugin call touched for this long is harvested and hibernated, when automation is on. |
| `leaseDays` | `0` | A `delete-after` timer of this many days on every new work machine, renewed on activity; `0` is off, because boxd deletes the machine whatever it holds, unsaved work included. |
| `budget` | none | `{ "daily", "action" }`: today's machine cost, in the organisation's billing currency, at which status warns (`"warn"`) or the calls that would make a machine run are refused (`"refuse"`, `BUDGET_REACHED`). Machine cost only: model spend is not measured in this release. |
| `costContext` | `true` | One short fleet line on the tail of a coordinator's request when the fleet changed, and the works list on a compaction; `false` turns both off. The system prompt is never changed. |
| `idleCheck` | `true` | The end-of-turn check that speaks only when money burns and automation will not act; `false` turns it off. |

An unknown option, a value out of its range, or a removed option stops the plugin with `OPTIONS_INVALID`; OpenCode's
plugin list shows why. The option `snapshot` is gone: a golden image is built by the plugin, from stock or from
`goldenBase`.

The plugin is tested on 2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7 and 2.3.0. Inside `>=2.2.3 <2.4.0` a release that was not tested, such as 2.2.99, still starts: status marks the version `untested`
and the next step is the same as on a tested release. Outside the range the plugin does not start unless
`allowUntestedHost` is `true`.

## Where the ledger lives

`~/.local/share/opencode-boxd/v1/`, a folder of mode 0700 whose files are 0600:

- `works/<work id>/work.json`: the record. The region, the machine name and its boxd machine id, the size and image,
  the laptop folder and the guest folder, the root session and the coordinator its notices go to, the last prompt, what
  was saved (each session's digest and its last message id and count), the last run, git, and the files moved in and
  out by name, size and sha256.
- `works/<work id>/exports/<session id>.json`: each harvested transcript, copied from the guest and verified.
- `works/<work id>/patch.diff` and `untracked/`: the tracked changes and the untracked files at the last harvest.
- `events.jsonl`: every phase change, one line each, with a sequence number that is `boxd_status`'s cursor. It keeps at
  least the last 5 MiB.
- `index.json`: a cache of each record's state, region, phase and `saved`, refreshed by modification time.

Every write is a temp file beside the old one, verified, fsynced and renamed over it; nothing is written in place, so a
crash leaves the old file. Two OpenCode processes on one laptop share the ledger through a lock per work.

The first start of this release imports the earlier `works/` ledger once into `v1/`, all or nothing, and adds only a
`works/README-MOVED-TO-v1/` note folder beside the old records.

## Permission rules

The plugin inserts its block directly after each agent's base `* * allow`. The last matching rule wins, so a rule of
yours later in the agent, or in the session, still decides.

The block is generated from `defaultRules(access)`, and it is printed here in full for each value, so it can be copied
into an agent that gets no block of its own. `boxd_cleanup` is `/boxd-cleanup`'s own action: it asks at every level.

`access: "all"` (the default):

```json
[
  { "action": "boxd_*", "resource": "*", "effect": "allow" },
  { "action": "boxd_cleanup", "resource": "*", "effect": "ask" },
  { "action": "boxd_status", "resource": "*", "effect": "allow" },
  { "action": "boxd_job", "resource": "*", "effect": "allow" },
  { "action": "boxd_read", "resource": "*", "effect": "allow" },
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

`access: "ask-changes"`:

```json
[
  { "action": "boxd_*", "resource": "*", "effect": "ask" },
  { "action": "boxd_cleanup", "resource": "*", "effect": "ask" },
  { "action": "boxd_status", "resource": "*", "effect": "allow" },
  { "action": "boxd_job", "resource": "*", "effect": "allow" },
  { "action": "boxd_read", "resource": "*", "effect": "allow" },
  { "action": "boxd_ensure", "resource": "*", "effect": "ask" },
  { "action": "boxd_submit", "resource": "*", "effect": "ask" },
  { "action": "boxd_harvest", "resource": "*", "effect": "ask" },
  { "action": "boxd_sleep", "resource": "*", "effect": "ask" },
  { "action": "boxd_resume", "resource": "*", "effect": "ask" },
  { "action": "boxd_reassign", "resource": "*", "effect": "ask" },
  { "action": "boxd_golden", "resource": "*", "effect": "ask" },
  { "action": "boxd_exec", "resource": "*", "effect": "ask" },
  { "action": "boxd_drop", "resource": "*", "effect": "ask" }
]
```

`access: "read-only"`:

```json
[
  { "action": "boxd_*", "resource": "*", "effect": "deny" },
  { "action": "boxd_cleanup", "resource": "*", "effect": "ask" },
  { "action": "boxd_status", "resource": "*", "effect": "allow" },
  { "action": "boxd_job", "resource": "*", "effect": "allow" },
  { "action": "boxd_read", "resource": "*", "effect": "allow" },
  { "action": "boxd_ensure", "resource": "*", "effect": "deny" },
  { "action": "boxd_submit", "resource": "*", "effect": "deny" },
  { "action": "boxd_harvest", "resource": "*", "effect": "deny" },
  { "action": "boxd_sleep", "resource": "*", "effect": "deny" },
  { "action": "boxd_resume", "resource": "*", "effect": "deny" },
  { "action": "boxd_reassign", "resource": "*", "effect": "deny" },
  { "action": "boxd_golden", "resource": "*", "effect": "deny" },
  { "action": "boxd_exec", "resource": "*", "effect": "deny" },
  { "action": "boxd_drop", "resource": "*", "effect": "deny" }
]
```


Every tool this plugin registers is allowed by default, so an agent can create, run and destroy a billing machine
without a prompt. The guards that do not depend on a prompt still hold: a machine that idles hibernates, `boxd_sleep`
always works, drop refuses anything the laptop cannot account for, and the ledger records a create before it runs.

An agent without a base allow gets no rules: inserting there would turn a default deny into an ask. `/boxd-status` names
each agent that lacks the block, and prints the block for the access value in force to paste first in that agent's own
permissions, followed by your top-level rules for boxd tools.

## What the plugin relies on

- **The laptop is the source of truth.** A harvest copies each session's export from the guest with `machine cp`,
  checks its size and sha256 against what the guest reported, and only then renames it over the stored copy; it then
  deletes and re-imports the session on this laptop, parents first, so the laptop holds the newest transcript.
- **A transcript moves only between matching versions.** A call that moves a transcript compares the guest's OpenCode
  with this laptop's (`GUEST_VERSION`); reads work across versions.
- **A read never wakes a machine.** `boxd_status`, `boxd_job`, `boxd_read` and the watcher read a guest only when a
  listing at most 2 s old shows its machine running, never upload anything, and never write the ledger. `boxd_status`
  and the watcher never read an idle guest, because a read resets the machine's idle clock.
- **Every change acts on the machine id.** Before a change, `machine get` resolves `oc-<work id>` in its region and the
  call refuses `NOT_OURS` unless the id is the recorded one; then it acts on the id.
- **One runner owns every process.** At most 12 boxd processes at once for tool calls and reads, 4 for `boxd_exec`, and
  2 laptop imports; each with an explicit timeout, the call's stop signal and an output cap.
- **Status is bounded.** One `boxd_status` answers for 300 works with at most `limit` items, `more`, and repeated causes
  folded into `groups`.
- **Notices carry only the plugin's words:** work ids, phases, outcomes, codes from the table below, and a cursor. Never
  a guest's text.

## Errors

Every plugin error reads `CODE: What happened. Next step: What to do.`, with exactly one next step. A tool's result for
it is `{ "state", "error", "message", "next" }`, plus the facts its code carries, so a Code Mode program or a script
reads the same parts the model does. No error, log or status line contains a token or a signed URL.

| Code | State | What it means | Next step |
|---|---|---|---|
| `HOST_UNTESTED` | — | This OpenCode version is outside the supported range. | Use OpenCode >=2.2.3 <2.4.0, or set the plugin option "allowUntestedHost": true to run anyway. |
| `OPTIONS_INVALID` | — | The plugin options are not valid. | Fix the plugin options in opencode.json, then restart OpenCode. |
| `STATUS_UNAVAILABLE` | — | boxd's status could not be read. | Restart OpenCode, then run /boxd-status again. |
| `SKILLS_INVALID` | — | The plugin's skill file is missing or invalid. | Reinstall the plugin so its skill file is present, then restart OpenCode. |
| `NAME_INVALID` | refused | An input failed its rule; field names it. | Fix the field the message names, as its reason says, then call again. |
| `PATH_REFUSED` | refused | A laptop path is outside the project and allowedRoots, or is a symlink. | Pass a path inside the project, or add its root to the plugin option "allowedRoots" and allow it with the external_directory rule. |
| `FILE_TOO_LARGE` | refused | A file is over 8 MiB, or the call is over 32 MiB. | Move a smaller file, or split it: the limit is 8 MiB a file and 32 MiB a call. |
| `FILE_CONFLICT` | refused | The laptop file changed since the last harvest. | Keep the local edit and leave that path out, or restore the harvested copy and harvest again. |
| `NOT_OURS` | refused | No open work has this id; or oc-<id> now has another id than the recorded machineId; or the recorded machine lives under another name; or two regions hold oc-<id>. Nothing was changed. | For an unknown id, boxd_ensure({ workId }). Otherwise look at the machines the message names with boxd machine get, and rename them back or boxd_reassign. |
| `NOT_REASSIGNABLE` | refused | from has a session, uploaded files or a dirty tree, or to is an open work. | boxd_drop it after a harvest, or reassign a work with no prompt yet. |
| `MACHINE_LIMIT` | refused | No region has room for another machine; limit, inUse and free are given per region. | Pass region: "<other region>" when it has room; otherwise free machines with boxd_drop or boxd_reassign, or have the owner raise the limit with boxd manage machine-limit request --max-vms <n>. |
| `SIZE_UNAVAILABLE` | refused | The organisation's quota does not allow this size. | Pick a smaller size. |
| `GOLDEN_MISSING` | refused | No golden image for this region, size and OpenCode version, and the option buildGolden is "never". | boxd_golden({ region, size }), then call again. |
| `GOLDEN_BUILD_FAILED` | failed | A golden image build failed at the step the message names, or its base holds an OpenCode session. | Read the message; fix goldenSetup or the base, then boxd_golden again. |
| `GOLDEN_HAS_CREDENTIAL` | refused | The base holds ~/.local/share/opencode/auth.json. Model credentials are never baked into an image, because an image reaches every work and everyone in the organisation who can boot it. | Remove auth.json from the base, or build from stock, and give works a model key another way: a sealed, host-bound boxd env secret (boxd env set <KEY> <value> --secret --domains <provider hosts>), a separately named secret per provider, or opencode auth login on one work's own machine after boxd connect. Then boxd_golden again. |
| `MACHINE_SHARED` | refused | The machine is shared, which deletes the guest's sign-in. | Unshare it with boxd machine unshare, or boxd_drop it and boxd_ensure again. |
| `MACHINE_ISOLATED` | refused | The machine is isolated: no git integration and no in-VM CLI. | boxd_drop it, then boxd_ensure again. |
| `MACHINE_STARTING` | starting | The machine is still starting after this call's wait. | The same call again; it waits. |
| `MACHINE_GONE` | gone | A fresh all-region listing and a get of the recorded machine id found the machine nowhere. | boxd_resume({ workId }) to rebuild it, or boxd_drop({ workId }) to close the work. |
| `MACHINE_ASLEEP` | asleep | The machine is hibernated, and this call does not wake it. | boxd_resume({ workId }), or pass wake: true to boxd_exec. |
| `AGENT_UNREACHABLE` | unreachable | boxd's VM agent on the machine does not answer, and the plugin has not rebooted this machine itself. | boxd_ensure({ workId, repair: "reboot" }); a reboot ends a running run. |
| `SESSION_BUSY` | busy | The session is running, and this call needs it idle. | Wait for the work's notice, or pass mode: "interrupt" to boxd_submit, or partial: true to boxd_harvest. |
| `SESSION_MISSING` | failed | The guest no longer has the work's session. | boxd_resume({ workId }), which imports the saved transcript. |
| `RUN_FAILED` | failed | The last run failed; error is its one line. | Read lastText with boxd_job, then boxd_submit again. |
| `RUN_INTERRUPTED` | failed | The guest's OpenCode stopped mid-run. | boxd_harvest({ workId }), then boxd_submit again. |
| `GUEST_AUTH_FAILED` | failed | The model provider or a pushed host refused the credential, or the guest has none. | Set or rotate the credential (a sealed, host-bound boxd env secret (boxd env set <KEY> <value> --secret --domains <provider hosts>), a separately named secret per provider, or opencode auth login on one work's own machine after boxd connect), then boxd_submit again. A session never starts an interactive sign-in itself. |
| `GUEST_VERSION` | refused | The guest's OpenCode differs from this laptop's, and this call moves a transcript. | boxd_ensure({ workId }) upgrades it in place once the session is idle. |
| `GUEST_UNRESPONSIVE` | unreachable | The guest is short of memory or overloaded; the facts are in the message. | Tell the user which processes the message names, or stop them with boxd_exec. |
| `GUEST_SERVER_DOWN` | unreachable | Nothing listens on the guest's OpenCode port. | boxd_ensure({ workId }) starts it. |
| `GUEST_FAILED` | unreachable | The guest helper failed; its words are in the message. | boxd_ensure({ workId }); if it repeats, boxd_read({ workId, log: "server" }). |
| `GUEST_WORKSPACE` | failed | The guest folder could not be made or cloned. | Read the message (clone auth, disk), fix it, then boxd_ensure({ workId }). |
| `NOT_SAVED` | refused | The work is not saved: no fresh harvest since the last prompt, or the guest's sessions moved on since the harvest. | boxd_harvest({ workId }), then drop again. |
| `UNTRACKED` | refused | Untracked or ignored paths were not harvested; paths, count and kind name them. | Harvest them with files, or delete them on the machine, then boxd_harvest again. |
| `DIRTY` | refused | The guest has uncommitted work and no stored patch. | boxd_harvest({ workId }), then drop again. |
| `GIT_UNKNOWN` | refused | The guest folder is not a git repository. | Make it one, or boxd_sleep({ workId }) instead. |
| `EXPORT_INVALID` | failed | A transcript failed its checks: shape, digest, a cycle or a missing parent. | boxd_harvest({ workId }) again from an idle session. |
| `IMPORT_FAILED` | failed | This laptop's opencode session import failed; the export is kept. | boxd_harvest({ workId }) again; the stored file is retried. |
| `BOXD_FAILED` | unreachable | The boxd CLI failed in a way the plugin does not know; its words are in the message, redacted. | Read the message, and run boxd_status before trying again. |
| `BOXD_MISSING` | unreachable | No laptop boxd CLI: it is missing, not signed in, or the in-VM CLI. | Install the laptop boxd CLI on the server's PATH and run boxd auth login, in that server's HOME. |
| `TIMEOUT` | unreachable | A step did not answer in its bound; the message names the step. | The same call in a later turn. |
| `CANCELLED` | cancelled | The call was stopped; uncertain is true when a write was in flight. | Read the work with boxd_job({ workId }) before acting again. |
| `CREATE_UNCERTAIN` | unreachable | A create timed out, and no machine was found yet. | boxd_ensure({ workId }) again: it adopts the machine if one landed. |
| `LEDGER_FAILED` | failed | The ledger could not be read or written. | Check that the ledger folder is writable, then restart OpenCode. |
| `LEDGER_LOCKED` | busy | Another OpenCode process holds this work's lock. | The same call again in a few seconds. |
| `LEDGER_IMPORTING` | busy | The v0 import is not complete yet, here or in another OpenCode process; progress says how far. No tool reads a partial ledger. | The same call again in a few seconds. |
| `IMPORT_V0_FAILED` | failed | The v0 import could not run (the all-region listing failed, so no v1 ledger was made), or one v0 record could not be read (that work id is blocked; the v0 file is untouched). | Sign the boxd CLI in and call again; for one record, fix or remove that v0 file and restart OpenCode. |
| `BUDGET_REACHED` | refused | Today's machine cost has reached the budget's daily limit, and budget.action is refuse; today, daily and currency are in the result. A call that would make a machine run is refused. | Lower the cost first: boxd_sleep({ select: "idle" }), then boxd_drop({ select: "saved-finished" }); or raise budget.daily. It resets at local midnight. |
| `RULES_NOT_ADDED` | — | boxd's default permission rules did not load. | Restart OpenCode, then run /boxd-status; a machine change may run without asking until the rules load. |


### Warnings

A warning sits beside a result that succeeded, in `warnings`, `attention` and status; it is never a refusal.

- **`UNHARVESTED_SLEEP`**: The machine was hibernated before its last prompt was harvested. Next step: boxd_resume({ workId }), then boxd_harvest({ workId }).
- **`BUDGET_WARN`**: Today's machine cost has reached the budget's daily limit. Next step: Lower the cost: boxd_sleep({ select: "idle" }), then boxd_drop({ select: "saved-finished" }); or raise budget.daily.
- **`BUDGET_UNKNOWN`**: boxd's machine usage is for organisation owners and admins, so this sign-in cannot measure the budget; refuse acts as warn. Next step: Sign the boxd CLI in as an owner or admin to measure the budget, or remove the budget option.
- **`LEASE_EXPIRING`**: The work's delete-after lease ends within 24 hours, and boxd deletes the machine whatever it holds. Next step: boxd_harvest({ workId }) now; any change call for the work renews the lease.
- **`AUTOMATION_BLOCKED`**: The plugin's automatic harvest or sleep of this work failed at the step the message names. Next step: Read the code the message names, fix it, then boxd_harvest({ workId }) and boxd_sleep({ workId }).
- **`NO_MODEL_CREDENTIAL`**: No secret that OpenCode reads as a model provider key is set, so a work's first prompt will answer GUEST_AUTH_FAILED. Next step: Give works a model key: a sealed, host-bound boxd env secret (boxd env set <KEY> <value> --secret --domains <provider hosts>), a separately named secret per provider, or opencode auth login on one work's own machine after boxd connect.
