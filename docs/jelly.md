# Jelly

Jelly reads the `jelly` section of `package.json` to show this plugin in its marketplace and to decide
what a Jelly may call.

## What it declares

- **`tools`** — all nine, by their permission action, with the effect the default rules give: the two reads `allow`, and
  the seven machine changes `ask`.
- **`skills`** — `boxd`.
- **`signIns`** — empty. The plugin has no sign-in of its own: it runs your `boxd` CLI, which is already signed in.
- **`icon`** — `assets/icon.svg`, this family's own mark, not boxd's logo.
- **`contributes`** — empty: no home feed, widget, work kind or setting.

One rule stays for good: a tool boxd adds later is not asked about in Jelly, a write included. It is not in `jelly.tools` until it is classified in
`src/tools.ts`, and status names it as unknown until then.

## What it does not do

Jelly never asks for a machine change on your behalf without the same permission prompt your own session gets. The
`ask` is the permission prompt, and a decline runs nothing.
