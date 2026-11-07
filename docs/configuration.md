# Configuration

## Options

All options go in the plugin entry in `opencode.json`:

```jsonc
{
  "plugins": [{
    "package": "@joe-broadhead/opencode-boxd",
    "options": { "snapshot": "opencode-claude-final" }
  }]
}
```

| Option | Default | What it does |
|---|---|---|
| `snapshot` | `opencode-claude-final` | The golden snapshot every new machine boots from. A lowercase boxd snapshot name. |
| `allowUntestedHost` | `false` | Run on an OpenCode outside `>=2.2.3 <2.3.0`. Status then says the host is untested. |

An unknown option, a snapshot name boxd would refuse, or a non-boolean `allowUntestedHost` stops the plugin with
`OPTIONS_INVALID`; OpenCode's plugin list shows why.

## Where the ledger lives

`~/.local/share/opencode-boxd/works/<work id>/`

- `work.json` — the machine, the guest directory, the root session id, the proof and the git record.
- `exports/<session id>.json` — the transcript, stored before it is imported here.
- `patch.diff` — the uncommitted diff, when the harvest found one.

The ledger is the laptop's copy. A boxd snapshot is an image and holds no session you can restore from the laptop.

## Permission rules

The plugin inserts its block directly after each agent's base `* * allow`. The last matching rule wins, so a rule of
yours later in the agent, or in the session, still decides.

| Action | Effect |
|---|---|
| `boxd_*` | ask — every tool this plugin adds later, until it is classified |
| `boxd_status`, `boxd_job` | allow |
| `boxd_ensure`, `boxd_submit`, `boxd_harvest`, `boxd_sleep`, `boxd_resume`, `boxd_image`, `boxd_drop` | ask |

An agent without a base allow gets no rules: inserting there would turn a default deny into an ask. `/boxd-status` names
each agent that lacks the block, and prints the block to paste first in that agent's own permissions, followed by your
top-level rules for boxd tools.

Nothing is denied by default. `boxd_drop` asks because its own guard already makes data loss impossible, and a deny
would leave a machine billing with no way to clear it from the session.

## Platform facts

- **`opencode session import` keeps the transcript's id** on 2.2.3, 2.2.4, 2.2.5 and 2.2.6. A second import of the same
  transcript answers `Session already exists` on stderr, exits 0, and prints no id; the plugin treats that as the
  transcript's own id. Tested against each stock release in `test/unit/prover.test.ts`.
- **The prover runs `opencode session import --standalone`**, so the import writes the same store whether or not a
  service is running, and never waits on one.
- **The guest must run the same OpenCode as the laptop.** The plugin reads `opencode --version` on the machine and
  compares it with the host's own version.
- **Status makes no boxd call.** `boxd_status` reads the ledger and one `boxd machine get` per open work; `/boxd-status`,
  the `/boxd` dialog and the status RPC read the ledger and the open works' state.

## Errors

Every plugin error reads `CODE: What happened. Next step: What to do.`, with exactly one next step. Upstream and host
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
| `GUEST_FAILED` | The guest helper failed an action. |
| `BOXD_FAILED` | The boxd CLI refused a command or returned something unusable. |
| `BOXD_MISSING` | The boxd CLI is not on the `PATH`. |
| `TIMEOUT` | A boxd command did not answer in time. |
| `NOT_PROVEN` | No fresh laptop import. Sleep, image and drop refuse. |
| `DIRTY` | The guest tree has uncommitted work and no stored patch. |
| `EXPORT_INVALID` | An export is not in OpenCode's session shape. |
| `PARENT_MISSING` | A child session was imported before its parent. |
| `SNAPSHOT_EXISTS` | Snapshot names are immutable. |
