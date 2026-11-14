# Jelly

Jelly reads the `jelly` section of `package.json` to show this plugin in its marketplace and to decide
what a Jelly may call.

## What it declares

- **`tools`** — all nine, by their permission action, with the effect the default rules give: every one of them `allow`,
  the two reads and the seven machine changes alike.
- **`skills`** — `boxd`.
- **`signIns`** — empty. The plugin has no sign-in of its own: it runs your `boxd` CLI, which is already signed in.
- **`icon`** — `assets/icon.svg`, boxd's own mark: boxd.sh's `favicon.svg`, unchanged (`opencode.vendor.mark` is `true`).
- **`contributes`** — one setting, `access`, the option of the same name, as a choice of three: **Allowed** (`all`, the
  default), **Ask before changes** (`ask-changes`) and **Read only** (`read-only`), with Jelly's own line for each.
  Jelly draws it as a choice and saves only one of the three; a Jelly that does not know declared choices yet refuses
  the whole declaration. No home feed, widget or work kind.

One rule stays for good: a tool boxd adds later is not asked about in Jelly, a write included. It is not in `jelly.tools` until it is classified in
`src/tools.ts`, and status names it as unknown until then.

## What it does not do

Jelly asks for nothing on your behalf: a declared `allow` changes nothing in Jelly, and each machine change runs under
the plugin's `access` option as it does in your own session. With `"all"` (the default) it runs without a prompt, with
`"ask-changes"` it asks, and with `"read-only"` it is denied.
