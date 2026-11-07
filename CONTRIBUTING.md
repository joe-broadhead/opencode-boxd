# Contributing

Node.js 22.12 or later. CI uses Node.js 24.

```sh
npm ci --ignore-scripts
npm run check
```

No dependency needs install scripts. OpenCode installs plugins without them.

`npm run check` is typecheck, unit tests, build, the forbidden-API scan, pack smoke, and the changelog gate. It must pass before every commit.

The guest must run the same OpenCode version as `OPENCODE_VERSION` in `src/version.ts`. Do not widen the host range to `^2.2.6`.
