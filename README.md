# boxd

Run OpenCode sessions on private [boxd](https://boxd.sh) machines without keeping the session in the VM.

`@joe-broadhead/opencode-boxd`

The laptop is the source of truth. A boxd snapshot is an image, not a transcript.

## Version

This package targets **OpenCode 2.2.6**, and only that release. The plugin refuses to load on any other host unless `allowUntestedHost` is set. A session machine is refused unless `opencode --version` on it is 2.2.6.

The golden snapshot `opencode-claude-final` is still 2.2.5. `boxd_ensure` will return `GUEST_VERSION` until that image is refreshed. Do not start sessions on it.

2.2.6 matters for the control plane: `opencode run` now waits for background jobs with no time limit. This plugin never uses that command. It admits a prompt on the guest HTTP API and returns.

On 2.2.6, import keeps the transcript's session id. A second import of that id is a conflict, which this plugin treats as already proven. Parents still have to exist first.

## What a tool does

| Tool | Returns when | Does not |
|---|---|---|
| `boxd_ensure` | The machine is ready, or `starting` | Wait for boot |
| `boxd_submit` | The prompt is admitted | Wait for the model |
| `boxd_job` | Busy or idle, one check | Poll |
| `boxd_harvest` | The laptop import succeeded | Export a busy session |
| `boxd_sleep` | The machine is hibernated | Sleep without a fresh import |
| `boxd_drop` | The machine is destroyed | Destroy a dirty tree or an unproven session |
| `boxd_resume` | Woke, or imported onto a new machine from the golden snapshot | Boot a snapshot of the old session disk |
| `boxd_image` | A new immutable snapshot exists | Save an image of unharvested work |

Machines are private. `--shared` deletes `~/.local/share/opencode/auth.json`. `--isolated` drops git and the in-VM `boxd`. Neither flag is ever passed.

The guest OpenCode binds to `127.0.0.1`. Nothing publishes that port. While a work id is open the machine may hibernate after 30 minutes of no inbound traffic, so a crashed agent does not bill forever. `boxd_sleep` hibernates immediately.

## Ledger

`~/.local/share/opencode-boxd/works/<id>/`

The export files are the transcript. Git state is recorded beside them. A patch is stored when the tree is dirty. Destroy is refused until the import on this laptop has succeeded since the last prompt.

## Install

OpenCode `>=2.2.6 <2.3.0`.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./opencode-boxd"]
}
```

Until this is on npm, point `plugins` at the checkout.

```sh
npm install
npm test
npm run build
```

## What this is not

It does not copy the VM disk. It does not replicate `opencode.db`. It does not replace oc-factory. It does not refresh the golden snapshot for you.
