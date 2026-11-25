# Accounts

The plugin declares no accounts and holds no credential. There is no sign-in input on any method, and no `account`
alias to choose; every method is `accounts: "none"`.

The boxd CLI's own sign-in is separate: the plugin runs your `boxd` on your `PATH`, and `/boxd` says whether the CLI
answered its machine listing. `NEEDS_SIGN_IN` means that CLI needs `boxd auth login`.

`probe` reports the local machine identity, `os-user:<user>@<host>`, and its label. `status` reports the plugin and host
state with an empty account list. There is no `options.accounts` setting.
