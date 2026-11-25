# Contributing

The plugin follows [the plugin standard](https://github.com/we-the-rebel-alliance/plugin-contract/blob/master/docs/plugin-standard.md).
Read [AGENTS.md](AGENTS.md) for the layout and the rules.

```sh
npm ci --ignore-scripts
npm run check        # typecheck, build, unit, conformance, host, pack, actionlint, plugin-kit check
```

You need Node 24 and Bun, which the tests use.

- Add or change a method in `package.json` `capabilities.methods` first, then its handler in `src/handlers/`, then its
  tests.
- Run `npx plugin-kit docs` after a manifest change, and commit the generated sections.
- `dist/` is built by `node scripts/build.mjs`; do not edit it by hand.

## Releases

Releases are tags, not npm packages. A release is prepared in one pull request,
`chore(release): prepare vX.Y.Z`: the version in `package.json` and `package-lock.json`, the `CHANGELOG.md` section, and
`npx plugin-kit docs` if the manifest changed. The owner pushes the tag after `master`'s CI passed; the release workflow
checks the tag, builds, and creates the GitHub release with the packed tarball, the conformance report and `SHA256SUMS`.
The tag is `github:we-the-rebel-alliance/boxd-plugin#vX.Y.Z`.
