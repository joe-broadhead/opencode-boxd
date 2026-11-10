# Contributing

## Setup

Requires Node 24 and [Bun](https://bun.sh) 1.4.4, which runs the tests.

```sh
npm ci
npm run check
```

`npm run check` runs every stage in order and stops at the first failure; `node scripts/check.mjs <stage>` runs one.
Stages: `typecheck`, `unit`, `build`, `icons`, `copies`, `host`, `pack`, `forbidden`, `whitelist`, `actionlint`.

- `unit` runs against narrow fakes, and imports the real stock OpenCode binaries where they are installed
  (`test/unit/prover.test.ts`).
- `host` runs the built plugin on an embedded OpenCode host from `@opencode/sdk`, on each release in `TESTED_HOSTS`.
- `pack` installs the tarball it just built and loads both entries.
- `whitelist` checks `package.json` and `dist/` against the approved shape.

Stock binaries: set `OPENCODE_BIN_2_2_3` … `OPENCODE_BIN_2_2_6` to a stock `opencode` binary, or install
`@opencode/cli-<platform>-<arch>` for the release into a folder of its own. A stage that needs one skips when it is
absent. CI installs all four, so the import-id evidence runs on every push.

Before a release, work through [docs/live-check.md](docs/live-check.md) on one real machine.

## Install from a checkout

Only for development. Install the package into an OpenCode project from the folder, not from the registry:

```jsonc
{ "plugins": ["./opencode-boxd"] }
```

A published install is `opencode plugin add github:joe-broadhead/opencode-boxd#v0.0.0`.

## Rules

Read [AGENTS.md](AGENTS.md). The short version: every machine change asserts its own permission, the guest must match
the laptop's OpenCode, the laptop ledger is the source of truth, and no check runs a real boxd machine.

## Releasing

Every plugin releases as `v0.0.0`, and it installs from that GitHub tag. The release is one commit on top of a `master`
head that CI passed, and the tag points at it.

1. Set `version` to `0.0.0` in `package.json`, date the `## [0.0.0]` entry in `CHANGELOG.md`, then run `npm run check`.
2. Push that commit to `master`, and wait for CI to pass on it.
3. In a clean checkout of `master` at that commit, run `node scripts/release-commit.mjs --ci-sha <its full sha>`. It builds
   `dist/`, removes the lifecycle scripts, and creates the signed commit and the signed annotated tag `v0.0.0`. It never
   pushes; `--dry-run` shows the change first.
4. Push the tag only: `git push origin v0.0.0`.
5. Approve the run in the `release` environment. The release workflow checks the tag and its commit, installs the tag on
   each stock OpenCode host (2.2.3 to 2.2.6), packs it, and creates the GitHub Release with the notes, the tarball and
   `SHA256SUMS`.

A tag that already exists stops step 3. Delete the old tag and its Release first, then start again.

A Git install is removed and updated by its installed spec: `opencode plugin remove github:joe-broadhead/opencode-boxd#v0.0.0`. `opencode plugin update` and `opencode plugin check` take the same spec.
