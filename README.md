# boxd for OpenCode

Runs an OpenCode session on a private [boxd](https://boxd.sh) machine and keeps the transcript on your laptop.

Unofficial; not affiliated with boxd.

## Requirements

- OpenCode `>=2.2.3 <2.3.0`, tested on 2.2.3, 2.2.4, 2.2.5 and 2.2.6.
- The [boxd CLI](https://boxd.sh), signed in, on your `PATH`.
- **First step: a golden image.** The stock boxd image ships OpenCode 1.19.5, which this plugin refuses, so build one
  image with the OpenCode version this laptop runs and a model credential it can reach:
  [the golden image](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/golden-image.md). The default name is
  `opencode-golden`; set `"snapshot"` to your own in `opencode.json`. `boxd_status` says when it is missing, and
  `boxd_ensure` and `boxd_resume` refuse to create a machine without it.
- macOS or Linux on the laptop.

## Install

```sh
opencode plugin add github:joe-broadhead/opencode-boxd#v0.0.1
```

Run `opencode reload`, or restart OpenCode, then run `/boxd-status`.

Each release has its own tag, and a Git install does not update by itself. To move to a newer release, remove the old entry with `opencode plugin remove github:joe-broadhead/opencode-boxd#v0.0.0`, then add the new tag with `opencode plugin add github:joe-broadhead/opencode-boxd#v<version>`.

Or add the plugin to `opencode.json` instead, with the same spec:

```json
{ "plugins": [{ "package": "github:joe-broadhead/opencode-boxd#v0.0.1" }] }
```

The install takes the GitHub release tag. Its commit carries the built `dist/`, so the install runs no build.
A new release is a new tag: install it with its own `#v<version>` spec.

A snapshot is an image, not a session. The machine is a cache with more CPU; your laptop keeps the transcript.

## Sign in

The plugin never reads your boxd account or credentials; it runs your own `boxd` CLI, so sign in the way you always do:

```sh
boxd auth login
```

Nothing else is stored: the plugin keeps a ledger under `~/.local/share/opencode-boxd/works/`, and the machine holds no
session you cannot get back.

## Use

1. `boxd_ensure` with a short work id. The machine is named `oc-<work id>`, and the work is recorded in the ledger. The
   guest works in `/home/boxd/work/<work id>`; `directory` names the laptop folder the work belongs to, and defaults to
   the current project.
2. `boxd_submit` with the task, and optionally `files: [{ from, to }]` to copy data in. Each `from` is a laptop file
   inside the project or an allowed root, and each `to` is a path inside the work tree. It returns when the guest has
   admitted the prompt, not when the model finishes, with `queued: true` when the session was still running, so the
   prompt waits in its inbox for that run.
3. `boxd_job` in a later turn: busy, idle, asleep, gone or starting, with the guest session's last outcome
   (`completed`, `failed` or `aborted`) when it is idle. A running machine's answer also carries `lastText`, the
   session's newest assistant text (redacted, at most 300 characters), `lastActivityAt`, and `pending`, the prompts
   waiting in its inbox: a run can complete and still say its task did not happen. It never wakes a machine, because
   waking starts billing; a hibernated work reports `asleep` with `boxd_resume` as its next step, and `asleepBy` says
   who put it down: `boxd_sleep`, with `sleptAt`, or `idle_or_cli` for the idle bound or the boxd CLI, whose time boxd
   does not report.
4. `boxd_harvest`, optionally with `files: ["SUMMARY.md"]` and `to`, copies the files a work produced back to this
   laptop. The session tree is exported, imported here parents first, git is recorded, and then the files move.
5. `boxd_sleep` to hibernate, `boxd_resume` to wake or rebuild, `boxd_image` to save a snapshot, `boxd_drop` to destroy.
   Hibernating destroys nothing and keeps the disk, so `boxd_sleep` works even when the guest cannot be harvested; it
   records a warning that the last prompt is not yet on the laptop, and status shows it.
6. `boxd_status` reads the ledger and each open work's machine state. It starts nothing.

Every tool is allowed by default, reads and machine changes alike, so `ensure`, `submit`, `harvest`, `sleep`, `resume`,
`image` and `drop` run without asking, and `boxd_status` and `boxd_job` are the two reads. The `access` option below
decides whether a change runs, asks or is denied.

`boxd_image` and `boxd_drop` refuse until a harvest has proven the import on this laptop since the last prompt, and
`boxd_drop` also refuses a machine that is not the one the ledger records for that work id.

`boxd_drop` destroys nothing that the laptop cannot account for. It refuses when:

- the laptop import is missing or older than the last prompt (`NOT_PROVEN`);
- the guest directory is not a git repository (`GIT_UNKNOWN`);
- the tree has untracked or ignored paths that the last harvest did not copy back at the digest the guest still has
  (`UNTRACKED`) — a harvested output counts as recovered, so a task that wrote `SUMMARY.md` can be dropped once it is
  back;
- the tree is dirty and no patch was stored (`DIRTY`).

Tracked changes are stored as a patch (`git diff HEAD`, staged and unstaged) in the work's ledger folder. To finish a
work whose tree has other files, harvest them (`files`), commit or delete them on the machine, then drop; or hibernate,
which keeps the disk.

## Files in and out

A work moves data both ways, and each call records the file's name, size and sha256 in the ledger — never its content.

- **In:** `boxd_submit` copies `files` to the machine before the prompt. Paths are relative to the work tree, and 8 MiB
  a file and 32 MiB a call are the caps.
- **Out:** `boxd_harvest` copies `files` back after the transcript import, into the work's laptop folder or `to`. A copy
  is atomic (a temp file and a rename), a symlink is refused, and a file edited on the laptop since the last harvest is
  never overwritten (`FILE_CONFLICT`).

Laptop paths must be inside the project or a folder named in the `allowedRoots` option, and a symlink is never followed.
When the host asks, allow the path with the `external_directory` rule as well as the path rule:

```jsonc
{ "permissions": [{ "action": "external_directory", "resource": "/srv/work/*", "effect": "allow" }] }
```

See [docs/scripting.md](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/scripting.md) for a worked
`bookmarks.json` → `SUMMARY.md` example.

## Permissions

**Every tool is allowed by default.** The plugin inserts this block into every agent that has a base `* * allow`,
directly after it:

```json
[
  { "action": "boxd_*", "resource": "*", "effect": "allow" },
  { "action": "boxd_status", "resource": "*", "effect": "allow" },
  { "action": "boxd_job", "resource": "*", "effect": "allow" },
  { "action": "boxd_ensure", "resource": "*", "effect": "allow" },
  { "action": "boxd_submit", "resource": "*", "effect": "allow" },
  { "action": "boxd_harvest", "resource": "*", "effect": "allow" },
  { "action": "boxd_sleep", "resource": "*", "effect": "allow" },
  { "action": "boxd_resume", "resource": "*", "effect": "allow" },
  { "action": "boxd_image", "resource": "*", "effect": "allow" },
  { "action": "boxd_drop", "resource": "*", "effect": "allow" }
]
```

That includes the machine changes: `boxd_ensure` creates a billing machine, `boxd_submit` starts a model run on it, and
`boxd_drop` destroys it. The safety mechanics stay: a machine that idles hibernates, `boxd_sleep` always works, drop's
own guard refuses anything the laptop cannot account for, and every create is recorded in the ledger before it runs.

To restrict, choose one of three:

1. **`access`**, one option for the plugin: `"all"` (the default), `"ask-changes"` (reads run, every machine change
   asks) or `"read-only"` (reads run, every machine change is denied).
2. **An agent's own rules**, such as a read-only agent: `"permissions": [{ "action": "boxd_*", "resource": "*", "effect":
   "deny" }, { "action": "boxd_status", "resource": "*", "effect": "allow" }, { "action": "boxd_job", "resource": "*",
   "effect": "allow" }]`.
3. **A per-tool rule** in your `opencode.json`: `{ "action": "boxd_drop", "resource": "*", "effect": "ask" }`, or
   `"deny"` to turn one tool off. The tool names are `boxd_status`, `boxd_job`, `boxd_ensure`, `boxd_submit`,
   `boxd_harvest`, `boxd_sleep`, `boxd_resume`, `boxd_image` and `boxd_drop`.

The last matching rule wins, so a later rule of yours still decides. Agents without a base allow are left alone, and
`/boxd-status` names any agent that does not carry the block, with the rules to paste.

## Configure

See [docs/configuration.md](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/configuration.md) for the
options, the permission rules and every error code.

## Organisation rollout

The snapshot is the one policy worth setting centrally: every member's machines then boot the same image.

```jsonc
// /etc/opencode/opencode.json on Linux
// /Library/Application Support/opencode/opencode.json on macOS
{
  "plugins": [{
    "package": "github:joe-broadhead/opencode-boxd#v0.0.1",
    "options": { "snapshot": "opencode-golden" }
  }]
}
```

Each member still needs the boxd CLI signed in on their own laptop.

## Troubleshooting

A tool that fails returns `error` (the code), `message` (what happened, such as which step timed out) and `next` (the
one next step).

| Code | What to do |
|---|---|
| `HOST_UNTESTED` | Use OpenCode `>=2.2.3 <2.3.0`, or set `"allowUntestedHost": true` to run anyway. |
| `OPTIONS_INVALID` | Fix the plugin options in `opencode.json`, then restart OpenCode. |
| `STATUS_UNAVAILABLE` | Restart OpenCode, then run `/boxd-status` again. |
| `SKILLS_INVALID` | Reinstall the plugin so its skill file is present, then restart OpenCode. |
| `NAME_INVALID` | Use a short lowercase work id, an absolute guest path with no `..`, and a lowercase snapshot name. |
| `NOT_OURS` | Call `boxd_ensure` for this work id, and act only on the machine the ledger records for it. |
| `MACHINE_GONE` | Call `boxd_resume` to wake it, or to rebuild it from the golden snapshot and the proven transcript. |
| `MACHINE_STARTING` | Call `boxd_status` in a later turn. Do not wait inside a call. |
| `MACHINE_SHARED` | Recreate the machine without `--shared`: sharing deletes the guest's OpenCode sign-in. |
| `MACHINE_ISOLATED` | Recreate the machine without `--isolated`, which drops git and the in-VM boxd CLI. |
| `SESSION_BUSY` | Call `boxd_job` until it reports idle, then harvest. |
| `GUEST_VERSION` | Boot the machine from an image whose OpenCode is the same version as this laptop's. |
| `PATH_REFUSED` | A laptop path is outside the project and the allowed roots, or is a symlink. Name its root in `allowedRoots`, and allow it with the `external_directory` rule. |
| `FILE_TOO_LARGE` | A file is over 8 MiB, or the call is over 32 MiB. |
| `FILE_CONFLICT` | A harvested file changed on the laptop since the last harvest, so it was not overwritten. |
| `GUEST_WORKSPACE` | The machine could not prepare `/home/boxd/work/<work id>`. Boot an image whose `/home/boxd` the `boxd` user can write. |
| `GUEST_RUN_FAILED` | The guest session's last run failed; the transcript is still imported. Read it, then `boxd_submit` again. |
| `RUN_INTERRUPTED` | The guest's OpenCode stopped during a run, so the run never finished. `boxd_resume` says so once, and `boxd_job` reports the run as aborted. Harvest what exists, then `boxd_submit` again. |
| `GUEST_AUTH_FAILED` | The failed run was a credential failure. Fix the guest's sign-in as [the golden image](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/golden-image.md) describes, then `boxd_submit` again. |
| `GUEST_FAILED` | Call `boxd_status`, and recreate the machine with `boxd_resume` if the guest keeps failing. |
| `GUEST_UNRESPONSIVE` | The guest's OpenCode did not answer and the machine is short of memory or overloaded; the message names the largest processes. Tell the user, who can free it; waiting a turn does not. |
| `GUEST_SERVER_DOWN` | The guest's OpenCode did not answer and nothing listens on its port, on a machine that is otherwise well. Call `boxd_job` in a later turn: it starts the server again. |
| `BOXD_FAILED` | Read the boxd CLI's own message, and run `boxd_status` before trying again. |
| `BOXD_MISSING` | Install the laptop's boxd CLI, sign in to it, and restart OpenCode so it is on the `PATH`. The CLI that runs inside a boxd machine is not the one this plugin drives. |
| `TIMEOUT` | Call `boxd_status` in a later turn instead. Do not retry inside the same call. |
| `NOT_PROVEN` | Call `boxd_harvest` before sleeping, imaging or dropping this work. |
| `DIRTY` | Call `boxd_harvest`, which stores the uncommitted diff with the export, before dropping. |
| `EXPORT_INVALID` | Call `boxd_harvest` again from an idle session. Do not invent a transcript. |
| `PARENT_MISSING` | Harvest the whole session tree again, parents first, then move it. |
| `SNAPSHOT_EXISTS` | Pick a new snapshot name: snapshots are immutable. |
| `SNAPSHOT_MISSING` | Create the golden image [docs/golden-image.md](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/golden-image.md) describes, then set the `snapshot` option to its name. |
| `LEDGER_FAILED` | Check that the ledger folder is writable, then restart OpenCode. |
| `RULES_NOT_ADDED` | The default permission rules could not be added, so a machine change may run without asking. Restart OpenCode, then run `/boxd-status`. |
| `UNTRACKED` | Commit or delete the paths the message names on the machine, harvest again, then drop. Or hibernate, which keeps the disk. |
| `GIT_UNKNOWN` | Commit the work in a git repository on the machine, harvest again, then drop. Or hibernate, which keeps the disk. |
| `CREATE_UNCERTAIN` | Run `boxd_status`: if the machine appears there, call `boxd_ensure` to adopt it; if not, ensure again. |

The `/boxd` dialog and `/boxd-status` show the same status: connection, account, access, snapshot, guest, works, tools,
agents without the default rules, the OpenCode version and one next step.

## Known limits

- **The boxd behaviour is measured on one account.** The behaviour the plugin relies on was measured against one boxd CLI
  release.
  [docs/architecture.md](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/architecture.md) records each
  measurement, and [docs/live-check.md](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/live-check.md)
  lists what to check again after a boxd CLI or API change.
- **The laptop's boxd CLI only.** The plugin drives remote machines from a laptop. The boxd CLI that runs inside a boxd
  machine takes `--vm <name>` where the laptop CLI takes the machine as an argument, so it is not supported: every
  tool answers `BOXD_MISSING` on it, and no machine is changed.
- **Idle bounds.** boxd gives a new machine a 4-hour idle bound. The plugin sets 30 minutes when it creates or wakes a
  machine, and that bound is what limits billing when the laptop is gone.
- **A create can land after boxd stops answering.** If `machine new` times out, the machine may still appear. `boxd_ensure`
  adopts it when it does, and reports `CREATE_UNCERTAIN` until then.
- **Two `boxd` commands can run at once.** The plugin does not serialise them. Two reads have been measured together;
  a read and a write have not.
- **The golden image is yours to build.** No stock snapshot is named, and a machine whose OpenCode differs from this
  laptop's is refused with `GUEST_VERSION`.
- **Model keys.** A model provider can refuse a service-account key. The
  [golden image page](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/golden-image.md) says what to use.
- **Sign-in is boxd's.** The plugin runs the boxd CLI you are signed in to, and never runs `boxd auth login` for you.
- **Guest credentials are boxd's too.** A guest reads its model key and any push token from `boxd env` at boot; the
  plugin never reads or renews them. A token that expires, such as a one-hour GitHub App token, stops every guest that
  uses it unless something renews it, and a guest session cannot finish an interactive sign-in by itself.
- Updates are not automatic for a Git install, and `opencode plugin update` and `opencode plugin check` do not work on one: to move to a newer release, remove the old entry and add the new tag.

## Uninstall

```sh
opencode plugin remove github:joe-broadhead/opencode-boxd#v0.0.1
```

The ledger is yours to keep or delete. Machines are boxd's: `boxd machine remove oc-<work id> -y` destroys one.

## Links

- [Configuration, permission rules and errors](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/configuration.md)
- [Architecture](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/architecture.md)
- [Scripting](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/scripting.md)
- [The golden image](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/golden-image.md)
- [Jelly](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/jelly.md)
- [Live check on a real boxd machine](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/live-check.md)
- [Changelog](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/CHANGELOG.md)
- [Licence](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/LICENSE)
