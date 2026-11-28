# Security

## What leaves this machine

- The boxd CLI talks to boxd; the plugin never contacts boxd itself.
- A work's prompt, its listed files and its git identity go to the guest when you call `submit` or `ensure`.
- A guest's session export, its named files and its git patch and untracked files come back on `harvest`, into the
  ledger and this machine's OpenCode.
- The automation copies the ledger's records, exports, patches, untracked files and `ledger-id` to its registry
  machine in the organisation, by digest.
- `exec` runs exactly the argv you pass on the guest and returns the last 32 KiB of stdout and 8 KiB of stderr.

Nothing else is sent: no transcript is uploaded on a read, no file is copied in unless you name it, and status never
reads a guest.

## The registry machine

The registry machine holds the ledger's durable copy: every record, export, patch and untracked file, so the same
transcripts and work data as the operator's machine. It is private to the operator: the plugin never shares it, and no
other member of the organisation can reach it. Its scheduled disk backups hold the same data.

## Credentials

- The plugin holds no credential. The boxd CLI's sign-in is its own; the model key is a sealed, host-bound `boxd env`
  secret or a guest's own `opencode auth login`.
- A work's OpenCode server starts from an allowlist: the machine's basics (`PATH`, `HOME`, the locale, proxy and
  certificate settings) and the variable names the work declares in `ensure` as `env`. The operator's other variables,
  such as `GH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`, are not in the server's environment, so the commands it starts
  directly do not inherit them. This does not stop a session from reading them: boxd's variables file
  (`/etc/profile.d/boxd-env.sh`) is readable by the guest user, a login shell (`bash -l`) sources it, and the guest
  user has passwordless sudo. Until a work's session runs as a user without these, treat every variable the machine
  holds as readable by the session. The ledger records the names, never the values. `ensure` restarts a server that
  runs with other variables once its session is idle, and answers `SESSION_BUSY` while it runs.
- A `workSecrets` value is minted by the command you name and copied straight to the helper's folder on the work's
  machine, then added to the server's environment under its name. This laptop keeps only the name: the value is not in
  the ledger, an event, a log line, a tool's output or any argv. It is a real value on the guest, so `exec` can print
  it, and at drop the configured `revoke` command runs with the work id.
- A secret that is not host-bound is a real value on the guest, and `exec` can print it.
- Model credentials are never baked into a golden image; a base that holds `auth.json` is refused.
- A work acts only with the identity it was given, never its operator's. `ensure` and `submit` refuse a work with
  `ACTS_AS_OPERATOR` when its machine holds a real token or key instead of a placeholder bound to one host (GitHub,
  model or cloud), in the helper's environment or in boxd's variables file `/etc/profile.d/boxd-env.sh`, a stored `gh`, git, AWS or gcloud login with a real value or in a form the check cannot read as a
  placeholder (the check fails closed, line by line for `.git-credentials`), or a git login for github.com with a real value, as boxd's git integration
  gives on a private machine. A placeholder is the identity the work was given, so
  `GH_TOKEN` as a `bxds_` placeholder with gh's credential helper passes. The refusal names what it found, never a
  value. `ensure` with `wait: "none"` does not set the machine up, so it does not check; the next `ensure` or `submit`
  does. To clear it, give the work a sealed secret with `boxd env set <KEY> <value> --secret --domains <hosts>`, run
  `boxd manage integrations disconnect git`, and unset any real token or key on the machine.
- Status and logs never carry a token, a URL query string or a credential: a failure reason is redacted and cut to 160
  characters. A fixture is recorded through the kit's redaction.

## Redaction

The guest's words (`lastText`, `tail`, a done report's `summary`, a file's text) are cut, redacted and marked untrusted
data. The plugin's own sentences never echo a provider's text into status. An event's title and labels are the plugin's
own words; a title that looks like a secret is refused for good.

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
