# Security

## Supported versions

Only 0.1.0, on OpenCode 2.2.6.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue. Never include tokens.

## Data handling

The plugin does not phone home. It shells out to the local `boxd` CLI, which uses your existing boxd login. Session exports are written under `~/.local/share/opencode-boxd/`. Those files can contain prompts and tool output. They are not sanitized, because a restart needs them. Do not commit the ledger.

The plugin never passes `--shared` or `--isolated`, and it does not publish the guest OpenCode port. Prompts are sent as JSON on stdin to a helper, not interpolated into a shell command.
