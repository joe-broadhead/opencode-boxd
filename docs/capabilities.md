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
  access rules, one next step). `events_list` reads the local ledger's phase changes, oldest first, with a cursor bound
  to the plugin, the source and the local identity; it makes no boxd call and never wakes a machine. `job` reads one
  work or many live.
  `read` reads one file or the guest's server log without a harvest. `probe` says whose ledger this is.
- **The works list.** `status` with `{ list: "works" }` answers the `boxd.works.list` snapshot: at most 50 works, newest
  activity first, as the contract's `list` output.
- **Machine-hours.** Each work's record carries the time its machine existed and the time it ran, in seconds, counted by
  the ledger at every phase change from the record's last change: every phase but `gone` and `closed` adds to
  `existedSeconds`, and the running phases add to `runningSeconds`. `boxd_status` with `include: ["cost"]` shows
  `hours: { existed, running }` on each work row beside the money figures, and `boxd_job` shows the same on every answer.
  The cost block sums them for this ledger, for today from local midnight, and since the oldest open work was created.
  The hours are computed from the ledger alone, so they show without an owner's sign-in; the money figures stay `null`
  without one.
- **Changes.** `ensure` makes a work exist and converges it; `submit` admits a prompt; `harvest` exports the session
  tree and copies the files back; `sleep` hibernates; `resume` wakes or rebuilds; `reassign` moves an unstarted work's
  machine to a new id; `golden` builds, lists or prunes golden images. Every one of them emits `changed`.
- **`exec`** is class `admin` with `effect: "ask"`: it asks even at `access: "all"`. It runs one command on the guest and
  can print a secret that is not host-bound.
- **`drop`** is class `delete`. It refuses unless the work is saved, its git tree is known, every untracked or ignored
  path was harvested, and every commit on a local branch, tag, stash or detached HEAD is on a remote ref.
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
