# Jelly

Jelly reads the `jelly` section of `package.json` to show this plugin in its marketplace and to decide
what a Jelly may call.

## What it declares

- **`tools`** — all nine, by their permission action, with the effect the default rules give: every one of them `allow`,
  the two reads and the seven machine changes alike.
- **`skills`** — `boxd`.
- **`signIns`** — empty. The plugin has no sign-in of its own: it runs your `boxd` CLI, which is already signed in.
- **`icon`** — `assets/icon.svg`, this family's own mark, not boxd's logo.
- **`contributes`** — empty: no home feed, widget, work kind or setting.

One rule stays for good: a tool boxd adds later is not asked about in Jelly, a write included. It is not in `jelly.tools` until it is classified in
`src/tools.ts`, and status names it as unknown until then.

## What it does not do

Jelly asks for nothing on your behalf: a declared `allow` changes nothing in Jelly, and each machine change runs under
the plugin's `access` option as it does in your own session. With `"all"` (the default) it runs without a prompt, with
`"ask-changes"` it asks, and with `"read-only"` it is denied.
