# Repository rules

This repository builds `@joe-broadhead/opencode-boxd`, an OpenCode plugin that runs a session on a private boxd machine
and keeps the transcript on the laptop. It has no MCP server: its twelve tools are its own. Read
[docs/v1-design.md](docs/v1-design.md) and [docs/architecture.md](docs/architecture.md) before you change code, and
[CONTRIBUTING.md](CONTRIBUTING.md) for the checks and the release steps.

## Rules

- **Public API only.** Use only the public `@opencode/plugin` 2.2.3 API. `opencode.host` in `package.json` and
  `SUPPORTED_HOST` in `src/constants.ts` both say exactly `>=2.2.3 <2.4.0`, never `^2.2.3`. `TESTED_HOSTS` in
  `src/constants.ts` is the one list of tested releases, tested on 2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7, 2.3.0,
  2.3.1 and 2.3.2. Inside the range an untested release still starts.
- **Greenfield.** No legacy, migration code, compatibility shim, dual path or deprecated alias, and nothing dead.
- **One written exception, until v0.2.0: the v0 import.** v0.1.0 imports the v0 ledger once, so the works that ran on
  v0.0.x are not stranded (docs/v1-design.md §6). The exception is narrow and time-limited:
  - `src/import-v0.ts` (package B) is the only code that reads the v0 format or touches a v0 guest. It runs the import
    only until a complete `v1/` ledger exists, and it never changes a v0 file. It only adds the folder
    `works/README-MOVED-TO-v1/` with a `README.md` in it: a folder, because v0.0.6 reads `works/<entry>/work.json` for
    every entry and a stray file there would break it after a rollback.
  - It also holds the two v0 things a running v1 needs: the read of a v0 guest through v0's own `phase` action, and
    `adopt`, a plain `machine exec` that takes a running v0 guest's password over. Both are behind `ImportV0Port` in
    `src/ports.ts`. The guest port and `guest/guest.py` know nothing of v0.
  - The only other v0 traces are the ledger fields `guestHelper`, `importedFrom` and `laptopCopy` in
    `src/ledger/types.ts`, which say a record was imported.
  - v0.2.0 removes the module, `ImportV0Port`, those three fields, and this exception with them. Add nothing to it.
- **No peers, no runtime dependencies, no lifecycle scripts.** `@opencode/plugin`, `@opencode/sdk` and
  `@opencode/client` are devDependencies pinned to exactly `2.2.3`. The host stage installs the other tested SDKs into
  a temp folder.
- **Ship prebuilt, one file per entry.** `scripts/build.mjs` bundles `src/index.ts` and `src/tui.ts` into the
  self-contained `dist/index.js` and `dist/tui.js`: no chunks, no relative imports, and only host-provided modules
  external. The server bundle's whitespace and syntax are minified, never its names; the TUI bundle is not minified,
  because OpenCode rewrites its host imports only in the unminified form, and the build fails if it is. `tsc` only
  typechecks.
- **Two folders per work.** The laptop folder is the project or an allowed root; the guest folder is always
  `/home/boxd/work/<work id>`. A laptop path is never sent to the guest.
- **Files carry three facts.** A moved file is recorded by name, size and sha256, never content. A laptop path must be
  inside the project or `allowedRoots`, must not be a symlink, and must be within 8 MiB a file and 32 MiB a call.
- **The laptop is the source of truth.** Never copy `opencode.db`. Drop refuses until the work is saved (a fresh
  harvest that the guest's own session marks still match), and every machine change acts on the machine id the ledger
  records, never on whatever now holds the name. Sleep always works. Nothing automatic ever drops.
- **Model credentials are never baked into an image.** A golden image is built by the plugin from a recipe, never from
  a work's machine, and a build refuses a base that holds `~/.local/share/opencode/auth.json`
  (`GOLDEN_HAS_CREDENTIAL`): an image reaches every work made from it and everyone in the organisation who can boot it,
  so a key in it could not be scoped or rotated. Works get a model key as a sealed, host-bound `boxd env` secret, a
  separately named secret per provider, or `opencode auth login` on one work's own machine.
- **A transcript moves only between matching versions.** A call that moves a transcript compares the guest's OpenCode
  with the host's own version (`GUEST_VERSION`); reads work across versions. Do not hard-code a release there.
- **Every write asserts.** Every plugin-owned tool or branch that creates, wakes, runs, exports, saves or destroys calls
  `ctx.permission.assert` before it acts. The host asserts nothing for a plugin tool by itself, so a declaration-only
  write would run unasked. `test/unit/tools.test.ts` is the architecture test: a change tool with no assert fails there.
- **Default rules, not hooks.** Permissions come from rules inserted through `ctx.agent.transform` directly after each
  agent's base allow. A stricter agent is never weakened, and an agent without a base allow gets no rules.
- **Allow by default; restrict with `access`.** The generated block allows `boxd_*` and each of the twelve tools for
  `access: "all"` (the default), allows only the read-only tools and asks for every change for `"ask-changes"`, and
  denies the changes for `"read-only"`. `/boxd-cleanup`'s own action, `boxd_cleanup`, asks at every level. A user's
  later rule wins. The guards that do not depend on a prompt stay: the idle bounds set at creation, `boxd_sleep` always
  working, drop's data guard, and the create-intent ledger.
- **Transforms are cheap, synchronous and never throw.** Record failures for status instead.
- **Errors** read `CODE: What happened. Next step: What to do.`, built through `boxdError` and the one table in
  `src/errors.ts`. Codes have no service prefix; shared failures use the shared names (`HOST_UNTESTED`,
  `OPTIONS_INVALID`, `STATUS_UNAVAILABLE`, `SKILLS_INVALID`). Every code has a README row and a docs row.
- **Status.** `src/status.ts` builds one model for `/boxd-status`, the `/boxd` dialog and the status RPC, with the
  family's shared fields `version`, `host`, `state`, `unguardedAgents` and `nextStep`. Status makes no boxd call beyond a
  machine read, cuts a failure's reason to one line of 160 characters with `src/redact.ts`, and names at most 20 unknown
  tools, plain names only.
- **The tools RPC.** The transport is `@we-the-rebel-alliance/source-contract/tools-rpc`, pinned to a tag and bundled
  into `dist/index.js`; boxd's plugin value is `src/tools-rpc.ts`. Its methods are every tool in `src/tools.ts`, by
  exact name and with its class, then the `boxd.works` source's `events_list` and `probe`, and the rule is resolved
  before dispatch: only an `allow` runs.
- **The source (`boxd.works`).** `src/sources.ts` implements the source contract's `events_list` and `probe` with the
  package's `events` and `cursor` modules, never copies of them. It reads only the published ledger's `events.jsonl`
  through `LedgerPort.eventsSince`: no boxd call, no machine woken, no lock, and no start or retry of the v0 import. An
  event's words are the plugin's own (work id, phase, outcome, code), never a prompt, a transcript or guest text.
  `npm run conformance` runs the package's conformance kit over it and writes `reports/conformance-report.json`, which a
  release attaches; it must be `ok`. The descriptor declares no key that a consumer on an older contract refuses.
- **Stages.** `npm run check` runs `typecheck`, `unit`, `conformance`, `build`, `icons`, `copies`, `host` (every SDK
  in `TESTED_HOSTS`), `pack` (every `OPENCODE_BIN_*`), `forbidden`, `whitelist` and `actionlint`.
- **The `jelly` section** declares every tool, the skill, a one-line `summary` and the icon, with only the keys Jelly
  reads. `test/unit/jelly.test.ts` keeps it in step with the tool table and the default rules.
- **The icon** is boxd's own mark, https://boxd.sh/favicon.svg with only `width` and `height` dropped, centred on a
  rounded holding tile in boxd.sh's own page colour (`--color-page`, #0a0c12) so it stays visible on light backgrounds,
  and the PNGs rendered from it. `opencode.vendor.mark` is `true`, so the README carries the trademark line. Do not recolour,
  redraw or combine it.
- **Tests.** Unit tests use narrow fakes. Host tests use the public `@opencode/sdk` with a fake boxd CLI and a fake
  guest, in an isolated temp root. Never run the real boxd CLI, create a machine, or read the owner's credentials from a
  check.
- **Text.** Model-facing text and docs use plain language and describe what the code does now: no process narrative,
  test counts, machine-local paths, secrets or personal data.
- **Releases** come only from `.github/workflows/release.yml` ("Releasing" in [CONTRIBUTING.md](CONTRIBUTING.md)). A
  release-prep PR sets `version` in `package.json` and the install specs and runs `node scripts/changelog.mjs release`;
  once it is on `master` and CI passed, start the release with
  `gh workflow run release.yml --ref master -f sha=<its full sha>`. The workflow builds `dist/`, makes the release
  commit on a temporary `release/v<version>` branch, checks and stages everything, and waits for the owner to approve
  the `release` environment; only then does it create the tag `v<version>` and the GitHub Release. Never push a tag or a
  `release/*` branch, and never commit, tag or publish a release by hand. Agents never approve a release, never call the
  deployment-approval API, and never bypass a ruleset or the environment.
- **No personal email in anything we publish.** Every commit is authored and committed as
  `joe-broadhead <91376460+joe-broadhead@users.noreply.github.com>`, except the release commit and tag, which the
  release workflow makes as `github-actions[bot]`. Before committing or tagging, check that
  `git config user.email` is that address: a fresh clone inherits the machine's global identity, which is not that
  address. Never commit, tag or publish with a work or personal address, or with a local hostname.

## Forbidden in this repository

`scripts/check-forbidden.mjs` enforces this list in `src/`, `test/`, `scripts/` and `dist/`: fork-only markers, tool
`options.mcp` delegation, `Plugin.image`, imported OAuth grants, the V1 plugin API (`@opencode-ai/*` and hooks such as
`tool.execute.before`), `ctx.generate.text`, `experimental.policies`, an import of `@opencode/ai`, a permission hook
except the one `permission.hook("evaluate")` the bundled tools RPC module needs, private host source, machine-local home and temp
paths, and `.tsx` or `.jsx` in `dist/`. The pack test also rejects anything in `dist/` other than the two bundles, and
any relative import in them.

## Check

```sh
npm run check
```
