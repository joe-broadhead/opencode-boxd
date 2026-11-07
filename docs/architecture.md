# Architecture

The plugin has one job: keep the transcript on the laptop while the session runs on a boxd machine.

```
OpenCode (laptop)                     boxd machine                   laptop
┌──────────────────┐   boxd CLI   ┌────────────────────┐   export   ┌──────────────┐
│ boxd_* tools     │ ───────────▶ │ OpenCode on :4096  │ ─────────▶ │ opencode     │
│ ledger + status  │ ◀─────────── │ guest/guest.py     │            │ session      │
└──────────────────┘  JSON lines  └────────────────────┘            │ import       │
        │                                                           └──────────────┘
        └── ~/.local/share/opencode-boxd/works/<id>/  (exports, patch, work.json)
```

## The pieces

- `src/plugin.ts` — one `Plugin.define`: options, host check, the fleet, the default rules, the skill, `/boxd-status`,
  the status RPC, the tools RPC and the tool transform.
- `src/fleet.ts` — the control plane: ensure, submit, job, harvest, sleep, resume, image, drop. It refuses to sleep,
  image or drop work whose laptop import is not fresh, and refuses to drop a machine it does not own.
- `src/cli-boxd.ts`, `src/cli-guest.ts`, `src/prover.ts` — the three ports, each a thin wrapper over a command. Every
  argument is an argv array, never a shell string.
- `guest/guest.py` — the helper copied to the machine. It speaks one JSON object in and one out, and talks only to
  `127.0.0.1`.
- `src/ledger.ts` — the laptop's store, written atomically.
- `src/status.ts` — one model for the tool, the command, the dialog and the RPC.
- `src/tools.ts` — one table of nine tools: name, class, schema, description and run. The tools RPC, the transform, the
  default rules and status all derive from it.

## Why the guest is not the session

A boxd snapshot is an image. Booting one restores a disk, not a transcript, and a shared machine deletes OpenCode's
sign-in. So the transcript moves by export and import: the guest exports the session tree, this laptop imports it parents
first, and only then may the machine sleep, be imaged or be destroyed.

## Platform facts

- `opencode session import` keeps the transcript's id on 2.2.3–2.2.6, and answers `Session already exists` (exit 0, no
  id) for an id already present.
- The import runs with `--standalone`, so it never depends on a service being up.
- `POST /api/session` creates a session, `POST /api/session/<id>/prompt` admits one, and
  `GET /api/experimental/session/<id>/export` and `POST /api/experimental/session/import` move one. The guest helper is
  the only code that speaks these.
- The stock TUI resolves a plugin's `ui.dialog.alert` on every close path, which the pack test checks per release.

## The tools RPC

`boxd.machines.tools` is the family's v2 module, copied verbatim outside its plugin block: a script calls each tool with
no model, as a session and its agent. The rules decide: only a resolved `allow` runs, an `ask` is refused because no one
can answer it, and every change still asserts inside its own run.
