# Security

Report a vulnerability privately through GitHub's security advisory form on this repository, or by email to the
maintainer listed in `CODEOWNERS`. Do not open a public issue for a vulnerability.

Include what you found, the version, and the smallest reproduction. The plugin holds no credential: it runs your
signed-in `boxd` CLI and reads the ledger under `~/.local/share/opencode-boxd`. A report that a guest can reach this
machine's files, that a secret reaches status or a log, or that `drop` can destroy unsaved work is a security report.

Supported versions: the latest `0.0.x` release.
