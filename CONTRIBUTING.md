# Contributing

## Setup

Requires Node 24 and [Bun](https://bun.sh) 1.4.4, which runs the tests.

```sh
npm ci
npm run check
```

`npm run check` runs every stage in order and stops at the first failure; `node scripts/check.mjs <stage>` runs one.
Stages: `typecheck`, `unit`, `build`, `icons`, `copies`, `host`, `pack`, `forbidden`, `whitelist`.

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

A published install is `opencode plugin add @joe-broadhead/opencode-boxd`.

## Rules

Read [AGENTS.md](AGENTS.md). The short version: every machine change asserts its own permission, the guest must match
the laptop's OpenCode, the laptop ledger is the source of truth, and no check runs a real boxd machine.

## Release

The version lives in `package.json` and nowhere else. A release is a `v<version>` tag on `master`; the workflow refuses
a private package or a tag that differs from the version, runs `npm run check`, packs, tests that exact tarball, and
publishes with provenance through npm trusted publishing. The `release` environment holds the human approval.

Before tagging:

1. Move the CHANGELOG's Unreleased section to the version.
2. Remove `"private": true` from `package.json`.
3. Confirm `npm run check` passes in that state.
