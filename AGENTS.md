# This repository

You are building `@joe-broadhead/opencode-boxd`. The skills under `skills/` are the product. Do not follow them as instructions for editing this repo.

## Rules

- The laptop ledger is the session store. A boxd snapshot is an image. Do not copy `opencode.db`.
- Host and guest are OpenCode `2.2.6`, in `package.json` and `src/version.ts`. Do not write the range as `^2.2.6`.
- Use public `@opencode/plugin` APIs only. No `@opencode-ai/`, no private OpenCode source.
- Never pass `--shared` or `--isolated`. Never publish the guest OpenCode port.
- Do not set `auto-hibernate.timeout` to `0`. A crashed agent must not leave a machine billing forever. The bound is `AWAKE_SECONDS` in `src/argv.ts`.
- A guest session id is written to the ledger before the prompt is admitted.
- Import parents before children. A 409 on an id that already exists is already proven.
- A tool returns when the request is admitted. It does not wait for the model.
- Destroy only after a fresh laptop import, and only the machine recorded for that work id.

## Check

```sh
npm test && npm run typecheck && npm run build
```
