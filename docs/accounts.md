# Accounts

<!-- generated:accounts -->
Accounts are held by the **local** mechanism: the machine's own identity.

The profile has no fields.
<!-- /generated:accounts -->

## The one account

`accounts.via` is `local`: OpenCode owns no credential for this plugin, and there is nothing to sign in. The one account
is `default`, and its owner is this machine's identity, `os-user:<user>@<host>`. `probe` answers it, and every events
page names `default` as its account; the works snapshot is this machine's list.

A method declares `accounts: "none"`, because there is no alias to pick. `options.accounts` accepts only `default` with
an empty profile; any other alias is `OPTIONS_INVALID`.

The boxd CLI's own sign-in is separate: the plugin runs your `boxd` on your `PATH`, and `/boxd` says whether the CLI
answered its machine listing. `NEEDS_SIGN_IN` means that CLI needs `boxd auth login`.
