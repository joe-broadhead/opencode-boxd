# Configuration

## Options

All options go in the plugin entry in `opencode.json`:

```jsonc
{
  "plugins": [{
    "package": "github:joe-broadhead/opencode-boxd#v0.0.0",
    "options": { "snapshot": "opencode-golden" }
  }]
}
```

| Option | Default | What it does |
|---|---|---|
| `snapshot` | `opencode-golden` | The golden snapshot every new machine boots from. A lowercase boxd snapshot name. Build it as [golden-image.md](golden-image.md) describes. |
| `allowUntestedHost` | `false` | Run on an OpenCode outside `>=2.2.3 <2.3.0`. Status then says the host is untested. |
| `allowedRoots` | `[]` | Absolute laptop folders a work may read and write besides the project. A path outside both is refused. |
| `access` | `"all"` | What the plugin's own tools may do without asking: `"all"` allows everything, `"ask-changes"` allows the reads and asks for every machine change, `"read-only"` allows the reads and denies every change. A later rule of the user's still wins. |

An unknown option, a snapshot name boxd would refuse, or a non-boolean `allowUntestedHost` stops the plugin with
`OPTIONS_INVALID`; OpenCode's plugin list shows why.

Inside `>=2.2.3 <2.3.0` a release that was not tested, such as 2.2.99, still starts: status marks the version `untested`
and the next step is the same as on a tested release. Outside the range the plugin does not start unless
`allowUntestedHost` is `true`.

## Where the ledger lives

`~/.local/share/opencode-boxd/works/<work id>/`

- `work.json` — the machine, the laptop folder and the guest work folder, the root session id, the proof, the git record,
  and the files moved in and out by name, size and sha256.
- `exports/<session id>.json` — the transcript, stored before it is imported here.
- `patch.diff` — the uncommitted diff, when the harvest found one.
- `untracked.json` — the untracked files' contents, base64, when the harvest could read them.

The ledger is the laptop's copy. A boxd snapshot is an image and holds no session you can restore from the laptop.

## Permission rules

The plugin inserts its block directly after each agent's base `* * allow`. The last matching rule wins, so a rule of
yours later in the agent, or in the session, still decides.

The block is generated from `defaultRules(access)`, and it is printed here in full for each value, so it can be copied
into an agent that gets no block of its own.

`access: "all"` (the default):

```json
[
  {"action":"boxd_*","resource":"*","effect":"allow"},
  {"action":"boxd_status","resource":"*","effect":"allow"},
  {"action":"boxd_job","resource":"*","effect":"allow"},
  {"action":"boxd_ensure","resource":"*","effect":"allow"},
  {"action":"boxd_submit","resource":"*","effect":"allow"},
  {"action":"boxd_harvest","resource":"*","effect":"allow"},
  {"action":"boxd_sleep","resource":"*","effect":"allow"},
  {"action":"boxd_resume","resource":"*","effect":"allow"},
  {"action":"boxd_image","resource":"*","effect":"allow"},
  {"action":"boxd_drop","resource":"*","effect":"allow"}
]
```

`access: "ask-changes"`:

```json
[
  {"action":"boxd_*","resource":"*","effect":"ask"},
  {"action":"boxd_status","resource":"*","effect":"allow"},
  {"action":"boxd_job","resource":"*","effect":"allow"},
  {"action":"boxd_ensure","resource":"*","effect":"ask"},
  {"action":"boxd_submit","resource":"*","effect":"ask"},
  {"action":"boxd_harvest","resource":"*","effect":"ask"},
  {"action":"boxd_sleep","resource":"*","effect":"ask"},
  {"action":"boxd_resume","resource":"*","effect":"ask"},
  {"action":"boxd_image","resource":"*","effect":"ask"},
  {"action":"boxd_drop","resource":"*","effect":"ask"}
]
```

`access: "read-only"`:

```json
[
  {"action":"boxd_*","resource":"*","effect":"deny"},
  {"action":"boxd_status","resource":"*","effect":"allow"},
  {"action":"boxd_job","resource":"*","effect":"allow"},
  {"action":"boxd_ensure","resource":"*","effect":"deny"},
  {"action":"boxd_submit","resource":"*","effect":"deny"},
  {"action":"boxd_harvest","resource":"*","effect":"deny"},
  {"action":"boxd_sleep","resource":"*","effect":"deny"},
  {"action":"boxd_resume","resource":"*","effect":"deny"},
  {"action":"boxd_image","resource":"*","effect":"deny"},
  {"action":"boxd_drop","resource":"*","effect":"deny"}
]
```

Every tool this plugin registers is allowed by default, so an agent can create, run and destroy a billing machine
without a prompt. The guards that do not depend on a prompt still hold: a machine that idles hibernates, `boxd_sleep`
always works, drop refuses anything the laptop cannot account for, and the ledger records a create before it runs.

An agent without a base allow gets no rules: inserting there would turn a default deny into an ask. `/boxd-status` names
each agent that lacks the block, and prints the block for the access value in force to paste first in that agent's own
permissions, followed by your top-level rules for boxd tools.

## Platform facts

- **`opencode session import` keeps the transcript's id**, tested on 2.2.3, 2.2.4, 2.2.5 and 2.2.6. A second import of the same
  transcript answers `Session already exists` on stderr, exits 0, and prints no id; the plugin treats that as the
  transcript's own id. Tested against each stock release in `test/unit/prover.test.ts`.
- **The prover runs `opencode session import --standalone`**, so the import writes the same store whether or not a
  service is running, and never waits on one.
- **The guest must run the same OpenCode as the laptop.** The plugin reads `opencode --version` on the machine and
  compares it with the host's own version.
- **The snapshot is checked before a create.** `boxd_status` reads `boxd snapshots list --json` (cached for 30
  seconds) and says whether the image is there. `boxd_ensure` and `boxd_resume` read it again before creating a machine
  and refuse with `SNAPSHOT_MISSING`, so no machine boots from nothing. An unreadable listing is not a refusal: the
  create reports its own error.
- **Status reads, never wakes.** `boxd_status` runs one read-only `machine get` per open work and one `machine list`;
  `/boxd-status`, the `/boxd` dialog and the status RPC read the same. No read wakes a machine, because waking starts
  billing. The plugin never reads your boxd account or credentials.
- **A read never wakes.** `boxd_job` reports `asleep` for a hibernated machine and names `boxd_resume` as the next step.
- **Hibernating destroys nothing.** `boxd_sleep` needs no proof and works when the guest cannot be harvested; it records
  a warning that the last prompt is not on the laptop yet, which status shows. `boxd_image` and `boxd_drop` still need a
  fresh proof.
- **The guest path is the plugin's.** Every work's guest folder is `/home/boxd/work/<work id>`; the laptop folder is
  recorded beside it in the ledger. A laptop path is never sent to the guest, and a guest that cannot prepare its own
  folder fails with `GUEST_WORKSPACE` and the guest's own words.
- **Files carry name, size and digest.** An upload is copied before the prompt; a harvest copies the requested files
  back after the transcript. A file is refused outside the project and `allowedRoots`, over 8 MiB, over 32 MiB a call,
  through a symlink, or over a local edit since the last harvest. A copied-back file is written through a temp file and
  a rename, 0600, and the ledger records name, size and sha256, never content.
- **A run's outcome is part of the result.** OpenCode records it on the session (`outcome`) and on its last idle message,
  with the failure's structured error. `boxd_job` reports it when the guest is idle, `boxd_harvest` records it and adds
  `GUEST_RUN_FAILED` or `GUEST_AUTH_FAILED` as a warning, and status shows each work's last outcome. The error is `<type>: <first line>`, passed
  through redaction; a provider's response body is never read. It comes from the guest or the imported transcript, never
  from a model call.
- **Drop only destroys what the laptop can account for.** It refuses a non-git directory, untracked or ignored paths, and
  a dirty tree with no stored patch. Tracked changes are stored as `git diff HEAD`; untracked contents are stored beside
  it when the guest can read them, which is not the same as a faithful copy, so a drop still refuses.
- **A create is recorded before it runs.** The ledger holds the intent, so a timed-out `machine new` is either adopted
  when the machine appears, or reported as `CREATE_UNCERTAIN`, and `boxd_status` names an `oc-*` machine no work records.
- **Every wake arms the awake bound.** `machine config set auto-hibernate.timeout 1800` and `idle.ignore-outbound off`
  run right after a wake or create; a sleep sets the timeout to 14400.

## Errors

Every plugin error reads `CODE: What happened. Next step: What to do.`, with exactly one next step. A tool's result
for it is `{ "error": "<CODE>", "message": "<what happened>", "next": "<what to do>" }`, so a Code Mode program or a
script reads the same three parts the model does. Upstream and host
errors pass through unchanged. No error, log or status line contains a token, a code or a signed URL.

| Code | What it means |
|---|---|
| `HOST_UNTESTED` | OpenCode is outside `>=2.2.3 <2.3.0` and `allowUntestedHost` is not set. |
| `OPTIONS_INVALID` | The plugin options are not valid. |
| `STATUS_UNAVAILABLE` | The status RPC could not read the status. |
| `SKILLS_INVALID` | The plugin's skill file is missing or malformed. |
| `NAME_INVALID` | A work id, guest path, snapshot name or prompt is not in the form the plugin accepts. |
| `NOT_OURS` | No open work, or the machine is not the one the ledger records for it. |
| `MACHINE_GONE` | The machine no longer exists. `boxd_resume` rebuilds it. |
| `MACHINE_STARTING` | The machine or its OpenCode is not up yet. Nothing waits inside a call. |
| `MACHINE_SHARED` | The machine is shared, which deletes the guest's OpenCode sign-in. |
| `MACHINE_ISOLATED` | The machine is isolated, so it has no git and no in-VM boxd CLI. |
| `SESSION_BUSY` | The guest session is still running; harvest only when it is idle. |
| `GUEST_VERSION` | The machine's OpenCode differs from this laptop's. |
| `GUEST_RUN_FAILED` | The guest session's last run failed. The transcript is still imported and proven; the error is the run's own. |
| `RUN_INTERRUPTED` | The guest's OpenCode stopped during a run, so the run never finished. The transcript is kept. Call `boxd_harvest`, then `boxd_submit` again. |
| `GUEST_AUTH_FAILED` | The guest session's last run failed on a model credential. The transcript is still imported; fix the guest's sign-in. |
| `GUEST_FAILED` | The guest helper failed an action. |
| `GUEST_UNRESPONSIVE` | A guest call timed out, and a probe of the machine found under a tenth of its memory available, or a load over four per CPU. The message gives the free memory, the load and the three largest processes by name and pid. |
| `GUEST_SERVER_DOWN` | A guest call timed out, and a probe found the machine well but nothing listening on the OpenCode port. The next guest call starts the server again. |
| `BOXD_FAILED` | The boxd CLI refused a command or returned something unusable. |
| `BOXD_MISSING` | The boxd CLI is not on the `PATH`. |
| `TIMEOUT` | A boxd command did not answer in time. After a guest call, a probe that found the machine well, server included, adds what it found. |
| `NOT_PROVEN` | No fresh laptop import. Sleep, image and drop refuse. |
| `DIRTY` | The guest tree has uncommitted work and no stored patch. |
| `EXPORT_INVALID` | An export is not in OpenCode's session shape. |
| `PARENT_MISSING` | A child session was imported before its parent. |
| `SNAPSHOT_EXISTS` | Snapshot names are immutable. |
| `SNAPSHOT_MISSING` | The golden snapshot is not in this boxd account, so no machine is created. |
| `LEDGER_FAILED` | A ledger read or write failed: a file system error, not a boxd one. |
| `RULES_NOT_ADDED` | The default permission rules could not be inserted into the agents, so a machine change may run without asking. |
| `UNTRACKED` | The guest tree has untracked or ignored paths, which a stored patch cannot hold. |
| `GIT_UNKNOWN` | The guest directory is not a git repository, so nothing about its files can be proven. |
| `CREATE_UNCERTAIN` | `machine new` timed out and no machine with that name exists yet. |
| `PATH_REFUSED` | A laptop path is outside the project and `allowedRoots`, or is a symlink. Name its root in the option, and allow it with the `external_directory` rule as well as the path rule. |
| `FILE_TOO_LARGE` | A file is over 8 MiB, or one call moves over 32 MiB. |
| `FILE_CONFLICT` | A harvested file was edited on the laptop since the last harvest. |
| `GUEST_WORKSPACE` | The guest could not create or prepare `/home/boxd/work/<work id>`. |
