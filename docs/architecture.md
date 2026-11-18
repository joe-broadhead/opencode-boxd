# Architecture

The plugin has one job: let one coordinating agent on a laptop drive 1 to 300 or more OpenCode sessions on boxd
machines, and keep every transcript on the laptop. [v1-design.md](v1-design.md) is the full design; this page is the
map of what the code does.

```
OpenCode (laptop)                         boxd machine oc-<work id> (fra or nyc)
┌───────────────────────────┐ boxd CLI ┌──────────────────────────────────┐
│ boxd_* tools ── runner ───┼────────▶ │ ~/.opencode-boxd/guest.py         │
│ watcher ── notices        │ ◀────────┤ opencode serve on 127.0.0.1:4096  │
│ status, cost, automation  │ JSON     │ /home/boxd/work/<work id>         │
└───────────┬───────────────┘ lines    └──────────────────────────────────┘
            └── ~/.local/share/opencode-boxd/v1/ (works/<id>/work.json, exports, patch, untracked, events.jsonl)
```

## The pieces

Each package fills one entry module, and `src/plugin.ts` builds them once, in order: runtime, import, ledger, watcher,
cost, the runs, then automation, the hooks and `/boxd-cleanup`. `src/ports.ts` and `src/services.ts` are the contract.

- **The runtime** (`src/exec/*`, `src/boxd/*`, `src/guest/*`, `guest/guest.py`): the one runner every child process goes
  through, the boxd CLI port with regions and by-id verbs, the guest port over the v1 helper, and the laptop's own
  `opencode` for session imports.
- **The ledger** (`src/ledger/*`): format 1 under `v1/`, one record per work, copy-on-write writes, a lock per work
  across processes, the index, and `events.jsonl` with its cursor. `src/import-v0.ts` imports the earlier ledger once.
- **The machine runs** (`src/fleet/machines.ts` and the files it names): ensure, resume, reassign and golden images,
  and the shared list-form runner.
- **The session runs** (`src/fleet/sessions.ts` and the files it names): submit, harvest, sleep, drop, exec and read,
  the selectors, and the in-process actions automation and `/boxd-cleanup` use.
- **The fleet view** (`src/fleet/status.ts`, `src/fleet/job.ts`, `src/fleet/model.ts`): `boxd_status` and `boxd_job`.
- **The watcher and notices** (`src/watch.ts`, `src/notices.ts`): the sweep, phase events, the event stream, and the
  notices to each work's coordinator.
- **Cost and cleanup** (`src/cost/*`, `src/automation.ts`, `src/hooks.ts`, `src/cleanup.ts`): rates and estimates, the
  budget, automatic harvest and sleep, the session hooks, and `/boxd-cleanup`.
- **The registry** (`src/tools.ts`): one table of twelve tools, with their schemas, classes, descriptions and the one
  place that asserts before a change. The tools RPC, the transform, the default rules, Jelly's declaration and status
  derive from it.
- **Status** (`src/status.ts`, `src/tui.ts`): one model for `/boxd-status`, the `/boxd` dialog and the status RPC.

## One runner for every process

Every child the plugin starts goes through `src/exec/runner.ts`:

- At most 12 boxd children at once for tool calls and reads; the background (the watcher, status's guest reads) uses at
  most 4 of them. `boxd_exec` has its own lane of 4, and the laptop's session imports a lane of 2, so at most 18
  children exist at once.
- Every child has an explicit timeout (SIGTERM, then SIGKILL 2 s later), the call's stop signal, and an 8 MiB output
  cap. Transcripts and files go to disk with `machine cp`, never through stdout.
- A machine change, or a helper action that changes the guest, holds that machine's lock, keyed by its boxd machine id.
  A call takes a slot for one child at a time and gives it back before it waits, so a wait never holds a slot.
- **Acting by id.** Before every change, `machine get` resolves `oc-<work id>` in its region; the call refuses `NOT_OURS`
  unless the id is the one the ledger recorded, and then acts on the id.
- **The read rule.** A read on a guest runs only for a machine that a listing at most 2 s old shows running, uses only
  the helper already on the machine, and never uploads a file or writes the ledger. So a read never wakes a hibernated
  machine, apart from one 2 s race that boxd's missing "exec without waking" leaves.
- The runner samples the event loop's delay while a call runs; status reports the worst of the last 5 minutes.

## The work tree and the file trip

Every work has two folders, both recorded in the ledger: the laptop folder it belongs to (the project by default), and
the guest's own `/home/boxd/work/<work id>`. A laptop path is never sent to the machine.

- `boxd_submit` checks each `files` entry (inside a root, not a symlink, within 8 MiB a file and 32 MiB a call), copies
  it up with `machine cp` before the prompt, and records name, size and sha256.
- `boxd_harvest` has the helper write each session's export on the guest, copies each one to a temp file beside the
  stored copy, checks its size and sha256 against the helper's report, and only then renames it into place; then it
  deletes and re-imports the session on this laptop, parents first. The patch and the untracked files take the same
  path. A copy that is cut off or has the wrong digest leaves the stored copy as it was.
- `boxd_drop` compares the guest's own session marks (each session's last message id and message count) with what the
  harvest stored, so a prompt that bypassed the plugin blocks the destroy too.

## Reading the fleet

`boxd_status` costs one all-region `machine list` (shared, and reused for up to 10 s), the machine limit (cached for
60 s), and guest reads only for works that are busy, starting or unknown, whose machine a listing at most 2 s old shows
running, and whose last read is older than 60 s. Those reads run in the background lane, at most 8 s each and 20 s for
the call; a work whose read misses the budget keeps its last phase, marked `stale`. An idle, ready or asleep work's guest
is never read by status, because an inbound exec resets the machine's idle clock. An idle work's phase changes only by
a change tool, which records it, or by its machine going to sleep, which the listing shows. A `machine list` that fails
is never a guest failure: the reads that needed it are not made (`kind: "listing-failed"`), each work keeps its last
known phase, marked stale, and status, the watcher and `boxd_job` still answer.

The answer is bounded: at most `limit` works in `attention` or `works`, worst first, with `more` for the rest, and more
than 3 works that share a reason and a code fold into one `groups` line. `since` answers from `events.jsonl`, so it
costs no guest read; a cursor older than the kept log answers the full view with `cursorExpired: true`.

`boxd_job` takes one listing at most 2 s old and reads each running work's guest once: an explicit job pays one reset of
an idle machine's idle clock, and status never does. `/boxd-status` and the dialog read no guest at all.

## The watcher and notices

The watcher runs a local tick every 60 s, with no CLI call: it reads the ledger's index and tails `events.jsonl` when the
file changed, so an event a change tool or another OpenCode process appended reaches the subscribers. While any open work
is busy, creating or starting (or idle inside automation's window), each tick is also a sweep: one all-region listing,
then one read-only `phase` read for each busy work the listing shows running. A phase change is appended to the event
log (`unreachable` after two failed reads in a row, `gone` after two listings in a row without the machine) and handed
to every subscriber in `seq` order; cost and automation subscribe. The sweep stops when nothing is busy, when the plugin
stops, and after three failed sweeps in a row, which status reports; the next status call starts it again.

A notice goes only to the work's root coordinator: the session that started or last drove the work from the model path,
found by walking `parentID` up from the calling session. It is checked again just before posting, and a session that is
gone, archived or now under another one gets no notice and is unsubscribed. Changes are coalesced per coordinator, at
most one notice a minute, at most 20 works named, with the cursor for the rest. A notice holds only the plugin's words:
work ids, phases, outcomes and codes from the table, never a guest's text. With `notices: "wake"` an idle coordinator
starts a turn; a wake the host refuses is posted once more as queue only.

## Cost

boxd bills a running machine for active CPU and resident memory, a machine in standby for resident memory, a hibernated
one for disk, and a deleted one nothing. An idle work costs about the same running or in standby, so the plugin sets
auto-suspend off and relies on hibernation:

1. **At creation**, at every `access` level: auto-hibernate after `autoHibernateMinutes` (2 h), `idle.ignore-outbound`
   off, and a `delete-after` lease only with `leaseDays`.
2. **Automation**, on the watcher's events, by one OpenCode process per laptop: a finished work is harvested and then
   hibernated after `autoSleepMinutes`, and so is an orphan whose coordinator is gone. A work waiting on a person is
   left. Nothing automatic ever drops. It runs at `access: "all"`, or with `automation: "on"`.
3. **What agents see**: `cost` and `cleanup` in `boxd_status`, one fleet line on the tail of a coordinator's request
   when the fleet changed (the system prompt is never touched, so the prompt cache holds), and an end-of-turn check
   that speaks only when money burns and automation will not act.
4. **What the person sees**: the Cost row in `/boxd-status`, `/boxd-cleanup` with a permission prompt per action, and
   an optional daily `budget`.

## Why the guest is not the session

A golden image is an image: booting one restores a disk, not a transcript, and an image reaches every work made from
it. So a transcript moves only by export and import, the laptop holds the newest copy, and no work's machine is ever
saved as an image. Model credentials never enter an image: a guest gets its key from a sealed, host-bound `boxd env`
secret that boxd injects at boot.

## Platform facts

Measured against the boxd CLI and OpenCode releases named in each item; [live-check.md](live-check.md) lists what to
measure again.

**OpenCode**

- `opencode session import --standalone` keeps the transcript's id on 2.2.3–2.2.7 and 2.3.0–2.3.2. A second import of
  an id already present answers `Session already exists`, exits 0 and changes nothing, so a harvest deletes the session
  first; `opencode session delete` of an absent id exits 1 with its not-found words, which the plugin reads as absent.
- `POST /api/session/<id>/prompt` takes `delivery: "steer" | "queue"`; the default is `steer`, which a running session
  takes at its next step boundary. `POST /api/session/<id>/interrupt` stops a run.
- A session's last run is `info.outcome` (`succeeded`, `failed`, `interrupted`) on `GET /api/session/<id>`, with the
  failure's structured error on the last `idle` message. The helper asks for one message:
  `?type=idle&order=desc&limit=1`.
- `opencode serve --hostname 127.0.0.1 --port 4096` reads `OPENCODE_PASSWORD` on 2.x: `/api/info` answers 401 without
  credentials and 200 with them. Port 4096 listens on `127.0.0.1` only.
- `opencode auth login` needs a login shell: `boxd machine exec --tty` exits silently, `boxd connect` then
  `opencode auth login` works.

**The boxd CLI** (0.2.29 and 0.3.3; the laptop CLI 0.3.5 for the verbs the design names)

- `machine get --json` prints the id, status, size, labels, `sharing`, `isolated` (the string `"yes"` or `"no"`), the
  idle bounds and `delete_after`. `machine list --json` lists every machine with its status, size and labels, but no
  `id` and no `isolated`.
- A missing machine is `error: VM '<name>' not found` on 0.2 and `error: no machine "<name>" in <region>` on 0.3, exit 1.
  The stderr table reads only those, anchored to the name and region asked, as missing; a hint that names another
  region is `elsewhere`, and anything else is `BOXD_FAILED`.
- Lifecycle strings: `running`, `starting`, `hibernated` (briefly `standby` after a hibernate), `standby`, `stopped`,
  and `destroyed` only as `remove`'s own answer.
- A create from a 9 GiB snapshot answered in about 1 s and was `running` at once. A client killed 1.2 s into
  `machine new` still left a running machine, which the next ensure adopts.
- `wake` keeps a configured auto-hibernate bound. With `idle.ignore-outbound off`, an inbound `machine exec` resets the
  idle clock; with it on, a machine hibernated while its outbound requests ran.
- Hibernation keeps memory and running processes; `stop` keeps only the disk.
- `machine cp` round trips are byte-exact, from stdin and to stdout alike.
- `manage usage --json` reports each machine's running, standby, hibernated and stopped seconds, its vCPU, RAM and disk
  hours, and the cost in micro-units of the organisation's currency (rates 39000 per vCPU-hour, 12000 per GiB-hour of
  RAM, 80 per GiB-hour of disk); it can lag by up to 25 minutes (`complete: false`), and is for owners and admins.
- boxd regenerates `/etc/profile.d/boxd-env.sh` at every boot with the account's `boxd env` values, so an image built
  without it still gets the key at boot.
- The stock image carries OpenCode 1.19.5; `opencode upgrade --major` and then `opencode upgrade <version>` pins a 2.x
  release, about 4 s each.

## The tools RPC

`boxd.machines.tools` is the source contract package's `tools-rpc` module, bundled into `dist/index.js`, with boxd's
plugin value in `src/tools-rpc.ts`: a script calls each tool with no model, as a session and its agent. The rules
decide: only a resolved `allow` runs, an `ask` is refused because no one can answer it, and every change still asserts
inside its own run.

The same RPC carries the `boxd.works` source's `events_list` and `probe` (`src/sources.ts`), which are methods only,
not model tools. `events_list` reads `events.jsonl` through `LedgerPort.eventsSince`, the ledger's own sequence number
as its cursor and `cursorExpired` as the contract's `gap`. It reads only a published ledger: while the v0 import runs it
answers `UNAVAILABLE` rather than joining the import's gate, which could retry the import's machine listing. Reading the
log takes no lock, and nothing it does reaches boxd or a machine.
