# Configuration

Every option is optional. Set them under the plugin entry in `opencode.json`.

<!-- generated:configuration -->
| Option | Type | Default | Description |
|---|---|---|---|
| `access` | `all` \| `ask-changes` \| `read-only` | `"all"` | How much the plugin's methods may do: every method, changes ask first, or reads only. |
| `allowUntestedHost` | boolean | `false` | Start outside the tested OpenCode range. |
| `allowedRoots` | array | `[]` | Absolute folders here, besides the project, that work files may read or write. |
| `regions` | array | `["fra","nyc"]` | The regions a new work's machine or a golden image may be placed in. |
| `region` | `auto` \| `fra` \| `nyc` | `"auto"` | Where a new work goes within regions; auto picks the region with the most free machines. |
| `keepFree` | object | `{"fra":0,"nyc":0}` | Machines auto leaves free in each region for the organisation's CI pool. |
| `keep` | array | `[]` | Label selectors ("key=value", or a bare key) for machines owned elsewhere: a match is kept, never an orphan. |
| `size` | `1x4` \| `2x8` \| `4x16` \| `8x32` | `"2x8"` | A new work's machine size, vCPU x GiB. |
| `git` | object | — | The guest's git identity for every new work. Never a token. |
| `goldenPrefix` | string | `"oc-golden"` | Golden image names are <goldenPrefix>-<opencode version>-<size>. |
| `goldenBase` | string | `"stock"` | What a golden build starts from: stock, or a snapshot name in the region it lives in. |
| `goldenSetup` | string | — | An absolute path here to a script the golden builder runs before the scrub. |
| `buildGolden` | `auto` \| `never` | `"auto"` | Whether boxd_ensure builds a missing golden image itself, or refuses with a next step. |
| `notices` | `wake` \| `queue` \| `off` | `"wake"` | How a work's change reaches its session: yes, queue for when it is idle, or no notice. |
| `autoHibernateMinutes` | integer | `120` | The platform's idle bound before a machine hibernates, in minutes. |
| `automation` | `auto` \| `on` \| `off` | `"auto"` | Whether the plugin harvests and hibernates finished works itself: auto is on at access all, on is standing consent, off never. |
| `autoSleepMinutes` | integer | `10` | Idle minutes before automation harvests and hibernates a finished work; 0 turns that step off. |
| `orphanHours` | integer | `12` | A running, not-busy work no plugin call touched for this long is harvested and hibernated. |
| `leaseDays` | integer | `0` | A delete-after lease renewed on activity, in days; 0 is off. |
| `budget` | object | — | Machine cost per day, warned about or refused at, in the organisation's billing currency. |
<!-- /generated:configuration -->

## Machine classes

The status read classifies every machine in the organisation, not only the machines the plugin made. A machine is one
of:

- a work in this ledger;
- a work in another ledger, when its `ledger=` label names another ledger;
- kept, when it matches a selector in `keep`;
- a golden builder;
- an orphan.

`/boxd` lists each orphan with its region, status and why: no `ledger` label, this ledger's label with no record, or
the plugin's legacy labels only. Only a session machine is actionable. Any other orphan is left alone, with the next
step "label it, or add a selector to keep". Counts by class sit beside the list, and the list is capped with `more`.

`keep` is how you declare the machines you own elsewhere, such as a lead's or a runner's. Each entry is a boxd label
selector: `key=value` matches that value, and a bare key matches the label's presence. For example,
`"keep": ["role=lead", "runner"]` keeps a machine whose `role` is `lead`, and any machine that carries a `runner`
label.

`boxd_ensure` with `select: "orphans"` adopts every actionable orphan that `/boxd` lists. It reads the guest's
`describe`, writes a record from the machine's folder, repository and root session, and sets this ledger's labels. It
runs no setup, clone, upgrade or resize. A busy orphan, or one waiting on a person, is adopted and left running; one
whose `describe` fails is skipped with its error.

## Examples

A small project that may place machines only in Frankfurt, at 2 vCPU and 8 GiB:

```json
{
  "plugins": [
    {
      "package": "github:we-the-rebel-alliance/boxd-plugin#v0.0.0",
      "options": {
        "access": "ask-changes",
        "regions": ["fra"],
        "region": "fra",
        "size": "2x8"
      }
    }
  ]
}
```

A project with a git identity and a daily machine budget that refuses rather than warns:

```json
{
  "options": {
    "git": { "name": "Ana", "email": "ana@example.com" },
    "budget": { "daily": 20, "action": "refuse" },
    "autoSleepMinutes": 5
  }
}
```

- `regions` is the placement allowlist for a new machine and a new golden image; a work that already lives in another
  region still converges, resumes and drops there.
- `automation` is the plugin's own harvest-and-hibernate of finished works. `auto` means on at `access: "all"` and off
  otherwise; `on` is your standing consent at every level; `off` never runs it. Nothing automatic ever drops.
- `leaseDays` sets a delete-after timer that boxd enforces. It is off by default because boxd deletes unsaved work too.
