# Security

## What leaves this machine

- The boxd CLI talks to boxd; the plugin never contacts boxd itself.
- A work's prompt, its listed files and its git identity go to the guest when you call `submit` or `ensure`.
- A guest's session export, its named files and its git patch and untracked files come back on `harvest`, into the
  ledger and this machine's OpenCode.
- `exec` runs exactly the argv you pass on the guest and returns the last 32 KiB of stdout and 8 KiB of stderr.

Nothing else is sent: no transcript is uploaded on a read, no file is copied in unless you name it, and status never
reads a guest.

## Credentials

- The plugin holds no credential. The boxd CLI's sign-in is its own; the model key is a sealed, host-bound `boxd env`
  secret or a guest's own `opencode auth login`.
- A work's OpenCode, and every command it runs, starts from an allowlist: the machine's basics (`PATH`, `HOME`, the
  locale, proxy and certificate settings) and the variable names the work declares in `ensure` as `env`. The operator's
  other variables, such as `GH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`, never reach the session. The ledger records the
  names, never the values. `ensure` restarts a server that runs with other variables once its session is idle, and
  answers `SESSION_BUSY` while it runs.
- A secret that is not host-bound is a real value on the guest, and `exec` can print it.
- Model credentials are never baked into a golden image; a base that holds `auth.json` is refused.
- Status and logs never carry a token, a URL query string or a credential: a failure reason is redacted and cut to 160
  characters. A fixture is recorded through the kit's redaction.

## Redaction

The guest's words (`lastText`, `tail`, a file's text) are cut, redacted and marked untrusted data. The plugin's own
sentences never echo a provider's text into status. An event's title and labels are the plugin's own words; a title that
looks like a secret is refused for good.

## No plan/commit flow

Every method is one call. `drop` is the only destructive method, and its whole guard runs before it destroys anything; a
separate preview would let a plan outlive the state it was made against. The host's `access` ask is the confirmation.

## The drop guard

`drop` destroys a machine. It refuses unless:

- the work is saved by a fresh harvest the guest's own sessions still match;
- the guest folder's git tree is known;
- every untracked or ignored path was harvested, by name and digest;
- every commit on a local branch, tag, stash or detached HEAD is on a remote ref. A guest that cannot tell is refused
  too, and the next step is to push.

The plugin never drops anything by itself.
