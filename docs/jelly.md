# Jelly

Jelly reads the `jelly` section of `package.json` to show this plugin in its marketplace and to decide
what a Jelly may call.

## What it declares

- **`tools`** — all twelve, by their permission action, with the effect the default rules give: every one of them
  `allow`, the three reads and the nine changes alike. 12 tools are declared (3 read-only): `boxd_status`, `boxd_job`
  and `boxd_read` are the reads.
- **`skills`** — `boxd`.
- **`signIns`** — empty. The plugin has no sign-in of its own: it runs your `boxd` CLI, which you sign in to with
  `boxd auth login`, and Jelly cannot show that sign-in on the card. `/boxd-status` shows it as its first row, **boxd
  CLI**, with `boxd auth login` as the next step when the CLI does not answer.
- **`icon`** — `assets/icon.svg`, boxd's own mark: boxd.sh's `favicon.svg`, unchanged, on a rounded tile in boxd.sh's page colour #0a0c12 (`opencode.vendor.mark` is `true`).
- **`cost`** — the line Jelly shows on the plugin's review before it installs, in the plugin's own words, saying what
  it costs with boxd: "boxd bills each plugin machine: compute and memory while running, disk while hibernated, until
  boxd_drop. boxd_golden and boxd_ensure may make a short-lived builder. At access Allowed, finished works are
  harvested and hibernated after 10 idle minutes by default; else only with automation "on"." It changes nothing Jelly
  allows. Jelly keeps the line to 300 characters.
- **`contributes`** — one setting, `access`, the option of the same name, as a choice of three: **Allowed** (`all`, the
  default), **Ask before changes** (`ask-changes`) and **Read only** (`read-only`), with Jelly's own line for each.
  Jelly draws it as a choice and saves only one of the three; a Jelly that does not know declared choices yet refuses
  the whole declaration. No home feed, widget or work kind.

`/boxd-cleanup` confirms each cleanup action with a permission prompt for the person: at **Allowed** through the
command's own action `boxd_cleanup`, which the default rules set to ask at every level; it is a command action, not a
tool, so it is not in `tools`.

Every tool the plugin registers is declared: the twelve tools are the plugin's own, and `test/unit/jelly.test.ts` fails
when a tool in `src/tools.ts` is missing from `jelly.tools`, so a release cannot add an undeclared one.

## What Jelly does with it

Jelly applies the `access` setting itself, from the declared `readOnly` of each tool: at **Allowed** (the default) all
twelve run without a prompt; at **Ask before changes** `boxd_status`, `boxd_job` and `boxd_read` run and the nine
changes ask; at **Read only** the three reads run and the nine changes are denied. A read-only helper is never given one
of the nine changes. The plugin's own guards that do not depend on a prompt hold in Jelly too: `boxd_drop` refuses a machine the
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
