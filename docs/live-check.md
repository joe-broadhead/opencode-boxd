# Live check against real boxd

Everything in this file needs real boxd machines. Nothing here runs in a check or a test: each item is a place where the
plugin relies on boxd's behaviour, and the fake CLI in the tests could hide a gap.

## Where it runs

Steps L1 to L11 run on a boxd machine with the **host** boxd CLI (0.3.8 or later) installed in an isolated `HOME`,
signed in with a short-lived key that the owner mints for it:

```sh
boxd auth keys create live-check --expires-in-secs 86400
```

The key is passed as `BOXD_TOKEN` for the run only, and is never written to disk or to a transcript. The in-VM CLI is
refused by the plugin, acts in one region, and cannot read organisation usage, so it cannot stand in. Machine usage is
for organisation owners and admins: L3's cost part needs an owner's or admin's key, and with a member's key L3 checks
only that machine cost answers `null` with boxd's reason. L12 and L13 run on the owner's Mac.

Every machine the live check creates carries `--label role=live-check` and `--delete-after 2h`, so nothing it leaves
behind outlives the run. Start each run from an empty ledger in the isolated `HOME`.

## The steps, and which have run

No step has run against this release yet: no key has been provided. Until one is, the release rests on the unit and
host suites and on the facts already measured in [architecture.md](architecture.md), and each step below stays ready
for the owner to run. The README's known limits name what that leaves open.

| # | What it checks | Run |
|---|---|---|
| L1 | `--region` on every verb the plugin uses; the keys of `machine list --region all --json` (the region column, and whether `id` and `isolated` are there); every verb the plugin uses accepts a machine **id**, `exec` and `cp` included; `machine new --json` carries `id`. | not run |
| L2 | `machine new --from-snapshot X --auto-suspend-timeout 0 --auto-hibernate-timeout 7200 --idle-ignore-outbound=off --delete-after 1d` is accepted and `machine get` shows each value; `--vcpu` with `--from-snapshot` is refused, with its exact words. A guest left idle with an outbound poller stays `running`. `machine usage` of one work, running idle and then hibernated, confirms the per-hour figures of the design's cost section within boxd's 25-minute lag. | not run |
| L3 | `manage machine-limit --json` with its per-region shape; the keys of `manage usage --json` and `machine usage --json`, and who may read them. Status's region headroom and machine cost read these shapes as boxd's documentation describes them until this step confirms them. | not run |
| L4 | The exact stderr for a missing machine in each region, for a name that exists only in the other region (the "There is a machine … in nyc" hint), and for a `get` by an id that no longer exists. | not run |
| L5 | `MACHINE_LIMIT`: a scratch organisation without a payment method is capped at 2 machines, so the third create shows boxd's exact words. | not run |
| L6 | Resize ten or more machines at once; capture `cannot connect to VM agent`; check that one `machine reboot` fixes it. | not run |
| L7 | `boxd_golden` from stock in `fra` and `nyc`: the time, the 401/200 password probe, the env file removed, and a work created from it at the image's size with no reboot. | not run |
| L8 | `steer`, `queue` and `interrupt` against a real cheap model, on a task that steps every few seconds and on one blocked in `sleep 120`: steer lands at the next step, and only interrupt reaches the blocked one. | not run |
| L9 | `machine rename <id> <new> -y` reboots the machine, and `machine label set <id> work=<new>` takes effect. | not run |
| L10 | Harvest twice: the copy here changes the second time. A `boxd connect` prompt after the harvest makes drop answer `NOT_SAVED`. | not run |
| L11 | The import of an earlier ledger, from a copy of a real one the owner provides, in an isolated `HOME`: kill it once mid-way, restart, and compare; then read one running guest through its earlier helper with no upload, and see the first change adopt it. | not run |
| L12 | Owner's Mac: first reproduce the stall that 24 parallel `boxd_ensure` calls caused on the earlier release, with the real OpenCode server; then the same on this release, with `health.loopLagMaxMs` and no "Event stream stalled". | not run |
| L13 | Owner's Mac: the macOS config path, and the `PATH` the OpenCode server sees. | not run |

## What to write down

For each step: the CLI version, the exact command, and what it answered, with any id or secret replaced by a
placeholder. Put a confirmed shape in [architecture.md](architecture.md)'s platform facts, mark the step's row with the
date it ran, and fix the stderr table or the CLI port where an answer differs from what the plugin reads. A step that
finds a difference is a release blocker until the plugin reads boxd's real answer.
