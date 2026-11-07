# Repository rules

This repository builds `@joe-broadhead/opencode-boxd`, an OpenCode plugin that runs a session on a private boxd machine
and keeps the transcript on the laptop. It has no MCP server: its nine tools are its own. Read
[docs/architecture.md](docs/architecture.md) before you change code, and [CONTRIBUTING.md](CONTRIBUTING.md) for the
checks and the release steps.

## Rules

- **Public API only.** Use only the public `@opencode/plugin` 2.2.3 API. `opencode.host` in `package.json` and
  `SUPPORTED_HOST` in `src/constants.ts` both say exactly `>=2.2.3 <2.3.0`, never `^2.2.3`. `TESTED_HOSTS` in
  `src/constants.ts` is the one list of tested releases (2.2.3, 2.2.4, 2.2.5, 2.2.6). Inside the range an untested
  release still starts.
- **Greenfield.** No legacy, migration code, compatibility shim, dual path or deprecated alias, and nothing dead.
- **No peers, no runtime dependencies, no lifecycle scripts.** `@opencode/plugin`, `@opencode/sdk` and
  `@opencode/client` are devDependencies pinned to exactly `2.2.3`. The host stage installs the other tested SDKs into
  a temp folder.
- **Ship prebuilt, one file per entry.** `scripts/build.mjs` bundles `src/index.ts` and `src/tui.ts` into the
  self-contained `dist/index.js` and `dist/tui.js`: no chunks, no relative imports, and only host-provided modules
  external. `tsc` only typechecks.
- **The laptop is the source of truth.** A snapshot is an image. Never copy `opencode.db`. Sleep, image and drop refuse
  until a harvest has proven the laptop import since the last prompt, and drop refuses a machine the ledger does not
  record for that work id.
- **The guest must match the laptop.** `checkGuest` compares `opencode --version` on the machine with the host's own
  version. Do not hard-code a release there.
- **Every write asserts.** Every plugin-owned tool or branch that creates, wakes, runs, exports, saves or destroys calls
  `ctx.permission.assert` before it acts. The host asserts nothing for a plugin tool by itself, so a declaration-only
  write would run unasked. `test/unit/tools.test.ts` is the architecture test: a change tool with no assert fails there.
- **Default rules, not hooks.** Permissions come from rules inserted through `ctx.agent.transform` directly after each
  agent's base allow. A stricter agent is never weakened, and an agent without a base allow gets no rules.
- **Transforms are cheap, synchronous and never throw.** Record failures for status instead.
- **Errors** read `CODE: What happened. Next step: What to do.`, built through `boxdError` and the one table in
  `src/errors.ts`. Codes have no service prefix; shared failures use the shared names (`HOST_UNTESTED`,
  `OPTIONS_INVALID`, `STATUS_UNAVAILABLE`, `SKILLS_INVALID`). Every code has a README row and a docs row.
- **Status.** `src/status.ts` builds one model for `/boxd-status`, the `/boxd` dialog and the status RPC, with the
  family's shared fields `version`, `host`, `state`, `unguardedAgents` and `nextStep`. Status makes no boxd call beyond a
  machine read, cuts a failure's reason to one line of 160 characters with `src/redact.ts`, and names at most 20 unknown
  tools, plain names only.
- **The tools RPC.** `src/host/tools-rpc.ts` is a copy of a module shared by several plugins. Change only its block
  between the `PLUGIN-SPECIFIC` markers; change the rest in the shared copy first, and `npm run check` fails on drift.
  Its methods are every tool in `src/tools.ts`, by exact name and with its class.
- **The `jelly` section** declares every tool, the skill, a one-line `summary` and the icon, with only the keys Jelly
  reads. `test/unit/jelly.test.ts` keeps it in step with the tool table and the default rules.
- **The icon** is this family's own mark from the family icon kit, not boxd's logo or colour. `opencode.vendor` names
  boxd's domain so a display app may fetch boxd's own logo from boxd; the package carries no vendor mark.
- **Tests.** Unit tests use narrow fakes. Host tests use the public `@opencode/sdk` with a fake boxd CLI and a fake
  guest, in an isolated temp root. Never run the real boxd CLI, create a machine, or read the owner's credentials from a
  check.
- **Text.** Model-facing text and docs use plain language and describe what the code does now: no process narrative,
  test counts, machine-local paths, secrets or personal data.

## Forbidden in this repository

`scripts/check-forbidden.mjs` enforces this list in `src/`, `test/`, `scripts/` and `dist/`: fork-only markers, tool
`options.mcp` delegation, `Plugin.image`, imported OAuth grants, the V1 plugin API (`@opencode-ai/*` and hooks such as
`tool.execute.before`), `ctx.generate.text`, `experimental.policies`, an import of `@opencode/ai`, a permission hook
except the one `permission.hook("evaluate")` the tools RPC module needs, private host source, machine-local home and temp
paths, and `.tsx` or `.jsx` in `dist/`. The pack test also rejects anything in `dist/` other than the two bundles, and
any relative import in them.

## Check

```sh
npm run check
```
