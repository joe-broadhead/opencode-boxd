# Automations

The works source is a local events feed: the ledger's phase changes, with a cursor. A timer automation reads it with
`tools.boxd.events_list`, keeps the cursor in its durable state, and reports what changed.

<!-- generated:automations -->
| Source | Method | Provider floor | Suggested | Signals |
|---|---|---|---|---|
| `boxd.works` | `tools.boxd.events_list` | — | 1 min | `bus` |
<!-- /generated:automations -->

## The timer recipe

An OpenCode automation runs on a schedule and gets its state back on the next run. This one lists the phase changes
since the last run and reports them in one line:

```ts
import type { Automation } from "@opencode/plugin"

export default {
  name: "boxd-works",
  every: "5 minutes",
  async run({ state }) {
    const input = state?.cursor === undefined ? { since: new Date(Date.now() - 300_000).toISOString() } : { cursor: state.cursor }
    const page = await tools.boxd.events_list(input)
    const next = { cursor: page.cursor }
    if (page.events.length === 0 && page.gap === undefined) return { state: next }
    const text = `boxd: ${page.events.length} change${page.events.length === 1 ? "" : "s"}${page.gap ? " (the log rotated; this page restarts at its oldest kept event)" : ""}`
    return { state: next, prompt: text }
  },
} satisfies Automation
```

- The cursor is bound to the plugin, the source and the local identity; a cursor from another source or identity is
  `CURSOR_INVALID`. A log rotation answers `gap: { reason: "expired", since }` and starts again at the oldest kept event.
- `events_list` never calls boxd and never wakes a machine. A change that needs a decision is a `boxd_job` or `/boxd`
  read, not an event's text.
- A write method emits `changed`, so an app can also re-read on the bus event instead of polling.
