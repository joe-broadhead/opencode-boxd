# Contributing

The plugin follows [the plugin standard](https://github.com/we-the-rebel-alliance/plugin-contract/blob/master/docs/plugin-standard.md).
Read [AGENTS.md](AGENTS.md) for the layout and the rules.

```sh
npm ci
npm run check        # typecheck, build, unit, plugin-kit check, host, pack, actionlint
```

- Add or change a method in `package.json` `capabilities.methods` first, then its handler in `src/handlers/`, then its
  tests.
- Run `npx plugin-kit docs` after a manifest change, and commit the generated sections.
- `dist/` is built by `node scripts/build.mjs`; do not edit it by hand.
- A release is a tag `vX.Y.Z` cut by `npx plugin-kit release <version>` on a green `master`; CI publishes it.
