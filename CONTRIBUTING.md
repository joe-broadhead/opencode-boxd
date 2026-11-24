# Contributing

## Setup

Requires Node 24 and [Bun](https://bun.sh) 1.4.4, which runs the tests.

```sh
npm ci
npm run check
```

`npm run check` runs every stage in order and stops at the first failure; `node scripts/check.mjs <stage>` runs one.
Stages: `typecheck`, `unit`, `conformance`, `kit`, `build`, `icons`, `copies`, `host`, `pack`, `forbidden`, `whitelist`,
`actionlint`.

- `unit` runs against narrow fakes, and imports the real stock OpenCode binaries where they are installed
  (`test/unit/prover.test.ts`).
- `host` runs the built plugin on an embedded OpenCode host from `@opencode/sdk`, on each release in `TESTED_HOSTS`.
- `pack` installs the tarball it just built and loads both entries.
- `whitelist` checks `package.json` and `dist/` against the approved shape.

Stock binaries: set `OPENCODE_BIN_2_4_1` to a stock `opencode` binary, or install
`@opencode/cli-<platform>-<arch>` for the release into a folder of its own. A stage that needs one skips when it is
absent. CI installs it, so the import-id evidence runs on every push.

Before a release, work through [docs/live-check.md](docs/live-check.md) on one real machine.

## Install from a checkout

Only for development. Install the package into an OpenCode project from the folder, not from the registry:

```jsonc
{ "plugins": ["./boxd-plugin"] }
```

A published install is a release tag: `opencode plugin add github:we-the-rebel-alliance/boxd-plugin#v<version>`. The first
release on plugin-contract is v0.0.0 (phase 4b).

## Rules

Read [AGENTS.md](AGENTS.md). The short version: every machine change asserts its own permission, the guest must match
this machine's OpenCode, the local ledger is the source of truth, and no check runs a real boxd machine.

## Releasing

Each release is the GitHub tag `v<version>`, where `<version>` is the `version` in `package.json`, and users install from
that tag. The release is one commit on top of a `master` head that CI passed, and the tag points at it. The release
workflow makes both, in GitHub Actions: nobody builds, commits or tags a release on their own machine, and no personal
key signs it.

The next phase prepares the first release, `0.0.0`; until then its notes are under `## 0.0.0 (unreleased)` at the top
of `CHANGELOG.md`. From the first cut, each release is a heading below it, newest first.

1. On `master`, set `version` in `package.json` to the new version, and change every install spec in the README,
   `CONTRIBUTING.md` and `docs/` to `#v<version>` (`test/unit/docs.test.ts` fails until they match). Then run
   `node scripts/changelog.mjs release`: it turns `## [Unreleased]` into `## [<version>] - <today>`, above the earlier
   releases, and refuses a CHANGELOG it cannot shape. Run `npm run check`.
2. Push that commit to `master`, and wait for CI to pass on it. `ci.yml` is one job, `ci`, on one Ubuntu runner (a
   public runner for a fork's pull request); the release stands on the push run.
3. Start the release with that commit's full sha:
   `gh workflow run release.yml --ref master -f sha=<full sha>`, or from Actions → release →
   Run workflow, on `master`.
4. Read the run's summary, then approve the `release` environment. The summary is on the run page, under the `stage`
   job: the tag, the parent and its CI run, the release commit and its tree, the sha256 of `SHA256SUMS` and the staged
   artifact's id, `SHA256SUMS` itself, and the notes. Open the release commit on `release/v<version>` and read them
   before approving: the approval releases exactly those bytes. Only the owner approves a release. Agents never approve
   one, never call the deployment-approval API, and never bypass a ruleset or the environment; the kit's scripts make
   only their own GitHub calls and refuse every other.
5. Check the published Release: not a draft, its notes, and every asset against `SHA256SUMS`.

`package.json` stays `"private": true`, so npm can never publish the plugin by accident; a GitHub install does not read
it, and `npm pack` still packs the release tarball. It is kept in its canonical form, `JSON.stringify(pkg, null, 2)` and
one newline: the kit tests check both in `npm run check`, as the release planner does.

The declaration is checked against what the provider serves. `npm run capture` (`scripts/capture-tools.mjs`, run by hand
through the signed-in OpenCode, never by CI) writes `test/fixtures/live-tools.json` and `test/fixtures/provenance.json`,
with the signed-in account's own values that some servers write into descriptions (Slack's "Your user_id: …") replaced
by placeholders such as `U00CURRENTUSER`; the drift check fails a committed capture that still holds one.
`scripts/check-drift.mjs` checks the legacy declaration's tools, `test/fixtures/tool-registry.json`, the skills and the docs against them,
offline, in the kit tests of `npm run check`. The release build runs it with `--release`, which also refuses a capture
more than 14 days old, unless `provenance.json` holds the owner's written waiver for exactly that capture:
`"waiver": { "listedAt": "<the capture's date>", "reason": "…", "approvedBy": "…" }` (a new capture drops it). A plugin
with no capture yet, or only a names-only one, releases with a warning on the run; one that serves only its own tools
says so with `"upstream": "none"` in the registry.

A plugin that declares sources (a top-level `sources` key in `package.json`, the source contract's declaration) releases
with its conformance report. Its `npm run conformance` runs the source contract's conformance kit and writes
`reports/conformance-report.json` (keep `reports/` out of git); `npm run check` runs it too. The release runs it again on
the parent in its own `conformance` job, which has no write token, and stops unless the run passes and the report's `ok`
is `true` for this version. The report becomes the Release asset `conformance-report.json`, listed in `SHA256SUMS`. A
plugin without `sources` has no report, and its release is unchanged.

Before the approval, the workflow:
- **plans:** refuses a run that is not on `master`, a sha that is not `master`'s head, a sha without a successful
  `ci.yml` push run with a successful `ci` job, a version that is not `x.y.z`, a
  `package.json` that is not `"private": true` or not in its canonical form, a CHANGELOG whose newest release is not
  this version, a plugin that declares sources with no `conformance` script, a release that does not move forward from
  the last published Release, a leftover `release/v<version>` branch, a native run that did not build this sha on
  `master`, by hand, with success, and a missing `native_run` (or one given to a plugin that is not native);
- **builds**: refuses a failing tool drift check (`scripts/check-drift.mjs --release`, above), then builds `dist/` with
  `npm ci --ignore-scripts` and `npm run build`, with a read-only token, and writes the release files: `dist/`,
  `package.json` without its lifecycle scripts, and the vetted native manifest;
- **commits** them on a temporary branch `release/v<version>` at the parent, through GitHub's API with the workflow's token,
  so GitHub signs the commit (author `github-actions[bot]`, committer GitHub). This job runs no npm. It refuses a commit
  that GitHub does not verify, or whose parent or tree is not the one the files give;
- **verifies** on a fresh runner: the commit's identity, one parent on `master`, `package.json` exactly the parent's
  without the lifecycle scripts, only regular files in the allowed paths, no `package.json` under `dist/`, and a second,
  independent build of the parent (its own job) equal to the committed `dist/` byte for byte;
- **installs** the release commit with `plugin add` on each stock OpenCode host (2.4.1);
- **packs** the commit before installing anything, keeps that tarball and records its sha256, then runs the pack stage
  against a copy;
- **runs the conformance kit** on the parent, for a plugin that declares sources (above), and uploads only its report;
- **stages** the Release: verifies the attested native files, takes the conformance report of a plugin that declares
  sources from its job's artifact (exactly that one file, at most 256 KiB, nothing else), checks after every download
  that the staged tarball is the one the pack job kept (its sha256), writes `SHA256SUMS` and the notes (the version's CHANGELOG section), and shows them all in the run summary
  with the sha256 of `SHA256SUMS`.

A job either runs repository or dependency code (`npm ci`, the build, the pack stage, a host install) and has no write
token, or uses the API and runs only the kit's scripts on a fresh checkout, after checking that the release commit's
`scripts/` and `.github/` are the parent's. The first kind is not token-free: `actions/checkout` fetches with the job's
read-only (`contents: read`) token, and its post step and the artifact uploads run after repository code on the same
runner, so that code could reach a read-only token for this public repository and the runner's artifact token. Jobs
pass files as artifacts downloaded by the id the uploading job gave, and each is checked again on arrival.

After the approval, it downloads the staged artifact by the id the summary names, and refuses unless `SHA256SUMS` has
the sha256 the summary shows and every staged file matches it, the tarball is the one the pack job kept (its sha256),
every native file is the one the release commit's `manifest/native.json` pins, size and sha256, with each gzip holding
the pinned executable, and the conformance report is ok for this version. Then it checks everything again, creates the annotated tag
`v<version>` on the release commit (tagger `github-actions[bot]`, unsigned), checks the tag, creates the Release with the
notes, the tarball, the native files and `SHA256SUMS`, and deletes `release/v<version>`. The tag keeps the commit.

GitHub's signature and the bot identity show only that GitHub made the commit through its API for the workflow; anyone
with write access can make such a commit. What ties the release to `master` is its content: one parent CI passed, the
exact `package.json`, the allowed paths and the byte-for-byte rebuild. Never relax those because the commit is signed.

**A rejected, expired or failed run** leaves nothing behind: the `cleanup` job deletes `release/v<version>` when it points
at the parent or at that run's commit, and never touches another branch. No tag exists before the approval, so the
version is not burned: fix `master` and start again. If `cleanup` itself failed, the next run refuses until the branch
is deleted: `gh api -X DELETE repos/we-the-rebel-alliance/boxd-plugin/git/refs/heads/release/v<version>`.

**Resume.** If the run fails after creating the tag and before the Release is complete, start it again with the same `sha`. The plan finds the kit's tag on a release commit on that sha with no published Release, and resumes:
it makes no new commit, checks and installs the tagged commit, stages the files, and after a new approval reuses the tag
and adds what the Release lacks. Delete a draft Release a failed upload left first: the publish step refuses a draft.
Any other existing tag is refused: release the next version.

The repository's tag ruleset keeps a `v*` tag from being moved or deleted. A stray `v*` tag, one that never became a
Release, does not block later releases: only published Releases count, and drafts do not. Its version cannot be
released, so release the next one. To remove the tag anyway, an admin disables the `release tags` ruleset, deletes the
tag, and restores the ruleset exactly as it was.

**Known limit: a `v*` tag pushed by hand.** No ruleset limits who creates a `v*` tag, so anyone with write access can
push one by hand, pointing at any commit. Such a tag has no published Release, the forward-only check ignores it, and
An app installs only a published Release whose `SHA256SUMS` it verifies. But a user who installs
`github:we-the-rebel-alliance/boxd-plugin#v<x>` directly gets whatever that tag points at. Only the release workflow makes
release tags; never push one by hand.

The release kit is these files, the same in every plugin: `scripts/release-rules.mjs`, `scripts/release-commit.mjs`,
`scripts/release-github.mjs`, `scripts/check-release-shape.mjs`, `scripts/changelog.mjs`, `scripts/release-version.mjs`,
`scripts/release-pack.mjs`, `scripts/publish-release.mjs`, `scripts/attach-native.mjs`, `scripts/native-manifest.mjs`,
`scripts/tested-hosts.mjs`, `scripts/check-release-plugin-add.sh`, `scripts/check-drift.mjs`, `scripts/capture-tools.mjs`,
`scripts/release-kit.test.mjs`, `scripts/drift-kit.test.mjs` and `.github/workflows/release.yml`. `scripts/check-copies.mjs`
pins each of the scripts whole by its sha256, so a plugin whose copy differs from the family's fails `npm run check`:
change the kit in every plugin at once, with the new hashes. Do not re-run the older `apply-release-kit.mjs`: it writes
back the kit that could release only `v0.0.0`.

Each release has its own tag, and a Git install does not update by itself. To move to a newer release, remove the old entry with `opencode plugin remove github:we-the-rebel-alliance/boxd-plugin#v<old version>`, then add the new tag with `opencode plugin add github:we-the-rebel-alliance/boxd-plugin#v<version>`.

Or add the plugin to `opencode.json` instead, with the same spec:

```json
{ "plugins": [{ "package": "github:we-the-rebel-alliance/boxd-plugin#v<version>" }] }
```
