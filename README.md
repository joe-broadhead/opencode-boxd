# boxd for OpenCode

Runs an OpenCode session on a private [boxd](https://boxd.sh) machine and keeps the transcript on your laptop.

Unofficial; not affiliated with boxd.

## Requirements

- OpenCode `>=2.2.3 <2.3.0`, tested on 2.2.3, 2.2.4, 2.2.5 and 2.2.6.
- The [boxd CLI](https://boxd.sh), signed in, on your `PATH`.
- A boxd snapshot with OpenCode installed. The guest OpenCode must be the same version as the OpenCode on your laptop.
- macOS or Linux on the laptop.

## Install

```sh
opencode plugin add @joe-broadhead/opencode-boxd
```

A snapshot is an image, not a session. The machine is a cache with more CPU; your laptop keeps the transcript.

## Sign in

The plugin makes no boxd call of its own. It runs your `boxd` CLI, so sign in to boxd the way you always do:

```sh
boxd auth login
```

Nothing else is stored: the plugin keeps a ledger under `~/.local/share/opencode-boxd/works/`, and the machine holds no
session you cannot get back.

## Use

1. `boxd_ensure` with a short work id. The machine is named `oc-<work id>`, and the work is recorded in the ledger.
2. `boxd_submit` with the task. It returns when the guest has admitted the prompt, not when the model finishes.
3. `boxd_job` in a later turn: busy, idle, or missing.
4. `boxd_harvest` with a directory on this laptop. The session tree is exported, imported here parents first, and git is
   recorded.
5. `boxd_sleep` to hibernate, `boxd_resume` to wake or rebuild, `boxd_image` to save a snapshot, `boxd_drop` to destroy.
6. `boxd_status` reads the ledger and each open work's machine state. It starts nothing.

Every machine change asks before it runs: `ensure`, `submit`, `harvest`, `sleep`, `resume`, `image` and `drop`. The two
reads, `boxd_status` and `boxd_job`, run without asking.

`boxd_sleep`, `boxd_image` and `boxd_drop` refuse until a harvest has proven the import on this laptop since the last
prompt. `boxd_drop` also refuses a machine that is not the one the ledger records for that work id.

## Permissions

The plugin inserts this block into every agent that has a base `* * allow`, directly after it:

```json
[
  { "action": "boxd_*", "resource": "*", "effect": "ask" },
  { "action": "boxd_status", "resource": "*", "effect": "allow" },
  { "action": "boxd_job", "resource": "*", "effect": "allow" },
  { "action": "boxd_ensure", "resource": "*", "effect": "ask" },
  { "action": "boxd_submit", "resource": "*", "effect": "ask" },
  { "action": "boxd_harvest", "resource": "*", "effect": "ask" },
  { "action": "boxd_sleep", "resource": "*", "effect": "ask" },
  { "action": "boxd_resume", "resource": "*", "effect": "ask" },
  { "action": "boxd_image", "resource": "*", "effect": "ask" },
  { "action": "boxd_drop", "resource": "*", "effect": "ask" }
]
```

The last matching rule wins, so a rule of yours later in an agent, or a deny in the session, still decides. Agents
without a base allow are left alone, and `/boxd-status` names any agent that does not carry the block, with the rules
to paste.

`boxd_drop` asks rather than being off. It is irreversible, but its own guard makes data loss impossible: the laptop
import must be fresh, and the tree must be clean or already stored as a patch. A deny would leave a machine billing
with no way to clear it from the session.

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
    "package": "@joe-broadhead/opencode-boxd",
    "options": { "snapshot": "opencode-golden" }
  }]
}
```

Each member still needs the boxd CLI signed in on their own laptop.

## Troubleshooting

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
| `GUEST_FAILED` | Call `boxd_status`, and recreate the machine with `boxd_resume` if the guest keeps failing. |
| `BOXD_FAILED` | Read the boxd CLI's own message, and run `boxd_status` before trying again. |
| `BOXD_MISSING` | Install the boxd CLI, sign in to it, and restart OpenCode so it is on the `PATH`. |
| `TIMEOUT` | Call `boxd_status` in a later turn instead. Do not retry inside the same call. |
| `NOT_PROVEN` | Call `boxd_harvest` before sleeping, imaging or dropping this work. |
| `DIRTY` | Call `boxd_harvest`, which stores the uncommitted diff with the export, before dropping. |
| `EXPORT_INVALID` | Call `boxd_harvest` again from an idle session. Do not invent a transcript. |
| `PARENT_MISSING` | Harvest the whole session tree again, parents first, then move it. |
| `SNAPSHOT_EXISTS` | Pick a new snapshot name: snapshots are immutable. |

The `/boxd` dialog and `/boxd-status` show the same status: connection, account, access, snapshot, guest, works, tools,
agents without the default rules, the OpenCode version and one next step.

## Uninstall

```sh
opencode plugin remove @joe-broadhead/opencode-boxd
```

The ledger is yours to keep or delete. Machines are boxd's: `boxd machine remove oc-<work id> -y` destroys one.

## Links

- [Configuration, permission rules and errors](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/configuration.md)
- [Architecture](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/architecture.md)
- [Scripting](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/scripting.md)
- [Jelly](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/docs/jelly.md)
- [Changelog](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/CHANGELOG.md)
- [Licence](https://github.com/joe-broadhead/opencode-boxd/blob/HEAD/LICENSE)
