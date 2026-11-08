# Security

## Supported versions

The latest published minor version of `@joe-broadhead/opencode-boxd` is supported.

## Reporting a vulnerability

Report a vulnerability through GitHub's private vulnerability reporting on
[joe-broadhead/opencode-boxd](https://github.com/joe-broadhead/opencode-boxd/security/advisories/new). Do not open a
public issue for a security problem.

## Data handling

- The plugin runs your own `boxd` CLI and stores no credential of yours: it never reads your boxd account, a token or a
  signed URL.
- On the machine, the guest helper generates a random password for that machine's own OpenCode server, keeps it at
  `/tmp/opencode-boxd/password` (mode 0600) on that machine only, and sends it nowhere else: only to the server's fixed
  loopback address. The laptop stores none of it.
- The ledger at `~/.local/share/opencode-boxd/` holds the session exports, a stored diff, the captured untracked files
  and the git record. It is the laptop's copy of the session. Its folders are mode 0700 and its files 0600, because an
  export is a full transcript.
- The guest OpenCode binds to `127.0.0.1` inside the machine. Nothing publishes that port.
- Status and errors carry no token, code, signed URL or user content; `src/redact.ts` cuts a failure's reason to one line
  of at most 160 characters.

## Permissions

The plugin inserts default rules after each agent's base allow: the two reads run, and every machine change asks. A read
never wakes a machine: waking starts billing, so only an asking call does it. Nothing is denied by default.

`boxd_drop` destroys only what the laptop can account for: a proven import, a git repository, and no untracked or
ignored path. Everything else is refused, and hibernate keeps the disk. A plugin tool asserts its own permission inside
`execute`, because the host does not assert one for a plugin tool by itself.

## Scripts

A script calls the same tools through the `boxd.machines.tools` RPC, with no model. The tools RPC resolves the rule
before dispatch, from a prior explicit allow only: an `ask` is refused with no prompt and no call, a `deny` is refused,
and a saved "Always allow" does not authorize an ad-hoc script. A script's grant is a rule in config. Its reach is one
method at a time; a script cannot widen a rule, and it cannot reach the host's shell, file or network tools.

