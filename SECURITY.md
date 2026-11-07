# Security

## Supported versions

The latest published minor version of `@joe-broadhead/opencode-boxd` is supported.

## Reporting a vulnerability

Report a vulnerability through GitHub's private vulnerability reporting on
[joe-broadhead/opencode-boxd](https://github.com/joe-broadhead/opencode-boxd/security/advisories/new). Do not open a
public issue for a security problem.

## Data handling

- The plugin runs your own `boxd` CLI. It stores no credential, token or password of its own, and reads none.
- The ledger at `~/.local/share/opencode-boxd/` holds the session exports, a stored diff and the git record. It is the
  laptop's copy of the session.
- The guest OpenCode binds to `127.0.0.1` inside the machine. Nothing publishes that port.
- Status and errors carry no token, code, signed URL or user content; `src/redact.ts` cuts a failure's reason to one line
  of at most 160 characters.

## Permissions

The plugin inserts default rules after each agent's base allow: the two reads run, and every machine change asks. Nothing
is denied by default. A plugin tool asserts its own permission inside `execute`, because the host does not assert one for
a plugin tool by itself. A script's write runs only when the session's agent, or the session, allows it.
