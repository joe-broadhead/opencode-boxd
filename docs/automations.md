# Automations

The works source is a local events feed: the ledger's changes, waits for input included, with a cursor. A timer
automation reads it with `tools.boxd.events_list`, keeps the cursor in its durable state, and reports what changed.

<!-- generated:automations -->
| Source | Method | Provider floor | Suggested | Signals |
|---|---|---|---|---|
| `boxd.works` | `tools.boxd.events_list` | — | 1 min | `bus` |
<!-- /generated:automations -->

## The timer recipe

An OpenCode automation runs on a schedule and gets its state back on the next run. This one lists the changes
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
- A write method, and the watcher for every work event it appends or tails, emits `changed`, so an app can also re-read
  on the bus event instead of polling.

## The event recipe

An app that must react at once waits on `rpc.boxd.changed`, reads `events_list` from the cursor in its state, and acts
on the event's `change:` label. It never reads `status` or `job` to learn a work's state: the nudge only says to read
the log again.

| Label | The change |
|---|---|
| `change:started` | the work went `busy` from another phase |
| `change:waiting` | the work waits on a person; `needs:permission` or `needs:form` says which |
| `change:finished` | the work is `idle` with `outcome:completed`, or the guest declared it `done` |
| `change:failed` | the work is `unreachable` or `gone`, or it is `idle` with `outcome:failed` or `outcome:aborted` |
| `change:idle` | the work is `idle` with no outcome, or `ready` |

Every event carries at most one `change:` label. An event that fits none of the five, such as `creating`, `starting`,
`asleep` or `closed`, carries no label. A `busy` to `busy` event also carries none: it exists only to start or clear a
wait, and the event that starts the wait carries `change:waiting`.

```ts
// The automation's durable state holds the cursor between runs.
const input = state.cursor === undefined ? { since: new Date(Date.now() - 60_000).toISOString() } : { cursor: state.cursor }
const page = await tools.boxd.events_list(input)
const next = { cursor: page.cursor }
for (const event of page.events) {
  const change = event.labels.find((label) => label.startsWith("change:"))
  if (change === "change:waiting") await answerThePerson(event.thread)
  if (change === "change:finished") await harvestTheWork(event.thread)
  if (change === "change:failed") await reportTheFailure(event)
}
return { state: next }
```

The thread is `boxd-work:<workId>`, so one label names both the work and what happened to it. The existing `phase:`,
`outcome:`, `needs:` and `done` labels stay for a reader that needs the detail.

## A day's cost by product

Every work appends one cost event for each local day that ended, and one for its whole life when it closes. The event's
labels carry the figures: `cost:<YYYY-MM-DD or life>`, `running-seconds:<n>`, `asleep-seconds:<n>`, `amount:<amount>`,
`currency:<code>`, `rates:<usage or public>`, and the work's `product:`, `role:`, `feature:` and `task:` labels when the
record holds them. Keep the cursor and add each day's `amount` to its product, so a product's day is a sum of its
events alone:

```ts
import type { Automation } from "@opencode/plugin"

export default {
  name: "boxd-cost",
  every: "1 hour",
  async run({ state }) {
    const page = await tools.boxd.events_list(state?.cursor === undefined ? { since: new Date(Date.now() - 86_400_000).toISOString() } : { cursor: state.cursor })
    const days = new Map<string, { amount: number; currency: string }>()
    for (const event of page.events) {
      const labels = new Map(event.labels.map((label) => [label.slice(0, label.indexOf(":")), label.slice(label.indexOf(":") + 1)]))
      const day = labels.get("cost")
      if (day === undefined || day === "life") continue
      const product = labels.get("product") ?? "unlabelled"
      const key = `${product}|${day}|${labels.get("currency") ?? ""}`
      const row = days.get(key) ?? { amount: 0, currency: labels.get("currency") ?? "" }
      row.amount += Number(labels.get("amount") ?? 0)
      days.set(key, row)
    }
    const lines = [...days].map(([key, row]) => {
      const [product, day] = key.split("|")
      return `${product} ${day}: ${row.currency} ${row.amount.toFixed(2)}`
    })
    return { state: { cursor: page.cursor }, ...(lines.length ? { prompt: `boxd cost\n${lines.join("\n")}` } : {}) }
  },
} satisfies Automation
```

A life event's `cost:life` covers the work's whole life, so a day's sum skips it; a work that closes today still has its
day events for the days it existed. A work whose record has no `product` label is summed under `unlabelled`.
