# Capabilities

Every method, source, action and bus event the manifest declares.

<!-- generated:capabilities -->
### Methods

| Method | Class | Accounts | Operations |
|---|---|---|---|
| `status` | read | none | `boxd.machine.list`, `boxd.manage.machine-limit`, `boxd.manage.usage`, `boxd.env.list`, `boxd.snapshots.list`, `boxd.machine.exec`, `boxd.local.ledger.read` |
| `events_list` | read | none | `boxd.local.ledger.read` |
| `job` | read | none | `boxd.machine.list`, `boxd.machine.exec`, `boxd.local.ledger.read` |
| `read` | read | none | `boxd.machine.list`, `boxd.machine.exec` |
| `probe` | read | none | — |
| `ensure` | admin | none | `boxd.machine.new`, `boxd.machine.get`, `boxd.machine.list`, `boxd.machine.label.set`, `boxd.machine.resize`, `boxd.machine.reboot`, `boxd.machine.wake`, `boxd.machine.config.set`, `boxd.snapshots.save`, `boxd.machine.cp`, `boxd.machine.exec`, `boxd.manage.machine-limit` |
| `submit` | write | none | `boxd.machine.list`, `boxd.machine.wake`, `boxd.machine.cp`, `boxd.machine.exec` |
| `harvest` | export | none | `boxd.machine.wake`, `boxd.machine.exec`, `boxd.machine.cp`, `boxd.local.session.import` |
| `sleep` | write | none | `boxd.machine.get`, `boxd.machine.hibernate` |
| `resume` | admin | none | `boxd.machine.list`, `boxd.machine.get`, `boxd.machine.new`, `boxd.machine.wake`, `boxd.machine.cp`, `boxd.machine.exec`, `boxd.manage.machine-limit` |
| `reassign` | admin | none | `boxd.machine.get`, `boxd.machine.list`, `boxd.machine.rename`, `boxd.machine.label.set` |
| `golden` | admin | none | `boxd.snapshots.list`, `boxd.snapshots.save`, `boxd.snapshots.remove`, `boxd.machine.new`, `boxd.machine.get`, `boxd.machine.resize`, `boxd.machine.reboot`, `boxd.machine.remove`, `boxd.machine.cp`, `boxd.machine.exec`, `boxd.env.list` |
| `exec` | admin | none | `boxd.machine.get`, `boxd.machine.wake`, `boxd.machine.exec` |
| `drop` | delete | none | `boxd.machine.get`, `boxd.machine.list`, `boxd.machine.exec`, `boxd.machine.remove` |

### Sources

| Source | Kind | Reads or output | Method | Cost |
|---|---|---|---|---|
| `boxd.works` | events | `x-boxd/work` | `events_list` | free |
| `boxd.works.list` | snapshot | `list` | `status` | free |

### Actions

None.

### Bus events

`rpc.boxd.changed`
<!-- /generated:capabilities -->

## Notes

- **Reads.** `status` answers the contract's plugin status (host range, no plugin-held accounts, agents missing the
  access rules, one next step). `events_list` reads the local ledger's changes, oldest first, including a wait for input
  that starts or clears, with a cursor bound to the plugin, the source and the local identity; it makes no boxd call and
  never wakes a machine. `job` reads one work or many live.
  `read` reads one file or the guest's server log without a harvest. `probe` says whose ledger this is.
- **Work events.** Each event carries at most one `change:` label, so an automation keys on one word: `change:started`
  when a work goes `busy`, `change:waiting` when it waits on a person, `change:finished` when its run completes or the
  guest declares it done, `change:failed` when its run fails or stops, or it is `unreachable` or `gone`, and
  `change:idle` when it is `idle` with no outcome or `ready`. An event that fits none, such as `creating`, `starting`,
  `asleep` or `closed`, carries no `change:` label. The existing `phase:`, `outcome:`, `needs:` and `done` labels stay.
- **The works list.** `status` with `{ list: "works" }` answers the `boxd.works.list` snapshot: at most 50 works, newest
  activity first, as the contract's `list` output.
- **Machine-hours.** Each work's record carries the time its machine existed and the time it ran, in seconds, counted by
  the ledger at every phase change from the record's last change: every phase but `gone` and `closed` adds to
  `existedSeconds`, and the running phases add to `runningSeconds`. `boxd_status` with `include: ["cost"]` shows
  `hours: { existed, running }` on each work row beside the money figures, and `boxd_job` shows the same on every answer.
  The cost block sums them for this ledger, for today from local midnight, and since the oldest open work was created.
  The hours are computed from the ledger alone, so they show without an owner's sign-in; the money figures stay `null`
  without one.
- **Machines against the limit.** The `/boxd` report counts the organisation's machines against boxd's limit from the
  all-region listing and the machine limit the fleet read already takes, with no usage read and no owner's sign-in. Its
  `Machines:` line reads, for example, `1,180 of 1,250 in use (40 running, 12 standby, 1,128 hibernated); 31 are this
  ledger's works`. The fleet read's `machines` block holds, beside the classes and orphans below, `limit`, `inUse`
  (every machine boxd counts: any state but `destroyed`, so hibernated and stopped machines included), `free`,
  `byState` (`running`, `starting`, `standby`, `hibernated`, `stopped`, `other`), `works` (the machines this ledger's
  open works name) and each region's own row in `perRegion`. When the limit cannot be read the counts still show and
  `limit` and `free` are null; when the listing cannot be read the report says so instead of showing a zero.
- **The done signal.** A coordinator tells each work to finish with the guest's `boxd_done({ summary, prs })` tool: a
  short summary and its pull request URLs or `owner/repo#n`. `status` and `job` show `done: true` once the guest declares
  the whole task, subagents included, finished; `job` carries `summary` and `prs`. The manifest names the guest tool under
  `guestTools`, so the static tool check accepts its name in the skill. The works list shows `done` on each work, and a
  done, unsaved work appears in `attention`. `outcome: completed` without `done` means the turn ended, not the task; a
  new `submit` clears the report.
- **Changes.** `ensure` makes a work exist and converges it; with `repo` it starts from the repository's warm image when
  one exists, and its answer says `warm` and, for a work this version made, once ready, `readySeconds`. With `machine`
  it puts the work in a slot on the shared machine `oc-shared-<name>` instead of a machine of its own. `submit` admits a
  prompt; `harvest` exports the session tree and copies the files back; `sleep` hibernates; `resume` wakes or rebuilds;
  `reassign` moves an unstarted work's machine to a new id; `golden` builds, lists or prunes golden images, and with
  `repo`, one of the plugin option `warm` repositories, it builds that repository's warm image from its version's image,
  with the repository's checkout and setup script. Every one of them emits `changed`.
- **Orphans.** The fleet status classifies every machine as a work here, another ledger's work, kept by a `keep` selector,
  a golden builder, or an orphan with its reason and whether the plugin may act on it. `ensure` with
  `{ select: "orphans" }` adopts every actionable orphan: it reads the guest's `describe`, writes a record and sets this
  ledger's labels, without setup, clone, upgrade or resize. A busy or waiting orphan is adopted and left running; a
  hibernated orphan is woken for the read and left running. One whose `describe` fails is skipped with its error.
- **`exec`** is class `admin` with `effect: "ask"`: it asks even at `access: "all"`. It runs one command on the guest and
  can print a secret that is not host-bound.
- **`drop`** is class `delete`. It refuses unless the work is saved, its git tree is known, every untracked or ignored
  path was harvested, and every commit on a local branch, tag, stash or detached HEAD is on a remote ref.
- **The budget.** `budget.daily` caps today's machine cost; `budget.machines` caps this ledger's machines and
  `budget.orgMachines` caps the organisation's count, both from the all-region listing and without an owner's sign-in.
  `ensure`, and `resume` when it rebuilds, refuse before a create at a reached cap under `action: "refuse"`, and warn
  `BUDGET_WARN` under `"warn"`. A wake never counts as a new machine.
- **No plans or actions.** Every method is one call. The contract permits a method without `plans`/`commits`, and boxd's
  destructive guard is part of the call it protects.

## Machine classes

The status read behind `/boxd` classifies every machine in the organisation by its labels and the records in this
ledger:

| Class | What it means |
|---|---|
| a work in this ledger | an open record names the machine, by its id or its `oc-<work id>` name |
| a work in another ledger | its `ledger=` label names a ledger other than this one |
| kept | it matches a selector in the `keep` option |
| a golden builder | its `role` is `golden-builder`, or its name starts with `oc-gb-` |
| an orphan | none of the above |

Each orphan carries its region, status, why and whether the plugin may act on it. The why is one of "no ledger label",
"this ledger's label with no record" or "legacy labels only". Only a session machine is actionable; any other orphan
has the next step "label it, or add a selector to keep". Counts by class sit beside the list, which is capped with
`more`.
