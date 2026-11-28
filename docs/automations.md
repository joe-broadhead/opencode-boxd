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

## The nightly warm-image rebuild

Set the plugin option `warm` to the repositories whose checkouts, toolchains and dependencies a work should find
already on its machine: one `{ repo, setup }` for each, where `setup` is a script here that installs them inside the
checkout. The nightly automation rebuilds every warm image in every allowed region at the option `size`, and reports
each failure in one line:

```ts
import type { Automation } from "@opencode/plugin"

export default {
  name: "boxd-warm-images",
  every: "24 hours",
  async run() {
    const result = await tools.boxd.golden({ warm: "all", rebuild: true })
    const failures = result.failures ?? []
    const building = result.building ?? []
    if (failures.length === 0 && building.length === 0) return { state: { built: result.images.length, building: 0, failed: 0 } }
    const lines = [
      ...(building.length > 0 ? [`building: ${building.length} (the next run joins them)`] : []),
      ...failures.map((failure) => `${failure.repo} (${failure.region}): ${failure.error}: ${failure.message}`),
    ]
    return { state: { built: result.images.length, building: building.length, failed: failures.length }, prompt: lines.join("\n") }
  },
} satisfies Automation
```

- Each `{ repo, setup }` in `warm` names a repository and a script here that installs its toolchain and dependencies
  inside the checkout. `ref` warms another branch or tag.
- A warm image starts from its OpenCode version's golden image in the same region, so the first rebuild also builds
  that image when it is missing.
- A few builders run in each region at once, so the rebuild stays inside the machine limit beside the lanes.
- A failed build is one repository and region. The other repositories still rebuild, and `failures` names each one with
  its code, message and next step.
- A build still running when the call's bound comes is in `building`, not `failures`: it goes on, and the next run
  joins it. The recipe reports it as a count, not as a failure.
- A prune removes a warm image whose repository is no longer in `warm`, or whose OpenCode version is not current,
  unless an open work records it. Call `tools.boxd.golden({ prune: true })` after the rebuild when you need it.
