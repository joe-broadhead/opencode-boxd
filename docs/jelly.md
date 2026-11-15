# Jelly

Jelly reads the `jelly` section of `package.json` to show this plugin in its marketplace and to decide
what a Jelly may call.

## What it declares

- **`tools`** — all nine, by their permission action, with the effect the default rules give: every one of them `allow`,
  the two reads and the seven machine changes alike. 9 tools are declared (2 read-only): `boxd_status` and `boxd_job`
  are the reads.
- **`skills`** — `boxd`.
- **`signIns`** — empty. The plugin has no sign-in of its own: it runs your `boxd` CLI, which you sign in to with
  `boxd auth login`, and Jelly cannot show that sign-in on the card. `/boxd-status` shows it as its first row, **boxd
  CLI**, with `boxd auth login` as the next step when the CLI does not answer.
- **`icon`** — `assets/icon.svg`, boxd's own mark: boxd.sh's `favicon.svg`, unchanged, on a rounded tile in boxd.sh's page colour #0a0c12 (`opencode.vendor.mark` is `true`).
- **`contributes`** — one setting, `access`, the option of the same name, as a choice of three: **Allowed** (`all`, the
  default), **Ask before changes** (`ask-changes`) and **Read only** (`read-only`), with Jelly's own line for each.
  Jelly draws it as a choice and saves only one of the three; a Jelly that does not know declared choices yet refuses
  the whole declaration. No home feed, widget or work kind.

Every tool the plugin registers is declared: the nine tools are the plugin's own, and `test/unit/jelly.test.ts` fails
when a tool in `src/tools.ts` is missing from `jelly.tools`, so a release cannot add an undeclared one.

## What Jelly does with it

Jelly applies the `access` setting itself, from the declared `readOnly` of each tool: at **Allowed** (the default) all
nine run without a prompt; at **Ask before changes** `boxd_status` and `boxd_job` run and the seven machine changes ask;
at **Read only** the two reads run and the seven changes are denied. A read-only helper is never given one of the seven
changes. The plugin's own guards that do not depend on a prompt hold in Jelly too: `boxd_drop` refuses a machine the
laptop cannot account for, and `boxd_sleep` always works.

Jelly's shared rules for every plugin of the family, word for word:

<!-- family-block:start -->
- At Allowed (`all`), the default, every tool runs without asking, declared or not, whatever its `effect`.
- At Ask before changes (`ask-changes`), a `readOnly` tool runs, and every other tool asks first, including a tool this plugin does not declare.
- At Read only (`read-only`), a `readOnly` tool runs, and every other tool is off, including a tool this plugin does not declare.
- A declared `effect` of `allow` changes nothing: the tool follows the access choice and its `readOnly`.
- A declared `effect` of `ask` makes the tool ask at Ask before changes, even when it is `readOnly`, and changes nothing at Allowed or Read only.
- A declared `effect` of `deny` turns the tool off at Ask before changes and at Read only, and changes nothing at Allowed.
- An action listed in `asks` asks first at Ask before changes and at Read only, and never at Allowed.
- A tool named with one `*`, such as another account's `plaud-*.get_file`, follows the same rules as a tool named in full.
- A choice the person makes for one tool wins over the access choice and the declared `effect`.
- jelly leaves out a key it does not know at the top level of the `jelly` block, and reads the rest.
- jelly refuses the plugin for a key it does not know inside anything it reads, such as a tool, a sign-in or a setting.
- jelly refuses the plugin, with one plain line, when `requires` names a field or a feature it does not read.
<!-- family-block:end -->
