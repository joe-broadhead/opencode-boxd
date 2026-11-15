<!-- A copy of the reviewed design (rounds 1 to 5 passed), kept with the code it describes. The packages build against it;
a change to the design is made here, in the same pull request as the code it changes. -->

# opencode-boxd v0.1.0: the design

Status: proposal for the owner. Basis: `origin/master` at `024d946` (v0.0.6, kit r4.1). The local clone's `master` is
31 commits behind it; every `file:line` below is in `origin/master`. Inputs: issues #1 and #14 (read-only), boxd's
`llms-full.txt` (fetched 15 Nov), and the OpenCode 2.2.3 and 2.3.0 plugin, client and core packages.

This release breaks compatibility on purpose. The tools, the result shapes, the ledger format, the options and the guest
helper all change. Running works are not stranded: the v0 ledger is imported (§6).

---

## Changes after review

### Round 1

Review: `reviews/wave-B/boxd-design.md` (3 HIGH, 9 MEDIUM, 8 LOW). Every finding is fixed below; none is argued out.

| Finding | Fix | Where |
|---|---|---|
| **H1** The import can strand works, or `ensure` can overwrite one | The import is built in `v1.importing/` under an import lock, gets a `complete` marker, and is renamed to `v1/` in one step. An unfinished staging folder is discarded and the import reruns. It aborts with no `v1/` when the region listing fails. Every tool answers `LEDGER_IMPORTING` until the import is complete. A work whose v0 record failed to import is blocked for `ensure`. `regionGuessed` is gone. | §2.2, §3.4, §5, §6.1, §7.1 |
| **H2** Machines are targeted by name, and "gone" is decided per region | Every work records `machineId`. Before every change the name is resolved to that id (`machine get`), and the CLI acts by id. "Gone" needs a fresh, uncached all-region listing with no `oc-<id>` **and** a not-found `get` of the recorded id in every region. | §2.2, §3.9, §3.10, §4.1, §5 |
| **H3** `boxd_golden({ from: { workId } })` bakes a work's secrets into images | Removed. Customisation is `goldenBase` plus `goldenSetup`. The base path scrubs the password, the env file and the sessions too. The canonical image is replaced only by an explicit `rebuild: true` of the same recipe. | §2.3, §3.11 |
| **M1** Reads could wake a machine or keep it awake | Runner invariant: a read-side guest exec runs only for a machine shown `running` by a listing at most 2 s old. Status and the watcher never read the guest of a work whose cached phase is `idle`, `ready` or `asleep`. | §3.1, §3.2, §3.13, §4.1 |
| **M2** Read tools would upload the helper and run `adopt` | Reads use only the helper already on the machine, the v0 one included, and never copy a file or write the ledger. Only changes upload or adopt. Host test with `access: "read-only"`. | §3.2, §3.3, §4.1, §6.3, §7.2 |
| **M3** `saved: fresh` trusted only laptop bookkeeping | Harvest records each session's last message id and update time. Drop's guard reads them back from the guest in its `git` exec, and refuses `NOT_SAVED` on any difference or any new session. | §2.2, §3.6, §3.9 |
| **M4** A long `boxd_exec` blocked its work, and twelve blocked the fleet | `boxd_exec` has its own lane (cap 4) and takes no machine lock. The machine lock covers mutating helper actions only. The lock order is written down. `setup` and `upgrade` have their own bounds. | §3.12, §4.1 |
| **M5** List-form time bounds could not hold | Waiting holds no item slot. A shared poll loop costs one spawn per poll. The bound is set below the host's measured call limit, and items still starting answer `starting`, not `cancelled`. | §4.2, §7.2 |
| **M6** Notices went to script sessions and cost turns | Only a model-path call, or an explicit `notify: "<sessionID>"`, subscribes. A missing target is dropped and recorded in health. A coordinator gets at most one notice per 60 s. Q2 keeps `"wake"` as the recommendation, with the reviewer's `"queue"` recorded. | §3.5, §3.13, §10 |
| **M7** `attention` was unbounded | `limit` (default 25), worst first, `more`, and `groups` for repeated causes. `lastText` is cut to 200 characters and labelled untrusted. | §3.1 |
| **M8** Package boundaries blurred | D owns `boxd_status`, `boxd_job` and the watcher. A owns the stall test (fake spawn) and the spawn-count harness. Every tool owner asserts its §4.4 row. C is split into C1 and C2, and the lead owns the registry skeleton on Day 0. | §9.1 |
| **M9** Going back to v0.0.6 is unsafe after v1 changes | The doc says so, v1 writes `works/README-MOVED-TO-v1`, and the CHANGELOG states the rule. | §6.1, §9.3 |
| **L1** | The laptop CLI 0.3.5 has `machine label set`: `reassign` relabels, and upstream ask 12 is dropped. | §3.10, §8 |
| **L2** | `boxd_exec` quotes each argument for the remote shell and uses non-`--json` mode. Plain secrets are visible to it. | §3.12 |
| **L3** | Userinfo is stripped from git remotes, as v0.0.5 does. | §2.2 |
| **L4** | The git token is argued out: credentials come from boxd's git integration or a host-bound secret. | §3.4 |
| **L5** | `cost` per work in `view: "all"` and `attention` with `include: ["cost"]`; `null` for a member. Live check L3 needs an owner or admin key. | §3.1, §7.3 |
| **L6** | A cursor older than the retained log answers `cursorExpired: true` with the full view. | §3.1 |
| **L7** | `boxd_golden({ prune: true })`; status lists unused images. Note on the builder label. | §2.3, §3.11 |
| **L8** | v0.0.0 had the same unbounded fan-out; #14's note that the same spawns from a separate process did no harm is cited. `session delete` on an unknown id exits 1, so harvest treats that as "absent". | §0, §3.6 |

### Round 2

Re-review: all 20 round-1 findings verified fixed; 3 new MEDIUM and 8 LOW. Every one is fixed below; none is argued
out.

| Finding | Fix | Where |
|---|---|---|
| **M-a** Harvest wrote over the last good export, and the import's hard links reached the v0 tree | Each export, patch and untracked set is copied to a temp file beside the old one, its size and sha256 verified, then renamed over it; `saved` changes only after the whole tree is swapped in. A failed copy leaves the old file as it was. Every ledger write is copy-on-write (temp, then rename; nothing is written in place), and the import copies, never hard-links. | §2.2, §3.6, §6.1, §7.1 |
| **M-b** `"wake"` notices could wake a finished subagent session | The target is the root coordinator that started or last drove the work: `ctx.session.get` and a walk up `parentID` (also from Code Mode, which is the model path), recorded at each model-path `ensure` and `submit`. The target is checked again at delivery: gone, archived or re-parented → no notice; a refused wake → one queue-only post, then dropped. Events stay in the log. | §3.5, §3.13, §7.1, §7.2 |
| **M-c** The `auth.json` refusal was not stated as a rule | §2.3 states it: model credentials are never baked into an image, because an image reaches every work and everyone who can boot it. The supported ways are a sealed host-bound `boxd env` secret, a secret per provider, or `opencode auth login` on one work's own machine. New code `GOLDEN_HAS_CREDENTIAL` with that `next`; a build with no provider secret warns `NO_MODEL_CREDENTIAL`. Docs plan, CHANGELOG and Q1 updated. | §2.3, §5, §9.1, §9.3, §10 |
| **L-a** One fixed staging name; the blocked-id rerun | Each run has its own staging folder `v1.importing-<pid>-<rand>/`, and the lock token is checked before the rename. The blocked-id rerun takes the import lock and the work's lock and writes copy-on-write into `v1/`. | §2.2, §6.1, §7.1 |
| **L-b** `ensure` adopted any `oc-<id>` | Adoption needs `owner=opencode-boxd`, or v0's `role=session` with `work=<id>`; otherwise `adopt: true`. | §3.4, §7.1 |
| **L-c** Code Mode and RPC subscriptions | Code Mode is the model path (2.3.0 core), with a host test. An RPC submit without `notify` keeps an earlier subscription. | §3.5, §7.2 |
| **L-d** `updated` can move with no new message | Drop compares the last message id and the message count; `updated` is a hint only. | §2.2, §3.9, §7.1 |
| **L-e** `B` must bound single calls too | Every call stops waiting at `B` and answers `creating`/`starting`. The clone runs detached on the guest, so stopping never kills it, and the next call joins it. | §3.4, §4.1, §4.2, §7.1 |
| **L-f** Notice codes could carry guest strings | Only §5 codes reach a notice; anything else becomes `RUN_FAILED`. | §3.13, §7.1 |
| **L-g** Reads use the name | Stated, and harmless to data; once U14 puts `id` in the listing, reads compare it and answer `NOT_OURS`. | §4.1 |
| **L-h** Lock order for two work locks; locks keyed by name | Work locks in sorted id order, then machine locks; machine locks keyed by `machineId`. | §2.2, §4.1, §7.1 |

### Owner request

| Request | What changed | Where |
|---|---|---|
| **Owner: cost and cleanup.** The plugin must make agents clean up machines to save cost. | **§C, new:** boxd's real rates and states. Idle running costs about what standby costs, because both bill resident RAM; only hibernation saves, about 24× (this corrects the request's premise). **Layer 1:** set at creation: auto-suspend **off** (argued: it saves almost nothing), auto-hibernate 2 h, `idle.ignore-outbound` off, and an opt-in `leaseDays`. **Layer 2:** the watcher harvests and then sleeps finished and orphaned works after `autoSleepMinutes` (10). It skips works waiting on a person, never drops, and runs as a single owner. **Layer 3:** the `context`, `compaction` and `experimental.idle` hooks and the session events, checked on the 2.2.3 and 2.3.0 types, with their token cost stated; `cost` and `cleanup` blocks in status; `select` on sleep, harvest and drop. **Layer 4:** `/boxd-cleanup` (confirmation reworked in round 4, below); a Cost row; `budget` with `BUDGET_REACHED`. The budget is in the org's billing currency rather than "dailyUsd", and the reason is stated. | §C, §3.1, §3.4, §3.6–§3.9, §3.13, §5, §7.1, §7.2, §7.3, §9.1, §9.2, §9.3 |

### Round 4 (§C review)

The review confirmed the billing premise (standby bills resident memory, so the defaults stay) and the hook shapes.
Its 3 MEDIUM and 5 LOW findings are fixed below; none is argued out.

| Finding | Fix | Where |
|---|---|---|
| **M-1** The context line in `system` broke the prompt cache for the whole history | `system` is never touched and stays byte-identical. The line goes on the tail of the request's `messages`: a part on a final `user` message, or one `user` message after a final `tool` message. The change applies to the request only, never to the stored history. It is added only on the first request after the coarse fleet fingerprint changes. Neither host exposes a reminder mechanism to plugins; this was checked. Cost: about 50 tokens per change, on the uncached tail, and zero otherwise. The compaction part also moves to the tail. | §C.4, §7.1, §7.2 |
| **M-2** Automation changed things without asking at `ask-changes` | Automation is on by default only at `access: "all"`. At `ask-changes` and `read-only` it is off unless the person writes `automation: "on"` in the plugin config, which is documented as their consent. The creation settings (auto-hibernate 2 h and the rest) apply at every level, as part of the machine the person asked for. `jelly.cost`, `docs/jelly.md`, the skill and status say so. | §C.2, §C.3, §C.7, §3.14, §9.2, §9.3 |
| **M-3** The `/boxd-cleanup` plan code was visible to the model, and the confirm path failed at `ask-changes` | Plan codes are removed. Each action is confirmed by `ctx.permission.assert` with no `source` (optional on both hosts), which raises the host's permission prompt for the person. That prompt is not a session message. At `ask-changes` the asserted action is the tool's own, so its ask is the one confirmation. At `all` it asserts `boxd_cleanup`, which the default rules set to ask. At `read-only` the command only reports. Actions run in-process, not through the tools RPC. The plugin API has no form-creating method on either host, so `assert` is the person-only channel. | §C.5, §C.7, §7.1, §7.2, §9.1 |
| **L-1** The budget let `submit` and `exec` wake machines | `refuse` also covers `boxd_submit` to a hibernated work and `boxd_exec` with `wake: true`. A call on an already running machine passes, and the reason is stated. | §C.5, §5, §7.1 |
| **L-2** A watched-only busy work could hit its lease | The automation owner renews leases of busy or unsaved works while the plugin runs, so only an absent laptop lets one expire. `leaseDays` is itself the consent. | §C.2, §7.1 |
| **L-3** The in-VM AGENTS.md misstates standby billing | Upstream ask 16. | §8 |
| **L-4** The idle-check loop guard had no mechanism | Notes are tagged `metadata: { boxd: "idle-check", id }`. The next idle hook reads the newest input with `ctx.session.context` and stays silent on its own note. Loop tests cover it. | §C.4, §7.1, §7.2 |
| **L-5** The D→E interface was not in Day 0 | `WorkEvent` and `subscribe` are in Day 0's `src/ports.ts`. | §9.1 |

---

## 0. What we found in the current code

These findings shape the design. They are facts, not opinions, and four of them are bugs to fix whatever else changes.

| # | Finding | Where | Evidence |
|---|---|---|---|
| F1 | **A second harvest does not refresh the laptop copy.** `opencode session import` on an id that already exists exits 0 with "Session already exists" and changes nothing. The prover treats that as success. After the first harvest, the laptop's OpenCode keeps the first transcript, and only the ledger's export file is current. | `src/prover.ts:24-25` | Reproduced on 2.2.6 in a temp HOME: second import kept `"first title"`. `opencode session delete <id>` and then `import` replaced it. |
| F2 | **Stop never reaches a tool.** `execute(value, context)` and the RPC `run(value, call)` ignore `context.signal` and `call.signal`, so a stopped call keeps its `boxd` children running. On 2.3 a tool that never reads the signal is interrupted, and its children are orphaned. | `src/tools.ts:328`, `:379` | 2.3.0 `ToolContext.signal` docs: reading it opts into a cooperative stop. |
| F3 | **Nothing caps the CLI processes.** Each `run()` spawns at once. `boxd_status` runs one `machine get` and up to one `machine exec` per work, all at once. A fresh `boxd_ensure` with `wait` makes 20–40 spawns. 24 parallel ensures make several hundred. | `src/run.ts:10`, `src/fleet.ts:419`, `:273` | #14 §3: 14–24 parallel calls stalled the server. |
| F4 | **"Missing" is guessed from loose stderr.** `isMissing` matches `unknown`, so an "unknown flag" or "unknown region" reads as a missing machine. It also matches `no machine "<name>" in fra` for a machine that lives in `nyc`: once works span regions, `ensure` would create a duplicate and `drop` would close a live work. | `src/cli-boxd.ts:148-149` | boxd docs: a name in another region gets an error in the current region. |
| F5 | **`queued: true` is wrong.** OpenCode's default delivery is `steer` (`delivery: input.delivery ?? "steer"` in core, 2.2.3 and 2.3.0). A prompt to a running session reaches it at the next step boundary, not after the run. | `guest/guest.py:185-186` | `@opencode/core` chunks; `SessionInbox.Promotable` docs. |
| F6 | **A laptop upgrade blinds the fleet.** `ready()` checks the exact guest version for every call, reads included, so after `opencode upgrade` on the laptop every `boxd_job` answers `GUEST_VERSION`. | `src/fleet.ts:172-190`, `:527` | |
| F7 | **Every call writes config twice.** `ready()` arms the awake bound (`config set` ×2) on each submit and harvest. boxd accepts `--auto-hibernate-timeout` and `--idle-ignore-outbound` at creation, a restore included. | `src/fleet.ts:187` | boxd docs, "Ignore outbound traffic". |
| F8 | **Exports pass through the server's memory.** Harvest parses, clones, re-stringifies and hashes each export on the server's thread. | `src/fleet.ts:560`, `src/transfer.ts:53`, `:63` | |
| F9 | **The CLI flavour check races.** The first N parallel calls each run `boxd --help`. | `src/cli-flavor.ts:24`, `:37` | |
| F10 | **`ledger.list()` reads every work file, dropped ones too,** on every status call. | `src/ledger.ts:156-161` | |
| F11 | **A size cannot be set at creation.** boxd refuses `--vcpu` with `--from-snapshot`, so the plugin resizes, which reboots, which triggered #14 §6. | `src/fleet.ts:363` | boxd docs, "Machine sizes". |

None of the code is synchronous file or process I/O, in v0.0.6 or in v0.0.0, which #14 ran. v0.0.0 has the same
unbounded fan-out: its `status()` maps every work to a `machine get` in one `Promise.all` (`v0.0.0:src/fleet.ts:179-181`),
and its ensure and submit paths make the same uncapped spawns. The stall in #14 §3 is therefore most likely F3
(hundreds of `fork`/`posix_spawn` calls from a large process, each one blocking the event loop briefly) together with
F8. One fact in #14 supports this: "the setup script preps many machines in parallel through the CLI, and that never
upset the laptop's server". The same spawns, from another process, did no harm. §4 fixes both and adds a measurement,
because this is an inference and must be proven. L12 first reproduces the stall on v0.0.6, so that "no stall on v0.1.0"
means something.

---

## 1. Principles

**Who uses it.** One coordinating agent on a laptop that drives 1 to 300+ works at once, usually from a Code Mode
program or a script through the tools RPC. A person watches through `/boxd-status` and the agent's reports. The owner is
the only user today.

**What "best" means here:**

1. **One call sees the fleet.** One `boxd_status` answers for 300 works in a few seconds and fits in a model's context.
   It lists only the works that need a decision, plus counts.
2. **No wasted turn.** A call that can finish its job in a bounded time does so: `ensure` waits until the work is
   ready, `submit` waits for a starting guest, and list forms do many works in one call. Nothing waits for a model.
3. **Every refusal says exactly what to do.** One result shape: `{ state, …, error?, message?, next? }`. `next` is one
   concrete call with its arguments, never "check status".
4. **Safe by default.** Unharvested work is never destroyed. A read never wakes a machine, never keeps an idle one
   awake, and never writes to a machine or the ledger. Every machine change asserts, and acts on the machine id the
   ledger recorded, never on whatever now holds the name. Stop cancels. A transient error never reads as "the machine
   is gone".
5. **Few spawns.** Every call has a CLI budget. The plugin counts its processes and never exceeds its cap.
6. **The laptop is the source of truth,** and now actually holds the latest transcript (F1).

**What we say no to:**

- Proxies, custom domains, raw ports. The guest port must never be published, and works don't serve traffic.
- The desktop and computer use. A guest session drives its own browser. The skill names `boxd machine desktop` for a
  person who wants to watch.
- `run` automations. They live inside machines. The coordinator is the scheduler.
- Checkpoints and backups. The laptop ledger plus git is the backup. A checkpoint restore would rewind a session under
  the ledger.
- Machine specs. The laptop CLI does not take one (upstream ask U11).
- `delete-after` on works **by default**. It destroys a machine whatever its unharvested state, so it is only an
  opt-in (`leaseDays`, §C.2), off by default. It is always used on golden-image
  builder machines, as a safety net.
- Sharing and `--isolated`. Both are refused, as today.
- Egress allowlists and networks per work. They are useful, but nobody has asked for them. They can come later as
  `ensure` fields without breaking anything.

---

## 2. The model

### 2.1 Words

| Word | Meaning |
|---|---|
| **work** | One task with one id (`^[a-z][a-z0-9-]{0,24}$`), one machine and one root session. The unit of every tool. |
| **machine** | `oc-<workId>` in the work's **region**, with boxd's machine **id**. Names are unique per region and can be moved (rename, adopt, by hand), so the ledger records the region and the id. Every CLI call passes `--region`, and every change acts by id after checking that the name still resolves to it (§4.1). |
| **region** | `fra` or `nyc`. Each has its own machine limit, its own snapshots and its own golden images. |
| **size** | `1x4`, `2x8`, `4x16` or `8x32` (vCPU × GiB), boxd's own spelling. |
| **golden image** | A snapshot named `<prefix>-<opencodeVersion>-<size>` in a region, such as `oc-golden-2.2.6-4x16`. A work is created from the one that matches its region, its size and the laptop's OpenCode. No create ever needs a resize (F11). |
| **session** | The guest's root OpenCode session, and its children. |
| **saved** | Whether this laptop holds the work: `fresh` (a harvest of an idle session ran after the last prompt), `stale` (a prompt came later, or the harvest was partial), or `none`. This replaces `proof`. #1 asked for a plain word, and "saved" says what it guards. |
| **phase** | What the work is doing now: `creating`, `starting`, `ready` (no prompt yet), `busy`, `idle`, `asleep`, `gone`, `unreachable`, `closed`. One vocabulary for every tool. |
| **outcome** | The last run's result: `completed`, `failed`, `aborted`, or `null`. |
| **notice** | A one-line message the plugin posts into the coordinator's session when a work changes phase (§3.13). |

### 2.2 The ledger, format 1

Location: `~/.local/share/opencode-boxd/v1/`. The folder is 0700 and its files are 0600, as today.

```
v1/
  works/<workId>/work.json        the record (below)
  works/<workId>/exports/<sessionId>.json   each harvested transcript, streamed from the guest
  works/<workId>/patch.diff       tracked changes at the last harvest
  works/<workId>/untracked/…      untracked files at the last harvest (now real files, not base64 JSON)
  events.jsonl                    phase changes, one JSON line each, with a sequence number; rotated at 5 MiB
  index.json                      a cache: workId → {state, region, phase, saved, mtimeMs}, rebuilt from work.json when stale
  import-v0.json                  the import report (§6): each work's result, and the blocked ids
  complete                        the import's marker; present in every published v1/
v1.importing-<pid>-<rand>/        an import run's own staging folder, only while that run is live (§6.1)
import.lock/                      the import's cross-process lock, only while an import runs
works/                            the v0 ledger, read by the import and never changed (apart from README-MOVED-TO-v1)
```

`v1/` exists only once complete: it is published by one rename (H1). A plugin start that finds no `v1/` imports
(§6.1) or, with no v0 ledger either, creates an empty `v1/` the same way.

`work.json`:

```jsonc
{
  "format": 1,
  "workId": "review-api",
  "state": "open",                       // "open" | "closed"
  "closed": { "at": "…", "how": "dropped" | "gone" | "reassigned", "to": "…" },   // when closed
  "region": "nyc",
  "machine": "oc-review-api",
  "machineId": "vm_…",                   // from `machine new --json` or `machine get --json`; every change acts on it (§4.1)
  "size": "4x16",
  "image": { "name": "oc-golden-2.2.6-4x16", "opencode": "2.2.6" },
  "laptopDirectory": "/…",
  "guestDirectory": "/home/boxd/work/review-api",
  "repo": { "url": "https://github.com/o/r", "ref": "main" },
  "git": { "name": "…", "email": "…" },   // the guest's git identity, never a token
  "model": "anthropic/claude-sonnet-4-5",
  "createdAt": "…",
  "session": { "rootId": "ses_…", "notify": "ses_<coordinator>" },
  "lastSubmit": { "at": "…", "delivery": "steer" | "queue" | "interrupt", "by": "ses_…" },
  "saved": { "at": "…", "complete": true, "guestVersion": "2.2.6",
             "sessions": [{ "id": "ses_…", "parentId": "ses_…", "sha256": "…", "bytes": 123,
                            "lastMessageId": "msg_…", "messages": 214, "updated": 1763200000000 }] },
                                                    // the guest's own marks: drop checks the id and count; `updated` is a hint (§3.9)
  "run": { "outcome": "completed", "error": "…", "at": "…" },
  "gitState": { "known": true, "remote": "https://github.com/o/r", "branch": "…", "sha": "…", "dirty": false,   // remote with userinfo stripped, as v0.0.5
                "patchStored": false, "untracked": [], "ignored": [], "untrackedStored": false },
  "files": { "in": [{ "path", "bytes", "sha256", "at" }], "out": [{ "path", "bytes", "sha256", "at", "laptopPath" }] },
  "slept": { "at": "…", "by": "boxd_sleep" },
  "pendingCreate": { "at": "…", "image": "…" },
  "pendingRename": { "from": "…", "machineId": "vm_…", "at": "…" },   // set by reassign before the rename (§3.10)
  "reboots": [{ "at": "…", "why": "agent-silent" }],
  "guestHelper": "v1" | "v0",            // "v0" until a v1 helper adopted an imported work (§6.3)
  "importedFrom": "v0"                   // only on imported works
}
```

Rules:

- **One writer per work, across processes.** Today's per-work lock lives in one process. Two OpenCode servers on one
  laptop (two projects) share the ledger. **Lock order** (round 2, L-h): a call that needs two work locks (only
  `boxd_reassign`) takes them in sorted work-id order, so two opposite reassigns cannot wait on each other. Work locks
  come before machine locks, and machine locks are keyed by `machineId`, not by name, because `rename` changes the
  name in mid-call. v1 takes a lock folder (`work.lock`, made with an atomic `mkdir`, holding the
  pid and the time; it is stale after 60 s without a heartbeat) for every write, with the per-process queue on top.
- **Atomic writes, never in place:** every ledger file, exports and patches included, is written as a unique temp file
  in the same folder, verified where it has a digest, fsynced, and then renamed over the old one. Nothing in v1 opens
  an existing ledger file for writing, except the append-only `events.jsonl`, which is only appended to (never
  rewritten, verified or hard-linked). That is the copy-on-write rule: even a file that shares its inode with
  another (a hard link) is replaced, never changed.
- **Reads are cheap:** `index.json` is refreshed only for files whose `mtimeMs` changed. Closed works are not loaded
  unless asked for (F10).
- **`saved` is computed:** `fresh` when `saved.complete && saved.at >= lastSubmit.at`; `stale` when `saved` exists but
  is older or partial; `none` otherwise. This is the laptop's bookkeeping, and prompts that bypass the plugin (a person
  on `boxd connect`, another laptop, a queued item the guest runs later) bypass it too. So `fresh` is enough for status
  and advice, but `boxd_drop` also checks the guest's own marks (§3.9).
- **Remotes:** a git remote is stored and returned without its userinfo, so a `x-access-token:<placeholder>@` never
  reaches a result (as v0.0.5 does).

### 2.3 Golden images

A golden image is built by the plugin, not by hand, in a fixed recipe (`boxd_golden`, §3.11):

1. `boxd machine new oc-gb-<region>-<size>-<rand> --region R --vcpu N --delete-after 2h --label role=golden-builder`.
   The base is either stock (a size is allowed there) or a named base snapshot, resized after the restore.
2. One `machine exec`: `opencode upgrade --major` when needed, then `opencode upgrade <laptop version>`. Check
   `opencode --version` and the server password (the golden page's 401/200 probe). Install the v1 helper in
   `~/.opencode-boxd/`. Run the user's `goldenSetup` script, when one is set.
3. **Scrub**, the same steps whatever the base: stop `opencode serve`; delete `/etc/profile.d/boxd-env.sh` (boxd
   regenerates it at every boot, the golden page step 4), `~/.opencode-boxd/password`, `~/.opencode-boxd/exports/`,
   `/tmp/opencode-boxd/`, and `/home/boxd/work/`. It refuses when the base's OpenCode database holds any session
   (`GOLDEN_BUILD_FAILED`: the base was a used machine rather than an image), and when
   `~/.local/share/opencode/auth.json` exists (`GOLDEN_HAS_CREDENTIAL`, below). The helper checks each step and reports
   what it removed.
4. `boxd snapshots save <builder> <prefix>-<version>-<size> --region R --json`, then remove the builder.

**Model credentials are never baked into an image** (round 2, M-c). An image reaches every work created from it, and
anyone in the org who can boot it. A key stored in the image's
`auth.json` would therefore reach every work and every person, could not be scoped or rotated per work, and would
outlive its rotation in every image that holds it. So a build refuses a base with an `auth.json`, whatever its
`goldenBase`, with `GOLDEN_HAS_CREDENTIAL`. This is a change from v0's `docs/golden-image.md`, whose fallback was
`opencode auth login` on the builder. The supported ways are, in order:

1. **A sealed `boxd env` secret, host-bound** (recommended): `boxd env set OPENCODE_API_KEY <key> --secret --domains
   <provider hosts> --scope private`. boxd injects it at every boot, the machine holds only a placeholder, and the real
   value is sent only to the provider's hosts. One rotation reaches every work. This is v0's documented primary path.
2. **A secret per work**, when works need different keys: a separately named secret per provider or team (for
   example `ANTHROPIC_API_KEY` for one and `OPENROUTER_API_KEY` for another) with the work's `model` choosing the
   provider. A secret listed only by the machines that need it waits on boxd's machine specs in the CLI (upstream ask
   U11).
3. **The provider's own sign-in on that one machine, on first use:** a person runs `boxd connect oc-<id>` and then
   `opencode auth login` (a login shell is needed; `machine exec --tty` exits silently, per v0's measurements). The
   credential then lives on that work's disk only, and goes when the work is dropped. It never reaches an image,
   because no image is ever made from a work (§3.11).

Before a build, `boxd_golden` checks the first path: when `env list --json` shows no secret that OpenCode reads as a
provider key (the names in `opencode auth list`'s environment section on the builder), the build still succeeds, but
its result carries `warning: "NO_MODEL_CREDENTIAL"` with the three ways above as `next`, and `boxd_status` repeats it.
It is a warning, not a refusal, because the third way is supported and happens after the build. A work without a
credential answers `GUEST_AUTH_FAILED` at its first prompt, with the same `next`.

The builder's labels are captured into the image, and restores inherit them merged under their own (boxd API). Works
set `role=session` themselves, so they override `role=golden-builder`; anything else that selects machines by that label
must know this.

An image is replaced only by `boxd_golden({ …, rebuild: true })`, which reruns this same recipe under the same name.
Nothing saves a work's machine as an image: v0's `boxd_image` path is removed (§3.11), so no work's checkout, session,
password or env file can reach another machine.

Images pile up, one per laptop version, size and region. `boxd_status({ include: ["images"] })` marks each image
`inUse` (recorded by an open work) or not, and `boxd_golden({ prune: true })` removes the unused ones that are not the
current version's. It never removes an image an open work records, because `boxd_resume` rebuilds from it.

A laptop upgrade makes a new image name, so old works keep their recorded image and new works get the new one. Images
are found with one `snapshots list --region all --json`, cached for 5 minutes.

The v0 option `snapshot` (default `opencode-golden`) names a hand-built image. v1 can use it as the **base** of a build
(`goldenBase`), so its customisations carry over. Snapshots don't cross regions, so a base snapshot only works in the
region it lives in, and `goldenSetup` is how the same customisation reaches `nyc`. Owner question Q1.

---

## 3. The tools

Twelve tools: three reads and nine changes. `boxd_image` is replaced by `boxd_golden`, which builds from a recipe and
never from a work. Every tool:

- returns one object. A single-work call returns `{ state, workId, machine, region, …, error?, message?, next? }`.
  A list call returns `{ state: "done" | "partial" | "failed" | "cancelled", counts: { <state>: n }, results: [ <one
  single-work result per item, in input order> ] }`. A refusal or failure keeps `state` (`refused`, `failed`,
  `unreachable`, `busy`, `starting`, `gone`, `asleep`, `cancelled`) beside `error`, `message` and `next`, plus any facts
  its code carries (`field`, `paths`, `count`, `kind`, `limit`).
- passes the call's `signal` (model path: `context.signal`; RPC: `call.signal`) to the runner (§4). On abort, children
  are killed (boxd then kills the remote command; boxd docs, the gRPC `Exec` notes), items not started answer
  `cancelled`, and a write that was in flight answers `cancelled` with `uncertain: true` and the read that settles it
  as `next`.
- asserts its action before any change, as today (`test/unit/tools.test.ts` stays the architecture test). A list call
  asserts once, with every work id as a resource.
- follows the runner's rules (§4.1): a change acts on the recorded `machineId` after checking the name still resolves
  to it; a read touches a guest only under the read rule, and never uploads or writes.
- answers `LEDGER_IMPORTING` while the v0 import is unfinished (§6.1), reads included.

The "CLI calls" columns give the steady-state budget: what one call costs when nothing goes wrong.

### 3.1 `boxd_status` — read

The fleet in one call. It never wakes, starts or runs anything.

Input:

```jsonc
{
  "view": "attention" | "all" | "counts",    // default "attention"
  "workIds": ["…"],                           // only these works
  "region": "fra" | "nyc",                    // only this region
  "since": 1842,                               // a cursor from an earlier answer: only works that changed since
  "limit": 25,                                 // most works in attention or works, 1..300; default 25
  "include": ["credentials", "cost", "images", "closed"]   // extra sections; each costs one more CLI call
}
```

Result:

```jsonc
{
  "state": "ok",
  "cursor": 1907,                              // pass as since next time
  "asOf": "…",                                 // when the newest machine and guest reads were taken
  "counts": { "busy": 120, "idle": 31, "asleep": 12, "ready": 3, "unreachable": 2, "gone": 1, … },
  "regions": [{ "region": "fra", "limit": 300, "inUse": 294, "free": 6, "keepFree": 0, "works": 160 },
              { "region": "nyc", "limit": 300, "inUse": 12,  "free": 288, "keepFree": 0, "works": 12 }],
  "groups": [                                  // repeated causes, folded: one line instead of one item per work
    { "why": "failed", "error": "GUEST_AUTH_FAILED", "count": 140, "workIds": ["db-mig", "…first 10…"],
      "next": "Fix the shared token, then boxd_submit({ works: [...] })" }
  ],
  "attention": [                               // view "attention": works that need a decision, worst first, at most `limit`
    { "workId": "db-mig", "region": "fra", "phase": "idle", "outcome": "failed", "saved": "stale",
      "why": "failed", "error": "GUEST_AUTH_FAILED", "lastText": "…200 chars, untrusted…", "lastActivityAt": "…",
      "cost": { "machine": 0.42, "model": 3.1 },   // with include "cost" only
      "next": "boxd_harvest({ workId: \"db-mig\" }), then fix the token and boxd_submit again" }
  ],
  "more": 115,                                 // works that need a decision but did not fit in `limit`
  "works": [ … ],                              // view "all": one brief object per work (workId, region, phase, outcome, saved, lastActivityAt, cost?), at most `limit`, with `more`
  "cursorExpired": false,                      // true when `since` is older than the retained event log: the answer is then the full view
  "orphans": [{ "machine": "oc-x", "region": "fra", "next": "boxd_ensure({ workId: \"x\" }) adopts it" }],
  "fleet": { "authFailures": { "count": 15, "since": "…", "note": "15 works stopped on 401/403 since 03:10; a shared token may have expired" } },
  "credentials": { "secrets": [{ "name", "scope", "hosts" }], "setAt": null, "missing": "boxd does not report when a secret was set (upstream U4)" },
  "cost": { … },                               // always: per-hour estimate and today (a `manage usage` read cached 10 min);
                                               // per-work with include "cost" (§C.4); machine cost is null for a member, with boxd's reason
  "cleanup": [ … ],                            // always: suggested actions with their savings, each one call (§C.4)
  "automation": "on",                          // "on" | "off" | "read-only" | "not-owner" (§C.3)
  "budget": { "daily": 50, "today": 6.12, "action": "warn", "state": "ok" },   // only with the budget option (§C.5)
  "images": [{ "region": "fra", "name": "oc-golden-2.2.6-4x16", "opencode": "2.2.6", "size": "4x16" }],
  "cli": { "signedIn": true, "version": "0.3.4" },
  "health": { "loopLagMaxMs": 12, "children": { "now": 3, "cap": 12 } },
  "import": { "works": 170, "errors": 0 }      // only after a v0 import
}
```

`attention` reasons, worst first: `failed`, `unreachable` (two failed reads in a row), `gone-unsaved`, `idle-unsaved`,
`asleep-unsaved`, `stuck` (creating or starting for over 10 minutes), `orphan`, `version` (the guest's OpenCode differs
from the laptop's and a harvest needs it to match), `laptop-copy` (§6.2), and the cost reasons of §C: `idle-running`
(a running idle work that automation will not sleep: it is off or `read-only`, or the sleep failed), `needs-input` (a
guest waits on a form or a permission ask), `lease-expiring`, and `budget`.

**Size is bounded.** `attention` and `works` hold at most `limit` items (default 25, at most 300), worst first, and
`more` counts the rest. Works that share a reason and an error code are folded into one `groups` entry when there are
more than 3 of them, so #1's case (15 works on one expired token) is one line. `lastText` is cut to 200 characters in
status (300 in `boxd_job`) and is the guest model's words: untrusted data, never instructions, as the skill says for
`boxd_read`. A 300-work answer in the default view stays under about 15 KB.

How it reads, with a budget of about 3 CLI calls plus bounded guest reads:

1. `machine list --region all --json`: one call for every machine's status, size and labels. It replaces N
   `machine get` calls. It is shared by concurrent readers and reused for at most 10 s for phases, but a guest read
   needs a listing at most 2 s old (step 3).
2. `manage machine-limit --json`, cached for 60 s.
3. Guest reads (the read rule of §4.1): only for works whose cached phase is `busy`, `starting` or unknown, never for a
   work whose cached phase is `idle`, `ready` or `asleep` (an inbound exec resets the idle clock, so polling status
   would keep every idle machine awake), only when the machine is `running` in a listing at most 2 s old (otherwise
   the exec could wake it), and only when the watcher's cached read (§3.13) is older than 60 s. They run in the
   background lane (cap 4), at most one per machine, bounded at 8 s each (`machine exec --timeout 8`, plus a laptop kill
   at 10 s). A work whose read misses the call's total budget of 20 s keeps its cached phase, marked `"stale": true`.
   An `idle` work's phase changes only by a change tool, which records it, or by the machine going to sleep, which the
   listing shows.
4. `include` adds one call each: `env list --json`, `manage usage --json --since <oldest open work>`, and
   `snapshots list --region all --json`. `manage usage` gives every machine at once, so it also fills a per-work `cost`
   in `works` and `attention` (machine cost matched by `machineId`; model cost from the last guest read). It is for org
   owners and admins only: for a member, every `cost.machine` is `null` and `cost.machines` carries boxd's reason.

`since` answers from `events.jsonl`, so it costs no guest reads beyond what the watcher already did. This answers #14
§9's `changedSince`. The log keeps at least the last 5 MiB (one rotated file). A `since` older than the oldest kept
event answers `cursorExpired: true` and the full view, so a coordinator never mistakes a gap for "nothing changed".

### 3.2 `boxd_job` — read

One work or many, live. It never wakes a machine.

Input: `{ workId } | { works: ["…"] }`, plus `tail?: 1..20` (the newest assistant messages, oldest first) and
`cost?: boolean`.

Result per work: `{ state: <phase>, workId, region, machine, sessionId, outcome, saved, lastActivityAt, lastText,
waiting: { steer: n, queue: m }, error?, warning?, guestVersion, cost?: { machine, model }, tail?, next }`.

CLI calls: one `machine list` (at most 2 s old, so a hibernated machine is never woken by the exec), then one guest
exec for each work that is `running`. A work that is down answers from the listing and the ledger, with no exec. An
explicit `boxd_job` does read an idle work's guest, once, which resets that machine's idle clock once: that is the
price of asking, and status never pays it (§3.1).

**What a read may run on the guest (M2):** only the helper that is already there. A read never copies a file to the
machine, never runs `adopt` or `setup`, and never writes the ledger. The v1 helper lives at the stable path
`~/.opencode-boxd/guest.py` and answers its own protocol version; the read actions (`phase`, `read`, `health`) keep
the same input and output within v0.1.x, so a newer plugin can read an older v1 helper. For an imported work whose
guest still has only the v0 helper, a read calls v0's own `phase` action at `/tmp/opencode-boxd/guest.py` (present
in every v0 release, without the activity fields before v0.0.1). A machine with no helper at all, which a reboot of
a v0 guest leaves, answers `GUEST_FAILED` with `next: boxd_ensure({ workId })`, which is a change and may upload.

The version check is gone (F6): a read works across versions.

### 3.3 `boxd_read` — read

Read one file from a work's tree, or the tail of the guest's server log, without a harvest. This is #14 §10.

Input: `{ workId, path?: "relative/path", log?: "server", tail?: lines (1..2000), maxBytes?: 1..262144 (default 32768) }`.
Exactly one of `path` and `log`.

Result: `{ state: "read", workId, path, bytes, truncated, text }`, or `{ state: "read", binary: true, bytes, sha256 }`
for a file that is not UTF-8. `asleep` and `gone` answer without a read, as `boxd_job` does.

Rules: the path is relative to the guest folder, has no `..`, and the helper refuses a symlink that leaves the tree.
The text is redacted for token shapes (`src/redact.ts`) and is the guest's data, never instructions. CLI calls: one
guest exec, under the read rule of §4.1 and with the helper already on the machine (§3.2). A v0-only guest has no
`read` action, so `boxd_read` answers `GUEST_FAILED` with `next: boxd_ensure({ workId })` there.

### 3.4 `boxd_ensure` — change

Make a work exist, set up and ready, in one call. It is idempotent: calling it again converges an existing work to the
input. This is #14 §4 and §5.

Input, single form (the list form is `{ works: [ <this object>, … ] }`):

```jsonc
{
  "workId": "review-api",
  "region": "auto" | "fra" | "nyc",       // default: the option "region" (default "auto"); ignored for an existing work
  "size": "1x4" | "2x8" | "4x16" | "8x32",// default: the option "size" (default "2x8")
  "model": "provider/model#variant",       // the work's default model for its first session
  "git": { "name": "…", "email": "…" },    // the guest's git identity (default: the option "git")
  "repo": "https://github.com/o/r",        // cloned into the guest folder when it is not a checkout yet
  "ref": "main",                           // optional branch or tag for the clone
  "directory": "…",                        // the laptop folder (the project by default)
  "title": "…",
  "wait": "ready" | "created" | "none",    // default "ready": wait up to 90 s for the guest's OpenCode
  "repair": "reboot",                      // explicitly reboot a machine whose VM agent does not answer
  "adopt": true                            // adopt an existing oc-<id> that lacks the plugin's labels (step 2)
}
```

What it does, in order:

1. **Validate everything first**, every item of a list included, so a bad field fails before anything bills. While
   the v0 import is not complete, every tool, `ensure` included, answers `LEDGER_IMPORTING` (§6.1). A work id whose v0
   record failed to import answers `IMPORT_V0_FAILED`: `ensure` never opens a fresh record over a work the import
   could not read.
2. **Find the machine.** For a known work, read its recorded region and id. For a new one, look for `oc-<id>` in every
   region (a listing taken in this call), so a machine left by a timed-out create, or renamed by hand, is adopted; its
   id is read with `machine get --json` and recorded before anything else. Two machines with that name in two regions
   answer `NOT_OURS` with both regions named. **Adoption needs the plugin's labels** (round 2, L-b): `owner=opencode-boxd`
   (v1), or `role=session` with `work=<id>` (what v0 set). A machine with neither answers `NOT_OURS`, and is adopted
   only with `adopt: true` in the input, so setup, a clone, a resize or a reassign never lands on someone else's
   machine that happens to have the name. An adopted machine gets the v1 labels.
3. **Pick the region** (`auto`): the region with the most free machines after `keepFree`, counting this process's
   creates still in flight. Prefer a region that already has the golden image for this size, unless the other region
   has 50 or more free machines than it. When every region is full: `MACHINE_LIMIT` with `limit`, `inUse` and `free`
   per region, and `next` saying the other region if it has room, or else the owner's
   `boxd manage machine-limit request --max-vms <n>` (#14 §2).
4. **Find the golden image** `<prefix>-<laptop version>-<size>` in that region. When it is missing and the option
   `buildGolden` is `"auto"` (the default), build it (§2.3). A build for one region and size is shared by every call
   that needs it at once (single flight). With `buildGolden: "never"`: `GOLDEN_MISSING`, and `next` is the
   `boxd_golden` call.
5. **Record the intent** (`pendingCreate`) before the create, as today.
6. **Create:** `machine new oc-<id> --region R --from-snapshot <image> --label role=session --label work=<id>
   --label owner=opencode-boxd --auto-suspend-timeout 0 --auto-hibernate-timeout 7200 --idle-ignore-outbound=off
   [--delete-after <leaseDays>d] --json`. The size comes from the image, so nothing reboots, and the cost bounds of
   §C.2 are set in the same call (F7). Before the create, a `budget` with `action: "refuse"` that is reached answers
   `BUDGET_REACHED` (§C.5). A refusal for the limit is
   recognised from boxd's own words (§5, live check L5), and answers `MACHINE_LIMIT` before the CLI's raw text. The id
   in `machine new --json`'s answer is recorded at once, before any other step can fail.
7. **One guest exec does all the setup** (helper action `setup`): copy the v1 helper first when the machine lacks it or
   has an older one (a change may upload; a read may not), start `opencode serve` when it is not running, report its
   version, make the guest folder, clone `repo`, set `git config --global user.name/user.email`, and report the
   server's state. This is one spawn where today there are seven. A clone of a large repository can take minutes, so
   `setup` starts it **detached on the guest** (its own process group, a 300 s timeout of its own, output to
   `~/.opencode-boxd/setup.log`) and returns at once with `cloning`. The wait (step 8) polls its progress. Stopping a
   wait, or a call reaching `B` (§4.2), therefore never kills a clone half-way, and the next call joins the same clone.
8. **Wait** (`wait: "ready"`): poll the helper's cheap `serve` check every 3 s until the server answers, for at most
   90 s. A poll is one short process and holds no list-item slot (§4.2). The signal stops it.
9. **Converge an existing work:**
   - Asleep: wake it (`machine wake`), then go on to step 7.
   - Another `size` asked for: resize only when the session is not busy. Resize answers `SESSION_BUSY` otherwise.
     After a resize, the VM agent check below applies.
   - Its guest OpenCode differs from the laptop's: when the session is not busy, upgrade it in place (helper action
     `upgrade`: `opencode upgrade <version>`, then restart `serve`, with its own bound of 180 s); the session database
     stays on disk. When busy, the work stays usable for reads and prompts, and harvest answers `GUEST_VERSION` with
     this as its `next`.
   - An imported v0 guest: run `adopt` (§6.3), which is a change and happens only here or in another change tool.
   - `model`, `git` and `repo`: applied as for a new work. A `model` change is recorded as the work's default; the
     running session keeps its model until `boxd_submit` passes one.
10. **A VM agent that does not answer** (stderr `cannot connect to VM agent`, #14 §6): when the plugin resized or
    created this machine in the last 10 minutes and has not rebooted it since, run `machine reboot` once (recorded in
    `reboots`), and wait again. Otherwise answer `AGENT_UNREACHABLE`, whose `next` is
    `boxd_ensure({ workId, repair: "reboot" })`. A reboot loses running processes, so the plugin only reboots on its
    own when nothing can be running yet.

Every resize, reboot, wake or rename in these steps first checks that `oc-<id>` in the work's region still has the
recorded `machineId`, then acts on the id (§4.1).

**Git identity, not a git token** (#14 §4 asked for both). The plugin sets `user.name` and `user.email` and never
handles a token. A guest pushes with boxd's own git integration (`boxd manage integrations connect git`, on private
machines) or with a host-bound `boxd env --secret` that only reaches `github.com`. Either way the token never passes
through the laptop, a prompt, a transcript or the ledger. A token in `ensure`'s input would land in the tool call's
recorded arguments. Refreshing short-lived tokens is upstream ask U2.

Result: `{ state: "ready" | "starting" | "creating", workId, region, machine, machineId, size, image, guestVersion,
model?, created: bool, adopted?: bool, upgraded?: bool, rebooted?: bool, next }`.

CLI calls for a new work, steady state: 1 create + 1 to 3 setup execs, plus 1 copy of the helper when the image lacks
it. Today it is 20 to 40.

### 3.5 `boxd_submit` — change

Admit a prompt. It returns when the prompt is admitted, not when the model finishes.

Input: `{ workId, text, mode?: "steer" | "queue" | "interrupt", model?, files?: [{ from, to }], title?,
notify?: boolean | "<sessionID>" }`, or `{ works: [ … ] }`.

`mode`: this is #14 §8, built on what OpenCode 2.2 and 2.3 actually offer. `POST /api/session/<id>/prompt` takes
`delivery: "steer" | "queue"`, and `POST /api/session/<id>/interrupt` exists.

| mode | What OpenCode does | When to use it |
|---|---|---|
| `steer` (default) | The prompt is promoted at the running session's **next step boundary**: after the current model step and its tool calls return. An idle session starts on it at once. | Redirect a work without stopping it. This is already what v0 did, and v0 wrongly called it `queued` (F5). |
| `queue` | The prompt waits until the run ends and the session goes idle. | Add the next task after the current one. |
| `interrupt` | The plugin interrupts the run (`/interrupt`), then admits the prompt, which starts at once. The current step's tool calls are aborted. | Reach a session that is stuck inside one long tool call (a subagent, `gh pr checks --watch`, a `sleep` loop): `steer` cannot reach it until that call returns. |

This is honest about the limit: OpenCode has no way to inject text into a step that is running. #14's "queued prompt
waited for hours" was a step blocked in a long tool call. `steer` lands when that call returns, and only `interrupt`
lands sooner.

`model`: a new session starts on it, and an idle session switches to it. A running session switches only with
`mode: "interrupt"`, and otherwise answers `SESSION_BUSY` (the switch would change the task under way).

`notify` decides which session gets the work's notices (§3.13). The rule is: **the coordinator that started or last
drove the work** (round 2, M-b).

- **Model path** (a tool call in a session, which includes Code Mode: OpenCode 2.3.0's core runs a Code Mode tool call
  through the same `execute` with the calling session's `context`): the default `true` means the **root of the calling
  session's tree**. The plugin reads `ctx.session.get(context.sessionID)` and follows `parentID` to the session that
  has none, at most 16 steps. A subagent (task tool) session has a parent, so a submit made from a subagent subscribes
  the coordinator above it, never the subagent itself, which has already reported and gone idle. The root is recorded
  as `session.notify` on every `ensure` and `submit` from the model path, so it is always the one that last drove the
  work.
- **Tools RPC** (a script): the default is no change to the subscription, because the caller's session is the script's
  own. A script's submit without `notify` leaves an earlier subscription in place, so a script can keep driving a work
  that a coordinator watches. `notify: "ses_…"` names a session explicitly, and `false` clears the subscription.
- **An explicit session that has a parent** is resolved to its root too, by the same walk: a notice never goes to a
  subagent session.
- If `ctx.session.get` fails when the subscription is recorded, the call keeps the previous subscription and records a
  health note; it never subscribes a session it could not check.

The work must be up. A starting guest is waited for, up to 45 s, and then the call answers `starting` with
`next: boxd_submit again`. The machine is probed fresh once before any refusal (#14 §5: no stale `MACHINE_STARTING`).
A hibernated machine is woken, because a submit is a decision to spend.

Result: `{ state: "admitted", workId, sessionId, delivery: "steer" | "queue" | "started", interrupted?: true,
inboxId, waitingBefore: n, model?, files?, next }`.

CLI calls: one guest exec (helper action `prompt`, which creates the session when needed, switches the model, interrupts
and admits), plus one `machine cp` per file and one `mkdir`, which the `prompt` exec does too.

### 3.6 `boxd_harvest` — change (writes the laptop)

Bring the work's transcript and files to this laptop.

Input: `{ workId, files?: ["…"], to?, localDirectory?, partial?: boolean }`, or `{ works: [ … ] }`, or
`{ select: "unsaved-finished", dryRun? }` (§C.4). The automation loop harvests through the same code (§C.3).

Flow:

1. The session must be idle, or `partial: true`. A partial harvest stores and imports what exists now, and leaves
   `saved` as `stale`: it is a copy, not a reason to drop.
2. The guest helper (`export`) writes each session in the tree to `~/.opencode-boxd/exports/<id>.json` on the guest,
   and answers with ids, parent ids, sizes, sha256, and each session's last message id, message count and
   `time.updated`, which
   `saved` keeps for drop's check (§3.9). The laptop never parses a transcript (F8).
3. **The last good export is never overwritten before the new one is verified** (round 2, M-a). For each session:
   `machine cp <machine>:<file> <ledger dir>/exports/.<id>.<rand>.tmp`, beside the stored export. boxd writes the
   file, so the bytes never pass through the server. The laptop then checks the size and streams the sha256 against
   what the helper reported. Only a verified file is fsynced and `rename`d over `exports/<id>.json`, which is atomic
   and replaces the directory entry, so a hard link to an older file (§6.1) is broken rather than written through. A
   `cp` that is cut off, times out or has the wrong digest deletes its temp file, leaves the stored export as it was,
   and answers `EXPORT_INVALID` or `TIMEOUT`. `saved` is updated only after every file of the tree has been swapped
   in, so `boxd_resume` always rebuilds from a complete, verified set.
4. **Import replaces** (F1): parents first, `opencode session delete <id> --standalone`, then
   `opencode session import <file> --directory <dir> --standalone`. `delete` of an id the laptop does not have exits 1
   (2.2.3, 2.2.6, 2.3.0); that exit, with its not-found words, means "absent" and the import goes ahead, and any other
   failure stops with `IMPORT_FAILED`. Imports run under their own cap of 2. A failure
   leaves the ledger's file in place, and the next harvest retries.
5. Git (helper `git`): the patch and the untracked files are written on the guest and copied the same way: to a temp
   file, verified, then renamed over the old one. `untracked/` is built as `untracked.<rand>.tmp/` and swapped in with
   one rename (the old folder is removed afterwards), so a cut-off copy never leaves a half-replaced set.
6. The `files` asked for are copied back, through a temp file and a rename, as today.
7. `saved` is recorded under the work's lock.

Result: `{ state: "saved" | "partial", workId, outcome, sessions: [{ id, bytes }], git, files?, next }`.
`next` says what drop will do, as `dropAdvice` does today.

### 3.7 `boxd_sleep` — change

Hibernate. It always works, saved or not, and records a warning when the last prompt is not saved. It also takes
`select: "idle" | "finished"` and `dryRun` (§C.4), and the automation loop calls the same code (§C.3). Input:
`{ workId } | { works } | { select, dryRun? }`. CLI calls: one `machine hibernate <machineId>`. No config write: the
platform bounds are set once at creation (§C.2) and survive hibernate and wake.

### 3.8 `boxd_resume` — change

Wake a hibernated machine, or rebuild a destroyed one from its image and the saved transcript, as today. A reached
`budget` with `action: "refuse"` answers `BUDGET_REACHED` before it wakes or creates anything (§C.5). It imports
the stored exports into the new guest (helper `import`, from files copied up with `machine cp`). Input:
`{ workId } | { works }`.

### 3.9 `boxd_drop` — change (destructive)

Destroy the machine and close the work. The guard is today's, plus a check against the guest itself:

1. `saved: fresh`, a known git tree, and every untracked or ignored path harvested at the digest the guest still has.
2. **The guest agrees** (M3). The same helper exec that reads git (`git` action) lists the guest's sessions with each
   one's last message id and message count. Drop refuses `NOT_SAVED` when any session in the saved tree has a
   different last message id or a different message count than the harvest stored, or when the guest has a session
   under the root that the harvest did not save. `time.updated` is only a hint (round 2, L-d): it also moves for a
   title, a rename or metadata, with no new message, so a later `updated` alone does not refuse. That keeps drop from
   refusing in a loop after every harvest, while any new message or session still refuses. So a prompt that bypassed the plugin (a person on `boxd connect`, another laptop, a
   queued item that ran later) blocks the destroy, as an unharvested plugin prompt does.
3. **The machine is still ours** (H2). `machine get <name> --region R --json` must return the recorded `machineId`.
   Then `machine remove <machineId> --region R -y`, by id. A name that now points at another machine answers
   `NOT_OURS` and removes nothing.

New (#14 §7): **a work whose machine is gone closes,** under two checks, both made in this call and never from a
cache (H2):

- a fresh `machine list --region all --json` shows `oc-<id>` in no region, and
- `machine get <machineId> --region <r> --json` answers boxd's exact not-found words (§5) in every region, so a machine
  that was renamed by hand is found under its new name.

Then `drop` destroys nothing (there is nothing left to destroy), keeps every laptop file, and closes the record with
`closed.how: "gone"`. When the last prompt was not saved, the result says what was lost:
`lost: "the prompts after <saved.at> were never harvested"`. A listing or `get` that fails, or answers anything other
than not-found, keeps the work open with `BOXD_FAILED`: an error is never read as "gone". A work with no recorded
`machineId` (an imported work whose `get` failed at import) closes as gone only with `confirmGone: true`, and the
answer without it says so. A machine found under another name answers `NOT_OURS`, naming it.

Input: `{ workId, confirmGone?: boolean } | { works } | { select: "saved-finished", dryRun? }` (§C.4: the guard runs
per matched work, and nothing automatic ever drops). Result: `{ state: "dropped" | "closed", workId, machine, lost? }`.

### 3.10 `boxd_reassign` — change

Move an unstarted work's machine to another work id. This is #14 §7: free capacity at the limit without a destroy and
create.

Input: `{ from, to, directory?, repo?, ref?, model?, git?, title? }`.

Refused (`NOT_REASSIGNABLE`) unless `from` has no session, no uploaded files, and a clean or absent git tree, and `to`
is not an open work. Then: check that `oc-<from>` still has `from`'s `machineId`, `machine rename <machineId> oc-<to>
-y --region R` (by id; it reboots), `machine label set <machineId> work=<to> --region R` (the laptop CLI 0.3.5 has
it), close `from` with `closed.how: "reassigned", to`, open `to` with the same `machineId`, and run `ensure`'s setup for
`to`. The `to` record is written before the rename and the `from` record closed after it, both under their locks, so
a crash between them leaves `to` open with `pendingRename` and the next `ensure` for either id finishes it. Answers
like `boxd_ensure`.

### 3.11 `boxd_golden` — change

Build, or list, golden images. It replaces `boxd_image`.

Input: `{ region?: "fra" | "nyc" | "all", size?: <size>, from?: "stock" | "<base snapshot>", rebuild?: boolean,
prune?: boolean }`. With no input, it builds the default size in every region that lacks one.

There is no `from: { workId }` (H3). Saving a work's machine would carry its checkout, its session database, the
guest password and whatever the session wrote into every later work, and under the canonical name it would replace
the real image for every `auto` create. Customisation goes through `goldenBase` and `goldenSetup`, which every build
scrubs (§2.3). A person who wants a work's machine as an image does it with the boxd CLI, under their own name, which
`ensure` never picks: it picks only `<prefix>-<version>-<size>`.

`rebuild: true` reruns the recipe under the same name. Without it an image that exists answers `present`. `prune: true`
removes the images that no open work records and that are not the current version's (§2.3), and lists them.

Result: `{ state: "built" | "present" | "pruned", images: [{ region, name, opencode, size, seconds }], removed? }`. A
build takes about 1 to 2 minutes, which is measured in live check L7. The signal stops it, and the builder machine's
`delete-after` timer removes it even if the laptop goes away. Waiting for a build that another call started holds no
runner slot and no machine lock (§4.1).

### 3.12 `boxd_exec` — change

Run one command on a work's machine, with a timeout, for what the tools don't cover: `free -m`, `gh pr view`, a test
run. #1 found agents doing this by hand, and on macOS without `timeout`. Once works span regions, a bare
`boxd machine exec oc-x` misses `nyc` machines.

Input: `{ workId, command: ["argv", …], timeout?: 1..600 (default 60), wake?: boolean }`.

Result: `{ state: "ran", exitCode, stdout, stderr, truncated }`: the last 32 KiB of stdout and 8 KiB of stderr, with
the update banner removed and redacted. It refuses a hibernated machine unless `wake: true`. It passes
`machine exec --timeout`, so boxd kills the remote command. It is a change (`readOnly: false`) because a command can do
anything.

**Its own lane** (M4): `boxd_exec` runs in an exec lane with a cap of 4, outside the 12 runner slots, and it never
takes the machine's helper lock. A ten-minute `gh pr checks --watch` therefore blocks neither the work's `submit`
(`interrupt` included), nor its reads, nor the watcher, nor other works' tools. A fifth `boxd_exec` waits in its lane.

**Quoting** (L2): the remote side runs the command through a shell ("shell constructs work", boxd docs). The plugin
quotes each argv element in single quotes (with `'` written as `'\''`) and joins them, so `["grep", "a b", "f;rm"]`
means exactly those three arguments. It runs without `--json`, because `--json` merges stdout and stderr into one
`output`. **Plain secrets are visible:** a `boxd env` secret that is not host-bound is a real value in the guest's
environment, so `boxd_exec({ command: ["env"] })` prints it. `redact.ts` catches only known token shapes. The skill
says so, and recommends host-bound secrets.

### 3.13 Notices (no tool)

This is #14 §9's first option. A **watcher** in the plugin runs while any open work is `busy`, `creating` or
`starting`:

- Every 60 s, or twice the last sweep's duration if that is longer: one `machine list --region all --json`, then one
  `phase` read (helper action `phase`, read-only) for each busy work that the listing just showed `running`, in the
  background lane (cap 4, one per machine), under the read rule of §4.1. It never reads an idle or asleep work,
  because an inbound exec resets the machine's idle timer, and it never uploads anything.
- A change of phase is appended to `events.jsonl`: `idle` (with outcome), `failed` (with code), `asleep` (with
  `asleepBy`), `gone`, `ready`, or `unreachable` (after two failed reads in a row).
- **Who gets them** (M6, round 2 M-b): only the session in `session.notify`: the root coordinator that started or last
  drove the work, resolved by walking `parentID` (§3.5). Never a subagent session, and never a script's own session
  by default.
- **Checked again at delivery:** just before posting, the plugin reads the target with `ctx.session.get`:
  - not found or deleted → **no notice**: it is dropped, `notify` is cleared on every work that named the session,
    and `health.notices` records it;
  - archived, or with a `parentID` (a session moved under another since) → **no notice**, the same way;
  - a `wake` that OpenCode refuses (a conflict, the session ended or locked) → posted once more with `resume: false`
    (queue only), and if that fails too, dropped as above.

  The events stay in `events.jsonl` in every case, so `boxd_status({ since })` loses nothing.
- **How often:** changes are coalesced per target session, and a target gets **at most one notice per 60 s**. One
  notice names at most 20 works, then "and N more", and points at `boxd_status({ since })`. At 300 works in trouble at
  once, a coordinator gets one notice a minute, not one per work. Posted with
  `ctx.session.synthetic({ sessionID, text, delivery: "queue", resume })`. `synthetic` is in the public `SessionDomain`
  on 2.2.3 and 2.3.0.
- **A notice carries only the plugin's own words:** work ids (checked against the work-id pattern), phases and
  outcomes from their fixed sets, codes **from the §5 table only** (round 2, L-f: any other string, such as a provider's
  error name in a failed run, becomes `RUN_FAILED` before it can reach a notice), and the cursor, such as
  `boxd: 3 works changed — review-api idle (completed, not saved); db-mig failed (GUEST_AUTH_FAILED); docs asleep (idle).
  boxd_status({ since: 1842 }) has the details.` It never carries `lastText` or any other guest text, because a notice
  is injected into the coordinator's context, and guest text is untrusted.
- Option `notices`: `"wake"` (`resume: true`: an idle coordinator starts a turn, as a subagent's completion does),
  `"queue"` (it waits for the coordinator's next turn), or `"off"`. The default is `"wake"`, which is what #14 asked
  for. The cost is at most one model turn per minute per coordinator, and none for scripts or subagents. The reviewer
  recommends `"queue"`. Owner question Q2.

**Automation rides on the watcher** (§C.3): the same sweep feeds the auto-harvest and auto-sleep of finished and
orphaned works, the lease renewals, and the cost estimate. For that, the watcher also runs while any open work is
`idle` and running with `autoSleepMinutes` not yet passed, but it reads such a work's guest **only once**, when the
timer runs out and just before acting, so automation does not keep an idle machine awake. The sweep also checks each
`session.notify` target with `ctx.session.get` (local, no CLI call) to find orphans.

The watcher stops when nothing is busy, when the plugin is disposed, and when its sweep fails three times in a row
(`status.health` says why).

### 3.14 The registry and the declaration

| Tool | `readOnly` | class | asserts |
|---|---|---|---|
| `boxd_status` | true | read | no |
| `boxd_job` | true | read | no |
| `boxd_read` | true | read | no |
| `boxd_ensure` | false | write | yes |
| `boxd_submit` | false | write | yes |
| `boxd_harvest` | false | export | yes |
| `boxd_sleep` | false | write | yes |
| `boxd_resume` | false | write | yes |
| `boxd_reassign` | false | write | yes |
| `boxd_golden` | false | write | yes |
| `boxd_exec` | false | write | yes |
| `boxd_drop` | false | destructive | yes |

`jelly.tools` lists all twelve with `effect: "allow"` and these `readOnly` values, equal to the registry (OD-29;
`test/unit/jelly.test.ts`). `jelly.cost` gains one sentence: "`boxd_golden` and `boxd_ensure` may create a short-lived
builder machine to make a golden image." It gains a second sentence for automation (§C.3): "With access Allowed,
finished works are harvested and hibernated automatically after `autoSleepMinutes` (10 by default); at Ask before
changes and Read only, only if you set `automation: \"on\"`." `access` keeps jelly's three choices. `docs/jelly.md` counts
12 tools (3 read-only), names the `boxd_cleanup` command action and its default ask (§C.5), says which automation runs at
which `access` level, and keeps the family block unchanged.

---

## 4. Concurrency and the laptop server

### 4.1 One runner for every process

`src/exec/runner.ts` owns every child process the plugin starts:

- **Slots:** at most **12** `boxd` children at once for plugin work. The foreground lane (tool calls) may use all 12;
  the background lane (watcher, status guest reads) at most 4 of them. Two lanes stand apart, each with its own cap:
  the **exec lane** for `boxd_exec` (4), whose commands can run for minutes, and the **import lane** for the laptop's
  `opencode session delete`/`import` (2). So at most 18 children exist at once. The caps are constants, measured in live
  check L12, not options.
- **Queue:** FIFO per lane, foreground first. A queued call honours its signal while it waits.
- **Machine locks:** a machine change (`create`, `wake`, `resize`, `reboot`, `hibernate`, `remove`, `rename`,
  `label set`) or a mutating helper action (`setup`, `prompt`, `interrupt`, `upgrade`, `adopt`, `export`, `import`,
  `git` for a harvest or drop) holds that machine's lock, so two changes never race on one machine. Machine locks are
  keyed by `machineId` (a create, before boxd has given an id, by region and intended name), and are always taken
  after any work lock (§2.2). Read actions
  (`phase`, `read`, `health`, the `serve` poll) do not take it, and use the name, not the id (round 2, L-g: a name
  that now points at another machine makes a read report that machine, which loses no data; once boxd's listing
  carries `id` (U14), every read compares it with `machineId` and answers `NOT_OURS` on a difference); they are
  single flight per machine and action (a second
  read in flight shares the first one's answer), and at most one read exec per machine runs at a time. `boxd_exec`
  takes neither (M4). So a machine has at most one change exec, one read exec and up to 4 `boxd_exec` commands.
- **Lock order** (M4): a call takes a machine lock first, and then a slot for **one child process at a time**; it gives
  the slot back when that process ends, before it waits, polls or takes the next slot. A slot is never held while
  waiting for a machine lock, a golden-build single flight, a poll interval or another lane. A golden build waits
  for nothing while it holds a builder machine's lock, and calls that wait for the build hold no lock and no slot. With
  this order no cycle can form, and §7.1 tests it with 300 queued items and a build in flight.
- **Acting by id** (H2): every change to a work's machine starts with `machine get <name> --region R --json`, under
  the machine lock, and refuses `NOT_OURS` unless the id is the recorded `machineId`. Then it passes the id, not the
  name: `remove`, `rename`, `resize`, `reboot`, `hibernate`, `wake` and `label set` take "machine name or ID" on the
  laptop CLI 0.3.5. For `exec` and `cp`, live check L1 confirms that an id works; until it does, they use the name
  checked against the id in that call. The check costs one `get` per change call, not per process.
- **The read rule** (M1, M2), enforced in the runner so `status`, `job`, `read` and the watcher share it: an exec
  marked "read" runs only when the machine is `running` in a listing taken at most 2 s earlier (otherwise the exec
  would wake a hibernated machine), never copies a file to the guest, and never writes the ledger. A read on a machine
  without the helper fails instead of uploading it. One residual race stays: a machine that hibernates in the 2 s
  between the listing and the exec is woken by that exec. Upstream ask U15 (`machine exec --no-wake`) closes it.
- **Timeouts, always explicit:** CLI reads 15 s; helper read actions 10 s and change actions 30 s, with
  `machine exec --timeout` so boxd kills the remote side too; `setup` 30 s (its clone runs detached on the guest with its own 300 s bound) and `upgrade` 180 s;
  `boxd_exec` its own `timeout`; create 60 s; resize and reboot 90 s; `cp` 120 s; laptop import 120 s; golden build
  steps 300 s. On a timeout the child gets SIGTERM, then SIGKILL after 2 s.
- **Signal:** `spawn(…, { signal })`. Abort kills the child, and its queued successors are dropped.
- **Output caps:** stdout is capped at 8 MiB (the child is killed beyond it). Transcripts and files go to disk with
  `machine cp <machine>:<path> <file>`, never through stdout.
- **The CLI flavour check** runs once per binary, as single flight (F9).

### 4.2 List forms

`boxd_ensure`, `boxd_submit`, `boxd_job`, `boxd_harvest`, `boxd_sleep`, `boxd_resume` and `boxd_drop` take
`works: [...]` (1 to 300 items). Results return in input order.

**Work, not waiting, holds a slot** (M5). An item runs its active steps (validate, create, `setup`, prompt, export…)
with an item concurrency of 8. When an item has to wait (a starting machine, a guest server coming up, a golden
build in flight), it leaves its item slot and joins one shared poll loop. That loop checks every waiting item every
3 s, one short `serve` or listing call each, through the ordinary slots. Waiting therefore costs no concurrency, and
300 waiting items cost about one listing plus the `serve` polls of machines already running.

**The time bound is honest.** The plugin measures nothing it cannot keep: a list call has a bound `B`, set below the
longest tool call the host and Code Mode allow (measured in §7.2, with 30 s of margin; until then
`B = 4 minutes`). What a list can finish in `B` is roughly: creates at about 1 s each through 8 item slots
(300 → about 40 s), one `setup` each (about 2 to 5 s, so 300 → 75 to 190 s), and the waits in parallel. One ensure of
300 new works fits only when the clones are small. So when `B` runs out:

- an item that **made progress** answers its real state (`creating` or `starting`) with `next: boxd_ensure({ works:
  [<the ids still starting>] })`. Calling it again only waits and converges: nothing is repeated;
- an item that **never started** answers `cancelled` with `started: false`, and the same `next`;
- the list's `state` is `partial`, and `counts` says how many of each.

A list `ensure` of more than 50 items defaults to `wait: "created"`: it creates and sets up, then answers, and the
notices (§3.13) say when each work is ready. Under 50, the default stays `"ready"`.

**`B` bounds every call, single ones too** (round 2, L-e). A single `ensure` that has to build a golden image (about
2 minutes) and then run `setup` (up to 300 s) could pass a host limit of 4 to 5 minutes. So every tool call stops
waiting at `B`: an `ensure` still building or setting up answers `creating` or `starting` with `next` naming the same
call. The build or the clone goes on (the builder has its own `delete-after`; the clone runs detached with its own
timeout, §3.4 step 7), and the next call joins it rather than repeating it. The per-step bounds of §4.1 still apply inside `B`.

The skill says: use a list form, not `Promise.all` over single calls. Both are safe now, because the caps are global.

### 4.3 Keeping the event loop free

- No transcript, patch or file body larger than 1 MiB is parsed or held on the server's thread (F8). sha256 is
  computed by streaming.
- `JSON.parse` runs only on CLI answers of `--json` commands and helper lines (capped at 8 MiB).
- Status is assembled from the index and cached reads. Nothing in it is O(works × reads).
- **Measurement:** the plugin samples event-loop delay (a 100 ms `setInterval`'s drift, which works on Bun and Node)
  while any call runs, and reports `health.loopLagMaxMs` over the last 5 minutes in `boxd_status` and
  `/boxd-status`. If #14 §3 recurs, the number says whether the plugin is the cause.

### 4.4 Spawn budget per call (steady state, no failures)

These numbers are acceptance criteria (§7.1): a harness counts the fake CLI's spawns per call, and each tool's owner
asserts its row.

| Call | v0.0.6 | v0.1.0 |
|---|---|---|
| `boxd_status`, 170 works | 170 `get` + up to 170 `exec` + list + snapshots + env | 1 list + 1 limit (cached) + guest reads only for busy, running works whose watcher read is older than 60 s |
| `boxd_ensure`, new work, wait | 20–40 | create + `setup` + polls (2–4; +1 `get` when adopting) |
| `boxd_submit` | 6–8 | 1 listing (≤ 2 s) + 1 prompt exec (+1 per file); +1 `get` when it wakes |
| `boxd_job` | 4–5 | 1 listing (≤ 2 s) + 1 read exec |
| `boxd_harvest`, 1 session | 7–9 | 1 export exec + 1 `cp` + 1 git exec + 1 patch `cp` + 2 laptop imports |
| `boxd_drop` | 4–6 | 1 git exec + 1 `get` + 1 `remove`; gone: 1 fresh list + 1 `get` per region |

---

## C. Cost and cleanup

The owner's request: the plugin must make agents clean up machines, to save cost. This section is the whole design
for it. §3, §3.13, §5, §7, §9 and §9.2 point here.

### C.1 First principles, checked against boxd's rates

boxd meters per second and bills on use, not size (boxd.sh/pricing, fetched 15 Nov; the usage API's `UsageRates`):

| Rate (EUR org / USD org) | Billed on | running | standby | hibernated | stopped | deleted |
|---|---|---|---|---|---|---|
| vCPU €0.039 / $0.047 per vCPU-hour | **active** CPU time only | yes | — | — | — | — |
| RAM €0.012 / $0.014 per GiB-hour | **resident** memory | yes | **yes** | — | — | — |
| Disk €0.00008 / $0.000096 per GiB-hour | disk **written** | yes | yes | yes | yes | — (usage history kept 2 years) |

boxd's own table for the most each state can cost (every vCPU busy, all memory and the 100 GiB disk used): a 4 vCPU /
16 GiB machine is €0.36/h running, €0.20/h standby, €0.008/h hibernated. For an **idle work** (no model call running)
the honest numbers are different, and they correct one premise of the request:

- **Idle running ≈ standby.** Idle vCPU costs nothing either way, and both bill resident RAM. A 4×16 work whose guest
  holds 3 GiB costs about 3 × €0.012 + 20 GiB × €0.00008 ≈ **€0.038/h** running idle, and the same in standby. Standby
  saves almost nothing for this workload.
- **Hibernated ≈ disk only:** the same work costs about **€0.0016/h**, about 24 times less. **Hibernation is the
  saving.** Waking takes about 85 ms (boxd docs), and memory, processes and the session survive it.
- **Deleted costs nothing**, but deletion is the only step that can lose unsaved work.
- At fleet scale: 170 idle works left running cost about €6.50/h (€155/day); hibernated, about €0.27/h (€6.50/day).

Two more first principles: **agents forget** (compaction drops context, coordinator sessions end or are deleted, the
laptop sleeps or crashes), so the guarantees must sit **below** the agent: in the platform first, then in the plugin.
And **never destroy unsaved work**: sleeping is always safe, so it may be automatic; dropping is explicit, always.

### C.2 Layer 1: the platform, set at creation (works with the laptop off)

Every work machine is created with (§3.4 step 6):

| Setting | Value | Why |
|---|---|---|
| `--auto-suspend-timeout` | **0 (off)**, explicitly, whatever the org default | Standby still bills resident RAM (C.1), so it saves almost nothing for an idle work. It also adds a state whose wake depends on inbound packets, and a long CPU-only step with no traffic would be frozen in standby mid-run for no saving. The request suggested ~15 min; the rates argue it out. |
| `--auto-hibernate-timeout` | **7200 s (2 h)**, option `autoHibernateMinutes` | The backstop when nothing else acts (laptop off, plugin not running). Long enough that a CPU-only step with no network traffic (a long build or test run) is rarely frozen mid-run; short enough that a forgotten work stops costing RAM within 2 h. v0 used 30 min; layer 2 now sleeps finished works much sooner, so the platform bound can afford to be safer. Hibernating freezes, it does not destroy. |
| `--idle-ignore-outbound` | **off** | A running session's model traffic is outbound. With it on, boxd measured a machine hibernating while its outbound requests ran (v0 live check), which would freeze sessions mid-run. The cost of off: an idle guest with a stray outbound poller (a left-over `--watch`) never hibernates by itself. Layer 2 catches that case. |
| `--delete-after` | **none by default**; option `leaseDays` (0 = off) | boxd deletes on the timer whatever the machine holds, **unsaved work included**, so it is off unless the owner opts in. |

With `leaseDays: N`, a work gets `--delete-after <N>d` at creation, and the plugin renews it
(`machine config set <machineId> delete-after <N>d`, by id) at most once per 6 hours per work: on any change call for
the work, **and**, from the automation owner (C.3), for every open work that is `busy` or not yet saved, whether or not
any agent touches it (round 4, L-2). So while OpenCode runs on the laptop, a long busy work that the coordinator only
watches through notices is never deleted mid-run. Only an absent laptop (off, asleep, OpenCode closed) lets a lease run
out. Setting `leaseDays` is itself the person's consent to these renewals, at every `access` level, as it is to the
timer. 24 hours before expiry, the watcher harvests the work if it is idle (an `idle` session can be harvested; a `busy`
one cannot), and `boxd_status` shows `LEASE_EXPIRING` in `attention` with what would be lost. A laptop that is off for
longer than the lease loses whatever was not harvested. That is the trade the option makes, and the docs say so.

**These creation settings apply at every `access` level** (round 4, M-2). They are part of the machine the person asked
for: `boxd_ensure` is itself a change that the person allowed, by rule or by answering its prompt, and the bounds ride
on that one call. No later step changes them without a tool call.

### C.3 Layer 2: the plugin's automation (works while OpenCode runs, with no agent)

The watcher (§3.13) already sees each work go `idle`, `failed` or `asleep`. On top of that, an **automation loop**:

1. **A work finishes** (busy → idle; or a work that has been `ready` with no prompt for 30 min): after
   `autoSleepMinutes` (default **10**; 0 = off) with no new prompt, it **auto-harvests** (§3.6, non-destructive: it only
   adds to the laptop) and then **sleeps** (§3.7). The 10 minutes give a coordinator that is reading the result time to
   send the next prompt without a wake/sleep cycle. A harvest that fails (an old guest version, a timeout) does not
   block the sleep: sleeping is always safe, and the work gets `UNHARVESTED_SLEEP` in `warnings` and in `attention`.
2. **A work waiting on a person** (the guest session has a pending form (`GET /api/session/<id>/form`) or a permission
   ask (`/permission`); both routes exist on 2.2.3 and 2.3.0): the plugin does **not** sleep it, and lists it in
   `attention` as `needs-input` with its cost per hour and `next`: answer it with `boxd connect oc-<id>`. The platform
   bound (2 h) still hibernates it, which is fine: hibernation keeps memory and processes, so the pending question is
   still there after a wake, and a person's `boxd connect` wakes the machine.
3. **Orphaned works**: a work whose coordinator (`session.notify`, §3.5) is deleted or archived (an event, below), or
   that no plugin call has touched for `orphanHours` (default **12**) while its machine runs and it is not busy: harvest,
   then sleep. A busy orphan is left to finish (it is doing work someone asked for), then step 1 applies.
4. **Never auto-drop.** Nothing automatic ever runs `boxd_drop`, removes a machine, or sets a delete timer the owner
   did not opt into.
5. **One automation owner.** Several OpenCode processes on one laptop share the ledger; only the one holding
   `automation.lock` (the same heartbeat lock as §6.1) runs steps 1–3, so a work is never harvested twice at once.
6. **Consent, not a prompt** (round 4, M-2). Automation is not a tool call, so it cannot ask. It makes changes (a
   harvest writes the laptop's OpenCode store and the ledger; a sleep changes a machine), so it follows the person's
   `access` choice:
   - **`access: "all"`** (the default): automation is **on**, because "all" means every change runs without asking.
   - **`access: "ask-changes"` and `"read-only"`**: automation is **off**. A change there either asks or does not run,
     and automation can do neither. Layer 1 (the 2 h platform bound) still applies, and status, the context line and
     the idle check say `automation: "off (access)"` with the one call to make.
   - **The person's own consent:** the option `automation: "on"` in their plugin config turns it on at any `access`
     level. Writing it in `opencode.json` is the person's explicit, standing "yes" to these two changes (harvest, then
     hibernate; never drop), and the docs and the skill call it exactly that. `automation: "off"` turns it off at
     `"all"`. The default `"auto"` means on at `"all"`, off otherwise. Setting `autoSleepMinutes` alone is not consent.
   - `jelly.cost` gains: "With access Allowed, finished works are harvested and hibernated automatically after
     `autoSleepMinutes` (10 by default). At Ask before changes and Read only this happens only if you set
     `automation: \"on\"`."

   `boxd_status` says which applies: `automation: "on" | "on (consent)" | "off" | "off (access)" | "not-owner"`.

The session-deletion signal comes from `ctx.event.subscribe({ types: ["session.deleted", "session.archived"] })`
(both event types exist on 2.2.3 and 2.3.0). The subscription is a fast path; the sweep's `ctx.session.get` check
(§3.13) is the ground truth, so a missed event costs at most one sweep.

### C.4 Layer 3: what agents see and use

All four hooks below are verified on the 2.2.3 and 2.3.0 `@opencode/plugin` types with the same shape:
`ctx.session.hook(name, callback)`, where `SessionHooks` has `context: SessionContext` (mutable `system:
SystemPart[]` and `messages`; on 2.3.0 each message also carries read-only `metadata`), `compaction: SessionCompaction` (a `SessionContext`, plus an optional `result`) and
`"experimental.idle": SessionIdle` (`{ sessionID, background }`), and `ctx.event.subscribe` takes the event types
above. 2.2.4–2.2.7 are not separately inspected; the host suites on all six prove them (§7.2). `experimental.idle` is
marked experimental by OpenCode: if its registration fails on a host, status says so, and layers 1–2 still hold.

- **`hook("context")`: one fleet line, on the tail of the request, only when it changed** (round 4, M-1). A session
  owns works when it is the `session.notify` of at least one open work (an in-memory set, so the hook is a map lookup
  for every other session and adds nothing).
  - **`system` is never touched.** Providers cache a prefix in the order tools → system → messages (Anthropic's cache
    breakpoints, OpenAI's and others' automatic prefix caching), so any change in a system part would make the whole
    history uncached on every turn. The hook leaves `system` byte-identical to what OpenCode built.
  - **The line goes on the tail of `messages`**, after everything a cache already holds: when the newest message is
    `user`, one text part is appended to it; when it is `tool` (a tool-loop step), one `user` message holding only the
    line is appended after it. The hook's `messages` change applies to this request only. It is not stored, so the
    history the next request caches is unchanged. Neither host exposes a reminder mechanism to plugins:
    `@opencode/core` builds its own reminders internally, and the plugin API on 2.2.3 and 2.3.0 has nothing for them.
    So the plugin uses the hook's own `messages`, which both hosts type as mutable.
  - **Only when the fleet changed:** the line is built from coarse figures (counts by phase, unsaved count, the cost
    per hour rounded to €0.10, the first cleanup action) and fingerprinted per session. It is added only on the first
    request after the fingerprint changes, and nothing is added while it stays the same. A 300-work fleet whose numbers
    move every minute therefore costs one line per real change, not per request.
  - Text, at most 240 characters, plugin fields only: `boxd: 31 works — 12 busy, 9 idle (4 unsaved), 10 asleep;
    ~€0.40/h running. Cleanup: boxd_sleep({ select: "finished" }) saves ~€0.30/h.` No guest text, and no work ids
    beyond counts.
  - **Cost:** about 50 tokens per **change**, on the uncached tail only; zero on a request where nothing changed, and
    zero for every other session. The cached history prefix is never invalidated by it.
- **`hook("compaction")`: keep the works list across a compaction.** For an owner session it appends one text part to
  the tail of the compaction request's `messages`, with `system` left as built: "Keep this list in the summary: boxd
  works open: <up to 30 ids with phase>, and N more; boxd_status lists all." Honest limit: the summarizer may still drop
  it, because a hook can ask, not force. After a compaction, the fingerprint is reset, so the context hook adds the
  line on the next request, and `boxd_status` is the source of truth. **Cost:** about 100–300 tokens, once per
  compaction.
- **`hook("experimental.idle")`: an end-of-turn check, rarely speaking.** When an owner session is about to go idle,
  the hook looks at the fleet (from the watcher's cache; no CLI call in the hook) and admits **one** short synthetic
  note with `ctx.session.synthetic` from inside the hook (OpenCode documents that input admitted by this hook runs in
  the same execution instead of the session going idle) only when **money is burning and automation will not handle
  it**: works running idle while automation is
  off or `read-only`; works whose auto-sleep failed; `needs-input` works over €1 of idle cost; or a budget warning.
  The note names the counts, the cost per hour and the one call to make, such as
  `boxd: 7 idle works are running (~€0.27/h) and auto-sleep is off. Call boxd_sleep({ select: "idle" }) or say why not.`
  **It never loops:** the hook keeps a fingerprint of the state it last spoke about per session (the set of burning
  work ids and the reason), and stays silent while the fingerprint is unchanged; it speaks at most once per 30 minutes
  per session; and it never speaks in the execution that its own note started. The mechanism for the last rule
  (round 4, L-4), since `SessionIdle` carries only `{ sessionID, background }`: each note is posted with
  `metadata: { boxd: "idle-check", id }`, and the plugin keeps the last note id per session. At the next idle, the hook
  reads the session's newest input (`ctx.session.context`, a `SessionDomain` method on both hosts). If that input is
  the plugin's own note, with no person or tool input after it, the hook stays silent. **Cost:** zero tokens normally;
  when it speaks, the note (~60 tokens) plus the one extra model turn it causes, at most twice an hour per coordinator.
  The idle check runs only when automation is off or blocked, so at the default (`access: "all"`, automation on) it is
  almost always silent.
- **Events:** `session.deleted` / `session.archived`, as in C.3.

**Tool results.**

- `boxd_status` gets two blocks (`include: ["cost"]` adds the per-work machine cost from `manage usage`, as §3.1 says;
  the estimate and the cleanup block need no extra CLI call):

  ```jsonc
  "cost": {
    "currency": "EUR",                         // the org's billing currency, from boxd
    "perHour": { "estimate": 0.41, "running": 21, "asleep": 10, "basis": "rates × resident GiB and load from the last guest reads; disk for asleep works" },
    "today": { "machines": 6.12, "models": { "currency": "USD", "total": 48.3 }, "complete": false },   // machines: manage usage since local midnight (lags up to 25 min); null for a member
    "works": [{ "workId": "db-mig", "machine": 0.42, "model": 3.1, "perHour": 0.038 }]   // with include "cost", at most `limit`
  },
  "cleanup": [                                 // suggested actions, biggest saving first; each one call
    { "action": "sleep",   "select": "finished",       "works": 9,  "savesPerHour": 0.33, "call": "boxd_sleep({ select: \"finished\" })" },
    { "action": "harvest", "select": "unsaved-finished","works": 4,  "why": "4 finished works are not saved; drop needs a harvest", "call": "boxd_harvest({ select: \"unsaved-finished\" })" },
    { "action": "drop",    "select": "saved-finished", "works": 6,  "savesPerDay": 0.24, "call": "boxd_drop({ select: \"saved-finished\" })" }
  ]
  ```

  `perHour` is an estimate and says so: active vCPU from the guest's load average and resident RAM from
  `/proc/meminfo`, both read by the `phase` and `health` actions the watcher already runs, times the org's rates
  (from `manage usage`'s `rates`, cached for a day; boxd's public rates, marked `ratesSource: "public"`, for a member
  who cannot read usage). Idle works keep their last reading.
- **Selectors for list forms.** Instead of `works`, a list tool may take `select`, resolved at call time against a
  fresh listing and the ledger. The result lists every matched work with its own result, so nothing is hidden, and
  `dryRun: true` answers the match without acting.

  | Tool | `select` | Matches |
  |---|---|---|
  | `boxd_sleep` | `"idle"` | running works whose phase is `idle` or `ready`, not `needs-input` |
  | `boxd_sleep` | `"finished"` | `idle` works whose last run has an outcome (`completed`, `failed` or `aborted`) |
  | `boxd_harvest` | `"unsaved-finished"` | finished works (running or asleep) whose `saved` is not `fresh` |
  | `boxd_drop` | `"saved-finished"` | works with `saved: fresh` and outcome `completed`, running or asleep |

  `boxd_drop({ select: "saved-finished" })` still applies drop's whole guard (§3.9) to each work, the check against the
  guest included, so a work that moved on answers `NOT_SAVED` and stays. Drop by selector is **never** called by the
  plugin itself. A selector call asserts its action once, with every matched id as a resource.

### C.5 Layer 4: the person

- **`/boxd-status` and the TUI** show a **Cost** row: running and asleep counts, the estimate per hour, today's machine
  cost, and the top cleanup action.
- **`/boxd-cleanup`** shows what costs money (each running work's cost per hour, idle time and `saved` state, then the
  `cleanup` actions with their savings), and then offers each action. **Its confirmation is a permission prompt,
  which only a person answers** (round 4, M-3). There are no plan codes: the round-3 code path is removed, because a
  synthetic report stays in the session's history, where the model can read the code and replay it.
  - **How:** for each action (sleep `finished`, harvest `unsaved-finished`, drop `saved-finished`), the server command
    calls `ctx.permission.assert({ sessionID, action, resources: [<the matched work ids>], metadata: { saving } })`
    **without a `source`**. On 2.2.3 and 2.3.0 `AssertInput.source` is optional and its only kind is a tool call, and
    `assert` "prompts the user and waits for the reply". The prompt is the host's own permission UI (the TUI, the web
    app, Jelly). It is not a session message, so the model never sees it in its context, and there is nothing in it
    to echo or replay. The host's form mechanism was considered: the plugin API has no domain to create a form on
    either host (the `/form` routes exist, but no plugin method calls them), so `assert` is the person-only channel.
  - **Which action it asserts, so there is exactly one prompt per action at each access level:**
    - `access: "ask-changes"`: it asserts the tool's own action (`boxd_sleep`, `boxd_harvest`, `boxd_drop`), which
      the default rules set to **ask**. That ask **is** the confirmation, so the person is never asked twice.
    - `access: "all"`: the tool actions are allowed without asking, so it asserts the command's own action
      `boxd_cleanup`. The default-rule block adds `{ action: "boxd_cleanup", resource: "*", effect: "ask" }` after its
      `boxd_*` allow, at every access level. A person who wants cleanup without a prompt can add their own later rule.
      `boxd_cleanup` is a command action, not a tool, so it is not in `jelly.tools`; `docs/jelly.md` names it.
    - `access: "read-only"`: the command only reports. It asserts nothing and changes nothing.
    - A person's own later rule wins, as everywhere in the family: a rule that allows `boxd_cleanup`, or allows
      `boxd_drop` at `"ask-changes"`, is the person's standing yes, and the command then runs that action without a
      prompt. The design never adds such a rule itself.
  - **A yes** runs that one action in the plugin's process, against the work ids that were in the prompt, through the
    same code as the tool (drop's whole guard per work, so a work that moved on answers `NOT_SAVED` and stays). A
    **no** or a deny rule ends that action, changes nothing, and moves on to the next one. Nothing goes through the
    tools RPC, which refuses an ask it cannot show, so the path works at `"ask-changes"` too.
  - **The TUI** shows the same report in its dialog, and its buttons run `/boxd-cleanup`, so the TUI and every other
    client confirm the same way.
  - The report itself is posted with `ctx.session.synthetic` (`resume: false`). It holds counts, costs, ids and
    phases only, and nothing the model could use to approve anything.
- **A budget** (option, off by default): `budget: { daily, action: "warn" | "refuse" }`, in the org's billing
  currency (boxd bills in EUR or USD per org; the request said "dailyUsd", but a fixed USD figure would be wrong for an
  EUR org), counting **machine** cost today (`manage usage` since local midnight, plus the estimate for the last
  unmetered 25 minutes). Model spend is shown beside it but not counted: it is OpenCode's own USD estimate, and
  providers have their own spending limits. At `warn`, status, the context line and the idle check say so
  (`BUDGET_WARN`). At `refuse`, every call that would make a machine run that is not running now answers
  `BUDGET_REACHED` (round 4, L-1): `boxd_ensure` and `boxd_resume`, **`boxd_submit` to a hibernated work** (it would
  wake it), and **`boxd_exec` with `wake: true`**. A submit or exec on a machine that is already running passes,
  because it adds no running machine and stopping it mid-task would waste what it has already cost. Sleep, harvest
  and drop always work, because they lower the cost. **For a member** who cannot read
  usage, the budget cannot be measured: status says `BUDGET_UNKNOWN`, and `refuse` degrades to `warn` rather than
  blocking all work on a number nobody can see.

### C.6 What a hook cannot do, said plainly

- A hook cannot force a compaction summary to keep text; it can only ask (C.4).
- `experimental.idle` is experimental in OpenCode; its shape is the same on 2.2.3 and 2.3.0, and if it changes, the
  idle check is off and status says so. Layers 1 and 2 do not depend on it.
- The context hook runs only while OpenCode runs. With the laptop off, only layer 1 (and a `leaseDays` opt-in) acts.
- Cost figures are estimates until boxd marks usage `complete` (up to 25 minutes later), and machine cost needs an
  owner's or admin's sign-in.

### C.7 The skill's "Cost" section (package D writes it)

Short, in the skill's own voice:

- **Lifecycle:** `boxd_ensure` → `boxd_submit` → (notice or `boxd_job`) → `boxd_harvest` → `boxd_sleep` →
  `boxd_drop` when the work is finished and saved. A running machine costs money even when its session is idle; a
  hibernated one costs almost nothing; a dropped one costs nothing.
- **Sleep what you are not using.** `boxd_sleep({ select: "finished" })` is always safe: it keeps the disk, the memory
  and the session, and the next `boxd_submit` wakes it. The plugin also does this by itself after
  `autoSleepMinutes`, unless it is off.
- **Drop only finished, saved work**, and only when nobody needs the machine again:
  `boxd_drop({ select: "saved-finished" })`. Drop refuses anything not saved, so harvest first.
- **Read `cost` and `cleanup` in `boxd_status`**, and act on the first `cleanup` action, or say why not.
- **Automation and `access`.** At `access: "all"` the plugin harvests and hibernates finished works by itself. At
  "ask-changes" and "read-only" it does not, unless the person put `automation: "on"` in the plugin config: that line is
  their consent. When automation is off, cleaning up is your job: act on `cleanup`.
- **`/boxd-cleanup` is for the person.** Its confirmations are permission prompts that only a person answers. Do not
  try to answer or work around them.

The skill's existing "Credentials" and "Many works" sections stay, updated for v1.

---

## 5. Errors

Every error is `CODE: What happened. Next step: What to do.`, built through `boxdError` and the one table in
`src/errors.ts`, with a README row and a docs row, as today. `next` names the exact call. Shared names stay:
`HOST_UNTESTED`, `OPTIONS_INVALID`, `STATUS_UNAVAILABLE`, `SKILLS_INVALID`.

| Code | state | Meaning | next |
|---|---|---|---|
| `NAME_INVALID` | refused | An input failed its rule; `field` names it. | Fix that field and call again. |
| `PATH_REFUSED` | refused | A laptop path is outside the project and `allowedRoots`, or is a symlink. | Pass a path inside the project, or add its root to `allowedRoots` and allow it with `external_directory`. |
| `FILE_TOO_LARGE` | refused | Over 8 MiB a file or 32 MiB a call. | Move a smaller file, or split it. |
| `FILE_CONFLICT` | refused | The laptop file changed since the last harvest. | Keep the edit and leave that path out, or restore it and harvest again. |
| `NOT_OURS` | refused | No open work with this id; or `oc-<id>` now has another id than the recorded `machineId` (renamed, re-pointed); or the recorded machine lives under another name; or two regions hold `oc-<id>`. Nothing was changed. | `boxd_ensure({ workId })` for an unknown id; otherwise look at the machines the message names with `boxd machine get`, and rename them back or `boxd_reassign`. |
| `NOT_REASSIGNABLE` | refused | `from` has a session, uploaded files or a dirty tree, or `to` is open. | `boxd_drop` it after a harvest, or pick a work with no prompt yet. |
| `MACHINE_LIMIT` | refused | No region has room; `limit`, `inUse` and `free` per region. | `region: "<other>"` when it has room; otherwise free machines (`boxd_drop`, `boxd_reassign`) or ask for more: `boxd manage machine-limit request --max-vms <n>` (owner). |
| `SIZE_UNAVAILABLE` | refused | The org's quota does not allow this size. | Pick a smaller `size`. |
| `GOLDEN_MISSING` | refused | No golden image for this region, size and OpenCode, and `buildGolden` is `never`. | `boxd_golden({ region, size })`. |
| `GOLDEN_BUILD_FAILED` | failed | The build's step and its words, or a base whose OpenCode database holds a session. | Read `message`; fix `goldenSetup` or the base, then `boxd_golden` again. |
| `GOLDEN_HAS_CREDENTIAL` | refused | The base holds `~/.local/share/opencode/auth.json`: model credentials must not be baked into an image, because an image reaches every work and everyone in the org who can boot it. | Remove `auth.json` from the base (or build from stock), and give works a model key a supported way: a sealed, host-bound `boxd env set <KEY> … --secret --domains <provider hosts>`, or `opencode auth login` on one work's own machine after `boxd connect`. Then `boxd_golden` again. |
| `MACHINE_SHARED` | refused | The machine is shared, which deletes the guest's sign-in. | Unshare it with `boxd machine unshare`, or drop and ensure again. |
| `MACHINE_ISOLATED` | refused | The machine is isolated: no git integration, no in-VM CLI. | Drop it and ensure again. |
| `MACHINE_STARTING` | starting | Still starting after the call's wait. | The same call again; it waits. |
| `MACHINE_GONE` | gone | A fresh all-region listing and a `get` of the recorded id found the machine nowhere. | `boxd_resume` to rebuild it, or `boxd_drop` to close the work. |
| `MACHINE_ASLEEP` | asleep | A read or `boxd_exec` found it hibernated, and did not wake it. | `boxd_resume({ workId })`, or `wake: true` for `boxd_exec`. |
| `AGENT_UNREACHABLE` | unreachable | boxd's VM agent does not answer, and the plugin has not rebooted this machine itself. | `boxd_ensure({ workId, repair: "reboot" })`; a reboot ends a running run. |
| `SESSION_BUSY` | busy | The session is running, and this call needs it idle (harvest, size, model switch). | Wait for the notice, or `mode: "interrupt"`, or `partial: true` for harvest. |
| `SESSION_MISSING` | failed | The guest no longer has the work's session. | `boxd_resume` (it imports the saved transcript). |
| `RUN_FAILED` | failed | The last run failed; `error` is its one line. | Read `lastText`, then `boxd_submit` again. |
| `RUN_INTERRUPTED` | failed | The guest's OpenCode stopped mid-run. | `boxd_harvest`, then `boxd_submit` again. |
| `GUEST_AUTH_FAILED` | failed | The model provider or a pushed host refused the credential, or the guest has none. | Set or rotate the sealed, host-bound `boxd env` secret (or a person runs `opencode auth login` on this work's machine after `boxd connect`), then `boxd_submit` again. A session never starts an interactive sign-in itself. |
| `GUEST_VERSION` | refused | The guest's OpenCode differs from the laptop's, and this call moves a transcript. | `boxd_ensure({ workId })` upgrades it in place once the session is idle. |
| `GUEST_UNRESPONSIVE` | unreachable | The guest is short of memory or overloaded; the facts are in `message`. | Tell the user which processes the message names, or `boxd_exec` to stop them. |
| `GUEST_SERVER_DOWN` | unreachable | Nothing listens on the guest's OpenCode port. | `boxd_ensure({ workId })` starts it. |
| `GUEST_FAILED` | unreachable | The helper failed; its words are in `message`. | `boxd_ensure({ workId })`; if it repeats, `boxd_read({ workId, log: "server" })`. |
| `GUEST_WORKSPACE` | failed | The guest folder could not be made or cloned. | Read `message` (clone auth, disk); fix it, then `boxd_ensure`. |
| `NOT_SAVED` | refused | Drop without `saved: fresh`, or the guest's sessions moved on since the harvest (a later message, a newer update, a new session). Renames `NOT_PROVEN`. | `boxd_harvest({ workId })`, then drop again. |
| `UNTRACKED` | refused | Untracked or ignored paths that weren't harvested; `paths`, `count`, `kind`. | Harvest them with `files`, or delete them on the machine, then harvest again. |
| `DIRTY` | refused | Uncommitted work and no stored patch. | `boxd_harvest`. |
| `GIT_UNKNOWN` | refused | The guest folder isn't a git repository. | Make it one, or `boxd_sleep` instead. |
| `EXPORT_INVALID` | failed | A transcript failed its checks (shape, digest, a cycle, a missing parent). Absorbs `PARENT_MISSING`. | `boxd_harvest` again from an idle session. |
| `IMPORT_FAILED` | failed | The laptop's `opencode session import` failed; the export is kept. | `boxd_harvest` again; the stored file is retried. |
| `BOXD_FAILED` | unreachable | The boxd CLI failed in a way the plugin does not know; its words, redacted. | Read `message`; `boxd_status` before trying again. |
| `BOXD_MISSING` | unreachable | No laptop boxd CLI (missing, not signed in, or the in-VM one). | Install the laptop CLI and run `boxd auth login`. |
| `TIMEOUT` | unreachable | A step did not answer in its bound; `message` names the step. | The same call in a later turn. |
| `CANCELLED` | cancelled | The call was stopped; `uncertain` when a write was in flight. | Read the work with `boxd_job` before acting again. |
| `CREATE_UNCERTAIN` | unreachable | A create timed out, and no machine was found yet. | `boxd_ensure` again: it adopts the machine if one landed. |
| `LEDGER_FAILED` | failed | The ledger could not be read or written. | Check the folder is writable, then restart OpenCode. |
| `LEDGER_LOCKED` | busy | Another OpenCode process holds this work's lock. | The same call again in a few seconds. |
| `LEDGER_IMPORTING` | busy | The v0 import is not complete yet, here or in another OpenCode process; `progress` says how far. No tool reads a partial ledger. | The same call again in a few seconds. |
| `IMPORT_V0_FAILED` | failed | The import could not run (the all-region listing failed: no `v1/` was made, and it retries on the next call after 30 s), or one v0 record could not be read (that work id is blocked; the v0 file is untouched). | Sign the boxd CLI in and call again; for one record, fix or remove that v0 file and restart OpenCode. |
| `BUDGET_REACHED` | refused | `budget.action` is `refuse`, and today's machine cost has reached `budget.daily` (§C.5); `today`, `daily` and `currency` in the result. Refused: `boxd_ensure`, `boxd_resume`, `boxd_submit` to a hibernated work, `boxd_exec` with `wake: true`, the calls that would make a machine run. | Lower the cost first: `boxd_sleep({ select: "idle" })`, then `boxd_drop({ select: "saved-finished" })`; or raise `budget.daily`. Tomorrow (local midnight) resets it. |
| `RULES_NOT_ADDED` | — | The default rules did not load. | Restart OpenCode, then `/boxd-status`. |

Warnings (in `warnings`, `attention` and status, never a refusal): `UNHARVESTED_SLEEP` (a work was slept before its
last prompt was saved), `BUDGET_WARN` (the budget is reached with `action: "warn"`), `BUDGET_UNKNOWN` (usage cannot be
read with this sign-in, so the budget is not measured and `refuse` acts as `warn`), `LEASE_EXPIRING` (a `leaseDays`
timer ends within 24 h; what is unsaved is named), `AUTOMATION_BLOCKED` (auto-harvest or auto-sleep failed; the step
and its code are named), `NO_MODEL_CREDENTIAL` (§2.3).

Removed: `SNAPSHOT_EXISTS` (golden names are versioned; a rebuild replaces), `SNAPSHOT_MISSING` (→ `GOLDEN_MISSING`),
`NOT_PROVEN` (→ `NOT_SAVED`), `PARENT_MISSING` (→ `EXPORT_INVALID`), `GUEST_RUN_FAILED` (→ `RUN_FAILED`).

**Classifying boxd's stderr** moves into one table (`src/boxd/errors-table.ts`) with an exact pattern per case, each
captured in the live check and pinned by a unit test: `missing` (`VM '<name>' not found` on 0.2, `no machine
"<name>" in <region>` on 0.3, both anchored to the name and the region asked), `limit`, `agent-silent`
(`cannot connect to VM agent`), `quota`, `auth` (not signed in), and `size-on-restore`. Anything else is
`BOXD_FAILED`. Never treat an unknown failure as missing (F4). A not-found answer that adds "There is a machine … in
<region>" (the CLI's hint for a name in the other region) is classified `elsewhere`, never `missing`. Even a clean
`missing` is only a fact about one region at one moment: the decision "gone" belongs to §3.9's two-check rule.

---

## 6. Migration from v0.0.x

Decision: **import, automatically, without touching v0.** About 170 works ran on v0.0.0–v0.0.6 today. Refusing would
strand them.

AGENTS.md says "no migration code". This needs one written exception, signed off by the owner (Q3):
`src/import-v0.ts` is the only reader of the v0 format, it runs only until a complete `v1/` exists, and it is removed in
v0.2.0. Nothing else in v1 knows v0, apart from the read fallback to v0's `phase` action (§3.2) and `adopt` (§6.3),
which live in the same module and go with it.

### 6.1 When and how: crash-safe, all or nothing (H1)

The import builds the whole v1 ledger in a staging folder and publishes it in one rename. `v1/` either does not exist,
or is complete.

At start, and again on any tool call while no complete `v1/` exists:

1. **Take the import lock:** `mkdir ~/.local/share/opencode-boxd/import.lock` holding a random **token**, the pid and
   the time, with a heartbeat every 10 s; stale after 60 s. A second OpenCode process that finds a live lock does not
   import; its tools answer `LEDGER_IMPORTING`. A process that takes over a stale lock writes its own token.
2. **Start clean, in a staging folder of this run's own** (round 2, L-a): delete any `v1.importing-*` folder whose run
   no longer holds the lock (crashed or taken over), then build in `v1.importing-<pid>-<rand>/`. A stale run that wakes
   up later keeps writing into its own folder and cannot touch the new run's. Staging is disposable, because v0 is
   untouched and is the only input.
3. **Locate every machine:** one `machine list --region all --json`, with no cache. **If it fails, the import aborts**:
   no `v1/` is made, status shows `IMPORT_V0_FAILED` with the CLI's reason, tools answer the same, and the next tool
   call (at most once per 30 s) or a restart tries again. No work is ever given a guessed region, so nothing can be
   closed as "gone" by mistake (H2).
4. **Read the machine ids:** for each machine found, `machine get --region R --json` (under the runner's caps) records
   `machineId`. A `get` that fails leaves `machineId: null`; the first change tool for that work fills it in under its
   machine lock, and drop's gone rule then needs `confirmGone: true` (§3.9).
5. **Map every record** (§6.2) into `<staging>/works/<id>/work.json`, with its exports, `patch.diff` and
   `untracked.json` (unpacked into `untracked/`), **copied, never hard-linked** (round 2, M-a), so no v1 file shares
   an inode with a v0 file. Every file is written atomically and fsynced. The ledger's copy-on-write rule (§2.2) is
   a second guard: even a linked file would be replaced, never written through. The cost is disk space: one copy of
   the v0 exports. A work whose machine is found in no region keeps `region: null` and `machineId:
   null`, and reads as `gone`; only `boxd_drop` with `confirmGone: true` or `boxd_resume` (which then picks a region)
   act on it.
6. **Record failures:** a v0 record that cannot be read or mapped is listed in `<staging>/import-v0.json` with
   its reason. Its work id is **blocked**: every tool answers `IMPORT_V0_FAILED` for it, and `ensure` never opens a fresh
   record over it, so a later fix can still import it. A restart after the v0 file is fixed or removed reruns the
   import **for blocked ids only, into the published `v1/`**: it takes the import lock and then each blocked work's
   lock, writes each record and its files by the copy-on-write rule (§2.2), and removes the id from the blocked list
   last. Until then, that id stays blocked; every other work runs normally.
7. **Write the marker and publish:** `<staging>/complete` (counts and a digest of the input file list), fsync the
   folder, **check that the lock still holds this run's token** (a run whose lock was taken over stops here and
   deletes its staging folder), then `rename(<staging>, v1)` in one step, then release the lock. A `rename` onto an
   existing non-empty `v1/` fails, so two runs can never both publish.
8. **Leave a note for people:** write `works/README-MOVED-TO-v1` beside the v0 records. v0 ignores files it does not
   know, so this is the only change to the v0 tree.

**Until step 7 has finished, no tool reads or writes a ledger.** Every tool, reads included, answers `LEDGER_IMPORTING`
with `progress: { done, total }` and `next: "the same call in a few seconds"`. Nothing falls back to a partial ledger,
and `ensure` cannot adopt a machine whose record has not been imported yet. 170 works take a few seconds: step 4 is 170
`get`s through 12 slots, and the rest is local file work.

**Going back to v0.0.6** (M9) is safe **only before the first v1 change.** After v1 has submitted, harvested, dropped
or reassigned anything, the v0 records still carry their old `proof`, and v0's drop could accept a proof that v1's
later prompts made stale, and destroy unharvested work. The note from step 8, the README and the CHANGELOG all say
so. (v1 does not edit the v0 records to fence them: the import promises to leave v0 as it found it.)

### 6.2 Field map

| v0 (`src/ledger.ts:52-81`) | v1 |
|---|---|
| `workId`, `machine`, `laptopDirectory`, `guestDirectory`, `repo` (string) | the same; `repo` → `{ url }` |
| — | `region` from the fresh listing, or `null` when the machine is in no region; `machineId` from `machine get` (step 4), or `null` |
| `snapshot` | `image: { name, opencode: null }` (resume rebuilds from it while its OpenCode matches the laptop's) |
| `vcpu` | `size: "<v>x<4v>"`, or the size the listing reports |
| `model` | `model` |
| `rootSessionId` | `session.rootId`; `session.notify` stays unset until the next submit |
| `lastSubmitAt` | `lastSubmit: { at, delivery: "steer" }` (what v0 actually did, F5) |
| `proof` `{harvestedAt, guestVersion, sessions[{remoteId, importedId, parentRemoteId}], sha256}` | `saved: { at, complete: true, guestVersion, sessions: [{ id: remoteId, parentId: parentRemoteId, sha256, lastMessageId, messages, updated }] }`, with the last message id, the message count and the update time read
from the stored export file. `saved` stays `fresh` or `stale` exactly as `proof` was. When `importedId` ≠ `remoteId` (no tested host does this), the laptop id is kept as `laptopId`. |
| `lastOutcome {state, error, at}` | `run: { outcome, error, at }` |
| `git` | `gitState` (the same fields) |
| `warnings` | carried into `warnings` |
| `uploads`, `downloads` | `files.in`, `files.out` |
| `sleptAt` | `slept: { at, by: "boxd_sleep" }` |
| `pendingCreate {at, snapshot}` | `pendingCreate: { at, image: snapshot }` |
| `dropped: true` | `state: "closed"`, `closed: { how: "dropped" }` |
| — | `guestHelper: "v0"`, `importedFrom: "v0"`, `format: 1` |

Because of F1, the laptop's OpenCode may hold an older transcript than the stored export for any work harvested more
than once. Each imported work is marked `laptopCopy: "unverified"`, and its next harvest replaces the copy. An
`attention` reason, `laptop-copy`, lists the works that need it, and `boxd_harvest({ works })` fixes them in one call.

### 6.3 Running guests

A v0 guest has its helper and its server password in `/tmp/opencode-boxd/`, and an `opencode serve` started with that
password. v1 keeps both in `~/.opencode-boxd/`.

- **Reads** on such a work use v0's own helper, read-only (§3.2): its `phase` action answers the watcher, `boxd_status`
  and `boxd_job`. Nothing is copied to the machine and the ledger is not written (M2).
- **The first change tool** for the work (`ensure`, `submit`, `harvest`, `sleep`, `resume`, `drop`, `reassign`,
  `exec`), under the machine lock, copies the v1 helper up and runs its `adopt` action once: when
  `~/.opencode-boxd/password` is missing and `/tmp/opencode-boxd/password` exists, it copies that file (0600). It then
  sets `guestHelper: "v1"`. The running server and its session are untouched, so a busy work stays busy.
- A v0 guest whose `/tmp` a reboot cleared has no helper and no running server: reads answer `GUEST_FAILED` with
  `next: boxd_ensure({ workId })`, and that `ensure` sets the machine up as v1 does for any work.

`adopt` and the v0 read fallback live in the import module, and go away with it.

---

## 7. Testing

### 7.1 Unit (no real boxd, no real model)

- **Runner (package A):** an instrumented fake spawn shows peak children ≤ 12 in the shared slots, background ≤ 4,
  exec lane ≤ 4, imports ≤ 2, under 300 queued calls **with a golden build in flight**, and no deadlock (the lock
  order of §4.1). Machine locks order changes; reads are single flight; a timeout kills the child (SIGTERM, then
  SIGKILL); an abort kills in-flight children and drops queued ones; the output cap kills an over-large child.
- **The read rule:** a read exec with a listing older than 2 s, or for a machine not `running`, is refused by the
  runner; status never reads an `idle` work's guest; no read spawns `machine cp` or writes the ledger.
- **`boxd_exec`:** four 600 s execs on one machine do not delay that work's `submit` with `interrupt`, its `job`, or the
  watcher; a fifth waits in its lane. Quoting round-trips `["a b", "f;rm", "it's"]` exactly.
- **Acting by id:** `oc-x` re-pointed to another id before `drop`, `sleep`, `resume`, `ensure` (resize, reboot) or
  `reassign` → `NOT_OURS`, and the fake CLI shows nothing removed, renamed, resized or rebooted.
- **Gone:** drop closes as gone only with a fresh all-region listing and not-found `get`s of the id; a cached listing,
  a failed listing, an "in nyc" hint, or a machine found under another name never closes; `machineId: null` needs
  `confirmGone`.
- **Drop against the guest:** a session that gained a message after the harvest, or a new child session, → `NOT_SAVED`;
  a session whose `updated` moved with no new message (a new title) still drops (L-d).
- **Adoption (L-b):** an `oc-<id>` without `owner=opencode-boxd`, or v0's `role=session` and `work=<id>`, is refused
  `NOT_OURS`, and adopted only with `adopt: true`; the fake CLI shows no setup, clone or resize on it before then.
- **Lock order (L-h):** two processes reassign `a→b` and `b→a` at once: one finishes, the other answers a refusal, and
  neither waits for a stale takeover. A machine lock held across a rename stays the same lock (keyed by id).
- **`B` for single calls (L-e):** a single `ensure` that must build an image and clone a slow repository answers
  `creating`/`starting` at `B`; the fake guest's clone keeps running, and the next call joins it.
- **Spawn budget:** a harness counts the fake CLI's spawns per call and checks every row of §4.4.
- **List forms:** mixed results keep input order; one bad item fails validation before anything runs; waiting items
  hold no item slot (300 waiting items with 8 slots still let a new active item start at once); at the bound, items
  that progressed answer their real state and items never started answer `cancelled` with `started: false`; an abort
  mid-list gives `cancelled` with `uncertain` for an in-flight write.
- **Regions:** `auto` picks by free machines after `keepFree`, counts in-flight creates, prefers a region with the
  image, and answers `MACHINE_LIMIT` with the right numbers. Two regions holding `oc-<id>` → `NOT_OURS`.
- **Stderr table:** every pattern from the live check, as fixtures. `unknown flag` and `no machine "oc-x" in fra`
  for a work recorded in `nyc` are **not** `missing`.
- **Ensure state machine:** new, adopt, wake, resize-when-idle, upgrade-when-idle, agent-silent → reboot once →
  `AGENT_UNREACHABLE` the second time, and `repair: "reboot"`.
- **Submit modes:** the helper is asked for `delivery: "steer"` or `"queue"`, or for interrupt then prompt; a model
  switch on a busy session refuses unless `interrupt`.
- **Harvest:** delete then import, parents first; a failed import keeps the file; partial keeps `saved: stale`; the
  sha256 mismatch → `EXPORT_INVALID`.
- **The last good export survives (M-a):** a `cp` cut off half-way, one that times out, and one with the wrong digest
  each leave the stored export byte-identical and no temp file behind; `saved` is unchanged; `boxd_resume` then
  rebuilds from the old, complete set. The same for `patch.diff` and `untracked/`. After a v0 import, a second harvest
  leaves every v0 file byte-identical (and no v1 file shares an inode with one).
- **Ledger:** two processes writing one work (child processes in the test) lose nothing; a stale lock is taken over;
  the index refreshes by mtime; a crash between the temp write and the rename leaves the old record.
- **v0 import:** fixtures for every v0 shape (v0.0.0, v0.0.3, v0.0.6 records; proven, stale, never prompted, dropped,
  `pendingCreate`, uploads and downloads, a corrupt file). Each field maps as §6.2 says; v0 files are byte-identical
  afterwards (only `README-MOVED-TO-v1` is added); a second start does not import again.
- **Import crash safety (H1):** kill the import (a child process) after N records for several N, then restart: the
  staging folder is discarded, the import reruns, and the published `v1/` holds every record. A tool call during the
  import answers `LEDGER_IMPORTING` and writes nothing; `ensure` for a not-yet-imported id answers `LEDGER_IMPORTING`,
  not a fresh record. A failing all-region listing leaves no `v1/` and answers `IMPORT_V0_FAILED`. A corrupt v0 record
  blocks only its own id. Two processes start at once: one imports, the other answers `LEDGER_IMPORTING`. A run whose
  lock was taken over (L-a) writes only into its own staging folder and does not publish; the rerun for a blocked id
  takes the import lock and the work's lock and writes atomically into the published `v1/`.
- **Notices:** coalescing per session and at most one per 60 s per target; the text holds no guest text (a test feeds
  a `lastText` containing an instruction and checks it is absent); a failed run whose error name is not in §5 appears
  as `RUN_FAILED` (L-f); an RPC submit without `notify` keeps an earlier subscription and adds none; a submit from a
  subagent session subscribes the root of its tree (M-b); a target that is gone, archived or now has a parent gets no
  notice, and a refused wake is retried once as queue only; `off` posts nothing.
- **Status size:** 300 works in trouble give at most `limit` items, `more`, and folded `groups`; a `since` older than
  the log answers `cursorExpired: true`.
- **Golden scrub:** a base with a session in its database fails `GOLDEN_BUILD_FAILED`; a base with an `auth.json`
  fails `GOLDEN_HAS_CREDENTIAL` with the supported ways as `next` (M-c); a build with no provider secret in
  `env list` succeeds with `warning: "NO_MODEL_CREDENTIAL"`; nothing
  saves an image from a work; `ensure` picks only `<prefix>-<version>-<size>`; `prune` never removes an image an open
  work records.
- **Cost and cleanup (§C, package E):**
  - *Creation flags:* every create carries `--auto-suspend-timeout 0 --auto-hibernate-timeout 7200
    --idle-ignore-outbound=off`, and `--delete-after` only with `leaseDays`.
  - *Automation:* a work that goes idle is harvested and then slept after `autoSleepMinutes`, and a new prompt in that
    window cancels it. A failed harvest still sleeps (`UNHARVESTED_SLEEP`). A `needs-input` work is not slept. An
    orphan (notify target deleted or archived, or untouched for `orphanHours`) is harvested and slept, and a busy
    orphan is left to finish. Nothing automatic ever calls drop, remove or a delete timer (a test greps the
    automation module's calls and asserts on the fake CLI's log). Only the `automation.lock` holder acts, and two
    processes never harvest one work.
  - *Automation and access (M-2):* automation is on at `"all"` with `automation: "auto"`, and off at `"ask-changes"`
    and `"read-only"`, where the fake CLI shows no harvest or hibernate. `automation: "on"` turns it on at every level,
    and `"off"` turns it off at `"all"`. Creation flags are the same at every level. Status shows the matching
    `automation` value.
  - *Idle reads:* the only guest read for an idle work is the one just before automation acts.
  - *Lease:* renewed at most once per 6 h, by id, on change calls **and** by the automation owner for busy or unsaved
    works that nobody calls (a 3-day busy work with `leaseDays: 1` and only notices is never deleted while the plugin
    runs; L-2). `LEASE_EXPIRING` 24 h ahead, and an idle work is harvested then.
  - *Estimates:* `perHour` and the savings match hand-computed figures from fixed rates and readings, in EUR and USD.
    The public rates are used and marked for a member.
  - *Selectors:* each `select` matches exactly its table row. `dryRun` changes nothing.
    `boxd_drop({ select: "saved-finished" })` runs the full guard per work, and a work that moved on stays
    (`NOT_SAVED`).
  - *Budget:* `warn` warns. `refuse` refuses `ensure`, `resume`, `submit` to a hibernated work and `exec` with
    `wake: true` (L-1). A submit or exec on a running machine passes, and sleep, harvest and drop still run. An
    unmeasurable budget gives `BUDGET_UNKNOWN`, and `refuse` then acts as `warn`.
  - *Context hook (M-1):* the line appears only for a session that owns works, at most 240 characters, with no guest
    text (an injected `lastText` is absent).
    - `system` stays byte-identical to the host's input on every request, with or without the line.
    - The line is the last text of the last message: a part on a final `user` message, or one new `user` message after
      a final `tool` message.
    - It is added on the first request after the fingerprint changes, and not on the next requests while the
      fingerprint is unchanged.
    - The ledger and the session history never contain it.
  - *Compaction hook:* the works part sits on the tail of `messages`, and names at most 30 ids.
  - *Idle check:* it speaks only when money burns and automation will not act, stays silent for an unchanged
    fingerprint, and speaks at most once per 30 min per session. A note tagged `metadata.boxd = "idle-check"` that is
    the session's newest input keeps the next idle silent (L-4). A loop test drives 10 idle cycles with no other
    input and counts exactly one note, then 50 cycles across 5 state changes and counts at most 5.
  - *`/boxd-cleanup` (M-3):*
    - The report changes nothing.
    - At `"ask-changes"` each action asserts the tool's own action once, and the fake permission host records exactly
      one ask per action, never two.
    - At `"all"` each action asserts `boxd_cleanup`, which the default rules set to ask.
    - At `"read-only"` nothing is asserted or changed.
    - A "no" or a deny changes nothing.
    - The asserted resources are exactly the ids acted on.
    - No session message, synthetic or otherwise, carries anything that could approve an action.
- **Declaration and docs:** jelly equals the registry (12 tools, 3 read-only); every code has a README row and a docs
  row; the skill names only real inputs.

### 7.2 Host suites, on all six stock hosts (2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7, 2.3.0)

With the public `@opencode/sdk`, the extended fake boxd CLI (`test/host/fake-boxd.mjs`: regions, `--region all`,
machine-limit, usage, rename, reboot, label, a configurable latency, an injected "VM agent" failure) and the fake guest:

- registration and schemas of the 12 tools; the default rules for each `access` value; every change asserts;
- the RPC methods with `call.signal`: a stopped long `boxd_ensure` answers `cancelled` and leaves no child behind;
- 2.3.0's cooperative Stop through `context.signal` on the model path;
- `ctx.session.synthetic` delivers a notice into the calling session on every host, with `resume` false and true; a
  notice to a deleted session fails cleanly and is recorded;
- **the coordinator, not the subagent (M-b, L-c):** a `boxd_submit` made inside a task-tool subagent's session, and one
  made from a Code Mode program, both subscribe the root coordinator session; a notice then reaches the root and never
  the subagent, on every host. `ctx.session.get` returns `parentID` on every host (checked here, since the walk depends
  on it);
- **read-only means read-only (M2):** with `access: "read-only"` and an imported v0 work, `boxd_status`, `boxd_job`
  and `boxd_read` spawn no `machine cp`, run no `adopt` or `setup`, and leave the ledger's bytes unchanged;
- **the stall test (package C, host side):** a Code Mode program runs 50 `boxd_ensure` calls at once, and a list form
  of 300 `boxd_submit`s, against a fake CLI with 1–3 s latency. It asserts peak children within the caps and an
  event-loop delay under 150 ms in the server process, sampled by the test;
- **the longest call the host allows:** a tool that sleeps on its signal for 2, 5, 10 and 20 minutes, called from the
  model path, from Code Mode and from the tools RPC, on every host. The shortest limit found, less 30 s, becomes the
  list bound `B` (§4.2). If a host has no limit, `B` stays 4 minutes;
- **the cost hooks on every host (§C.4):**
  - `ctx.session.hook("context")`, `hook("compaction")` and `hook("experimental.idle")` register and fire on each of
    the six hosts. The mock provider records the requests:
    - **Cache stability (M-1):** two requests in a row from an owner session, with the fleet changed in between, have
      byte-identical system parts. The line is only in the tail of the first request after the change, and absent from
      the next request while nothing changes. Another session's request never carries it.
    - A compaction request carries the works part on its tail. An idle note is admitted once, runs in the same
      execution, and its `metadata.boxd` is readable through `ctx.session.context` (L-4).
  - `ctx.event.subscribe` delivers `session.deleted` and `session.archived`, and the work becomes an orphan.
  - On a host where a hook fails to register, status names it and automation still runs.
  - **`/boxd-cleanup` confirms through `ctx.permission.assert` with no `source` (M-3):** on every host, the assert from
    a command raises the host's permission prompt for the person, a test client answers it once as the person, and
    nothing in the session's messages carries the prompt. At `"ask-changes"` there is one prompt per action, and at
    `"all"` one `boxd_cleanup` prompt per action. A rejection leaves the fake CLI's log empty. The TUI's buttons run the
    same command.
- the prover on every stock binary: a second import of a changed transcript is replaced (F1), and `delete` of an
  absent id exits 1 and is read as "absent".

### 7.3 Live check against real boxd

The in-VM CLI on this machine is refused by design (`src/cli-flavor.ts`), acts in one region only, and has no
`manage usage` for other machines. So the live check runs the **laptop CLI** (0.3.5 or later, checked against boxd's
manifest), installed on this VM in an isolated HOME, **if the owner mints a short-lived key for it**
(`boxd auth keys create live-check --expires-in-secs 86400`, passed as `BOXD_TOKEN`, never written to disk or a
transcript). Machine usage is for org owners and admins, so L3's cost part needs an owner's or admin's key; with a
member key, L3 checks only the `null` answer, and the doc records that cost was not verified live. Steps L1–L11 run
here, in both regions. L12 and L13 need the owner's Mac.

**Without a key,** the release rests on the unit and host suites (§7.1, §7.2) and the facts already measured
(`docs/architecture.md`, the reviewer's checks of CLI 0.3.5 `--help`). The CHANGELOG and `docs/live-check.md` then say
which items L1–L13 were not run, and the steps stay ready for the owner to run.

| # | What it checks |
|---|---|
| L1 | `--region` on every verb the plugin uses; `machine list --region all --json` keys (the region column, `id`, `isolated`?); every verb the plugin uses accepts a machine **id** (`exec` and `cp` included), and `machine new --json` carries `id`. |
| L2 | `machine new --from-snapshot X --auto-suspend-timeout 0 --auto-hibernate-timeout 7200 --idle-ignore-outbound=off --delete-after 1d` is accepted and `machine get` shows each value; `--vcpu` with `--from-snapshot` is refused, with its exact words. A guest left idle with an outbound poller stays `running` (the case layer 2 exists for). `machine usage` of one work, running idle, then hibernated, confirms the per-hour figures of §C.1 within boxd's 25-minute lag. |
| L3 | `manage machine-limit --json` with `regions`; `manage usage --json` and `machine usage --json` keys, and who may read them. |
| L4 | The exact stderr for a missing machine in each region, for a name that exists only in the other region (the "There is a machine … in nyc" hint), and for a `get` by an id that no longer exists. |
| L5 | `MACHINE_LIMIT`: a scratch org without a payment method is capped at 2 machines (boxd docs), so the third create shows boxd's exact words. |
| L6 | Resize 10+ machines at once; capture `cannot connect to VM agent`; check that one `machine reboot` fixes it. |
| L7 | `boxd_golden` from stock in `fra` and `nyc`: the time, the 401/200 password probe, the env file removed, and a work created from it at the image's size with no reboot. |
| L8 | `steer`, `queue` and `interrupt` against a real cheap model, on a task that steps every few seconds, and on one blocked in `sleep 120`: steer lands at the next step, and only interrupt reaches the blocked one. |
| L9 | `machine rename <id> <new> -y` reboots the machine, and `machine label set <id> work=<new>` takes effect. |
| L10 | Harvest twice: the laptop copy changes the second time (F1). A `boxd connect` prompt after the harvest makes drop answer `NOT_SAVED` (M3). |
| L11 | v0 import against a copy of a real v0 ledger (the owner provides a tarball) in an isolated HOME: kill it once mid-way, restart, and compare; then one running guest is read through its v0 helper with no upload, and adopted by the first change. |
| L12 | Owner's Mac: first reproduce the stall on v0.0.6 (24 parallel `boxd_ensure` with the real OpenCode server); then the same on v0.1.0, with `health.loopLagMaxMs` and no "Event stream stalled". Without the reproduction, the fix is not shown to address the cause. |
| L13 | Owner's Mac: the macOS config path and the PATH the server sees. |

Every machine the live check creates carries `--label role=live-check` and `--delete-after 2h`.

---

## 8. Upstream asks for boxd

A list the owner can forward:

1. **`env set --secret` reads the value from stdin** when stdin is not a terminal (or with `--value -`). Today the
   value is an argument (visible in `ps`) or a terminal prompt, so a refresh script needs `expect`. (#1)
2. **Credentials that refresh on boxd's side:** boxd holds the GitHub App key and mints installation tokens as a
   host-bound secret, so a sleeping laptop does not stop every guest. 15 sessions stopped on 401s in #1. (#1)
3. **Skip the update banner when stderr is not a terminal**, or honour `BOXD_NO_UPDATE_CHECK`. Every `machine exec`
   prints it. (#1)
4. **Secret metadata:** `created_at` and `updated_at` in `env list --json`, so a tool can warn about an old token.
   (#1)
5. **Structured errors in `--json` mode:** `{"error": {"code": "machine_limit" | "not_found" | "agent_unreachable" |
   …, "region", …}}`. Parsing English stderr is how the plugin decides "missing", which is safety-critical (F4).
6. **The VM agent after a resize:** 12 of 26 machines resized at once never answered until a reboot. Fix it, or make
   `resize` wait for the agent and reboot by itself. (#14 §6)
7. **Size at restore:** allow `--vcpu`/`--memory` with `--from-snapshot` when the snapshot fits, applied before boot,
   so a sized machine needs no image per size.
8. **Copy a snapshot to another region:** `snapshots copy <name> --to-region nyc`, so one golden image serves both.
9. **Why and when a machine went to sleep:** `hibernated_at` and `hibernated_by` (`idle`, `user`, `api`) in
   `machine get` and `machine list`. (#1)
10. **Usage for members, or by label:** `manage usage --label role=session`, readable by the machine's owner.
11. **Machine specs in the CLI** (`machine new --spec spec.json`), so a work can list the unattached secrets it needs
    instead of every private machine getting every private secret.
12. *(Dropped after review: the laptop CLI 0.3.5 already has `machine label set/remove/clear`.)*
13. **Fewer processes for many short calls:** a long-lived `boxd` session (JSON-RPC on a unix socket, or `machine exec`
    taking many machines) for a laptop driving hundreds of machines.
14. **`machine list --json` with `id` and `isolated`,** which `machine get` has and `list` does not. With `id` in the
    listing, the gone check (§3.9) and the import (§6.1 step 4) need no `get` per machine.
15. **`machine exec --no-wake`:** fail instead of waking a hibernated machine. It closes the 2 s race in the plugin's
    read rule (§4.1), where a machine that hibernates between the listing and the exec is woken by a read.
16. **A docs fix for the in-VM `AGENTS.md`** (`~/.config/boxd/AGENTS.md`, the file boxd puts on every machine). It
    says "Standby VMs consume zero CPU and zero billable memory", which contradicts boxd's pricing page, its pricing
    FAQ ("RAM bills … while it is running or in standby") and its suspend guide (standby bills "memory in use"). Agents
    read that file, so it steers them towards standby, which saves almost nothing, instead of hibernation (round 4, L-3).

---

## 9. Delivery

### 9.1 Packages

**Day 0**, by the lead, one PR that every package codes against:

- `src/ports.ts`: the runner (lanes, locks, the read rule, by-id), the boxd port with regions, and the guest port with
  its v1 actions; and **the watcher's event stream** (round 4, L-5), which D emits and E consumes: `WorkEvent { seq,
  at, workId, from: Phase, to: Phase, outcome?, code?, needsInput?, reading?: { residentGiB, load1 } }`, with
  `subscribe(listener): () => void`, plus the fleet snapshot E reads for the cost estimate;
- `src/ledger/types.ts` (format 1) and `src/results.ts` (the result shapes and the list envelope);
- `src/errors.ts`, with every code in §5;
- `src/tools.ts` as a **registry skeleton**: all 12 names, schemas, classes and descriptions, each run a stub, plus the
  `jelly` block, `src/permissions.ts` and the jelly test, so the declaration is settled once and never edited by two
  packages;
- the spawn-count harness's interface (a fake CLI that counts spawns per call).

After Day 0, every file belongs to exactly one package (M8):

| Package | Owns | Must prove |
|---|---|---|
| **A. Runtime** | `src/exec/runner.ts`, `src/boxd/*` (CLI port v1: regions, list-all, limit, usage, create flags, by-id verbs, rename, reboot, label; the stderr table), `src/guest/*` (laptop side), `guest/guest.py` v1 (at the stable path `~/.opencode-boxd/guest.py` with a protocol version; `setup`, `serve`, `prompt` with delivery and interrupt, `phase`, `export` to file, `read`, `upgrade`, `health`, `git` with the session marks), `test/host/fake-boxd.mjs`, the spawn-count harness | §7.1 runner tests (caps, lanes, lock order with 300 items and a build in flight, the read rule, the exec lane, by-id), stderr table; the fake CLI covers every verb; the helper's own tests |
| **B. Ledger and import** | `src/ledger/*` (format 1, cross-process lock, index, `events.jsonl` with `cursorExpired`, `saved`), `src/import-v0.ts` (staging, publish, blocked ids, `adopt`, the v0 read fallback), the prover (delete then import) | §7.1 ledger, import and import-crash tests; the prover on all six stock binaries (F1) |
| **C1. Machines** | `src/fleet/ensure.ts`, `golden.ts`, `regions.ts`, `reassign.ts`, `resume.ts`, the shared list-form runner `src/fleet/list.ts` | §7.1 regions, ensure state machine, golden scrub, list forms; their §4.4 rows; §7.2 the longest-call measurement |
| **C2. Sessions** | `src/fleet/submit.ts`, `harvest.ts`, `sleep.ts`, `drop.ts`, `exec.ts`, `read.ts` | §7.1 submit modes, harvest, drop against the guest, gone, by-id; their §4.4 rows; §7.2 signal and Stop, read-only host test, the host-side stall test |
| **D. Fleet view, notices and docs** | `src/fleet/status.ts` and `src/fleet/job.ts` (the `boxd_status` and `boxd_job` runs), `src/status.ts` (the `/boxd-status` model), `src/watch.ts` (watcher and notices), `src/tui.ts`, `skills/boxd/SKILL.md`, README, `docs/` (architecture, configuration, live-check, `golden-image.md` → `images.md`, which drops v0's `auth.json` fallback and states the credential rule and its three supported ways from §2.3, scripting), CHANGELOG | §7.1 notices and status size; their §4.4 rows; §7.2 synthetic on every host; docs test (every code has rows) |

| **E. Cost and cleanup** | `src/cost/*` (rates, the per-hour estimate, today, savings, the budget), `src/automation.ts` (auto-harvest, auto-sleep, orphans, lease renewal, `automation.lock`), `src/hooks.ts` (the `context`, `compaction` and `experimental.idle` hooks and the session events), the `/boxd-cleanup` command (its `permission.assert` confirmations) and its TUI buttons, the `boxd_cleanup` default rule, the `jelly.cost` sentence, and the `cost` and `cleanup` blocks that D's status includes | the §7.1 "Cost and cleanup" tests and the §7.2 cost-hook tests. E calls C2's sleep and harvest runs and never drops. C1 owns the creation flags, `leaseDays` at create and the budget check in `ensure`/`resume`; C2 owns `select` and `dryRun` |

If only three people are available, C1 and C2 are one package, C, done in the order C1 then C2, and E is done by D's
owner after the watcher.

Order: Day 0 → A and B (no dependency on each other) → C1, C2, D and E on A's fakes and B's ledger (E on D's watcher
events and C2's runs, through their Day-0 interfaces), each filling its own
stubs in the registry → integration on one branch → the live check (L1–L11 here if the owner provides a key, then
L12–L13 by the owner) → the release-prep PR → `gh workflow run release.yml` → the owner approves.

Kit r4.1 files stay untouched (`scripts/check-copies.mjs`; `src/host/tools-rpc.ts` changes only between its
`PLUGIN-SPECIFIC` markers). The host range stays `>=2.2.3 <2.4.0`, tested on 2.2.3–2.2.7 and 2.3.0. No runtime
dependencies.

### 9.2 Options in v0.1.0

| Option | Default | Note |
|---|---|---|
| `access` | `"all"` | Unchanged (OD-29). |
| `allowedRoots` | `[]` | Unchanged. |
| `allowUntestedHost` | `false` | Unchanged. |
| `region` | `"auto"` | `"auto"`, `"fra"` or `"nyc"`. |
| `keepFree` | `{ "fra": 0, "nyc": 0 }` | Machines `auto` leaves free in each region, for the org's CI pool (Q4). |
| `size` | `"2x8"` | The default size. |
| `git` | none | `{ name, email }` for every new work. |
| `goldenPrefix` | `"oc-golden"` | Image names are `<prefix>-<version>-<size>`. |
| `goldenBase` | `"stock"` | Or a snapshot name to build from (Q1). |
| `goldenSetup` | none | A laptop script (inside a root) run on the builder. |
| `buildGolden` | `"auto"` | `"auto"` or `"never"`. |
| `notices` | `"wake"` | `"wake"`, `"queue"` or `"off"` (Q2). |
| `autoHibernateMinutes` | `120` | The platform's idle bound set at creation (§C.2); 30 to 1440. Auto-suspend is always off. |
| `automation` | `"auto"` | `"auto"`: on at `access: "all"`, off otherwise. `"on"`: the person's consent at every access level. `"off"`: never (§C.3). |
| `autoSleepMinutes` | `10` | Harvest, then sleep a finished work after this many idle minutes (§C.3), when automation is on; `0` turns the auto-sleep step off. Setting it is not consent. |
| `orphanHours` | `12` | A running, not-busy work untouched this long is harvested and slept (§C.3). |
| `leaseDays` | `0` (off) | A `delete-after` timer renewed on activity (§C.2). Off, because boxd deletes unsaved work too. |
| `budget` | none | `{ daily, action: "warn" \| "refuse" }`, in the org's billing currency, machine cost only (§C.5). |
| `costContext` | `true` | The context line and the compaction part (§C.4); `false` turns both off. |
| `idleCheck` | `true` | The end-of-turn check (§C.4); `false` turns it off. |

Removed: `snapshot` (it becomes `goldenBase`).

### 9.3 CHANGELOG, "Breaking" section (draft headings)

- Tools: `boxd_image` is replaced by `boxd_golden`; `boxd_read`, `boxd_exec` and `boxd_reassign` are new; every
  result has `state`, and list forms return `{ state, counts, results }`.
- `proof` is now `saved` (`fresh`, `stale`, `none`); `NOT_PROVEN` is `NOT_SAVED`; `SNAPSHOT_MISSING` is
  `GOLDEN_MISSING`; `SNAPSHOT_EXISTS`, `PARENT_MISSING` and `GUEST_RUN_FAILED` are gone.
- `boxd_submit`'s `queued` is replaced by `delivery` (`steer`, `queue`, `started`), and `mode` chooses it.
- `vcpu` is now `size`; `wait` is now `"ready" | "created" | "none"` and defaults to `"ready"` (`"created"` for a list
  of more than 50).
- The ledger moves to `~/.local/share/opencode-boxd/v1/`; v0 records are imported once, all or nothing, and left
  untouched apart from a `README-MOVED-TO-v1` note. **Going back to v0.0.6 is safe only before v0.1.0's first
  change** (a submit, harvest, drop or reassign): after that, v0's drop could accept a stale proof.
- Every change acts on the machine id the ledger recorded; a name that points at another machine is refused.
- `boxd_golden` never saves a work's machine; `boxd_image`'s path is gone.
- Notices go to the calling session on the model path only; a script names a session with `notify`.
- The guest helper lives in `~/.opencode-boxd/` on the machine, not `/tmp`.
- The option `snapshot` is now `goldenBase`; images are built by the plugin and named by OpenCode version and size.
- **Model credentials are never baked into an image.** A base that holds `auth.json` is refused
  (`GOLDEN_HAS_CREDENTIAL`), so v0's fallback of `opencode auth login` on the image builder is gone. Give works a key
  as a sealed, host-bound `boxd env` secret, or sign in on one work's own machine after `boxd connect`.
- Harvest never overwrites the last good export until the new one is verified.
- **Cost and cleanup.** Every new work machine is created with auto-suspend off, auto-hibernate at 2 h and
  `idle.ignore-outbound` off, at every `access` level. At `access: "all"` the plugin now harvests a finished work
  and then hibernates it after 10 idle minutes, orphans included; at "ask-changes" and "read-only" only with
  `automation: "on"`, which is the person's consent. It never drops anything by itself. `boxd_status` adds `cost` and
  `cleanup`; `boxd_sleep`, `boxd_harvest` and `boxd_drop` take `select`; `/boxd-cleanup` is new and confirms each
  action with a permission prompt only a person answers. A coordinator session gets one short fleet line at the end of
  a request when the fleet changed; the system prompt is never changed, so the prompt cache holds. The new options are
  `automation`, `leaseDays` and `budget`; the last two are off by default.
- Fixed: a second harvest now replaces the laptop's copy of the transcript (F1); Stop now ends a tool call and its
  processes (F2).

---

## 10. Questions only the owner can answer

The owner has not answered yet. The design goes ahead with the recommended default for each question. Each one can
change later without changing the design.

- **Q1. The golden base.** Does today's `opencode-golden` carry anything besides OpenCode (tools, config, skills, git
  settings)? **Recommended default: build from stock** (`goldenBase: "stock"`), with an optional base snapshot and
  `goldenSetup` script for anyone who needs more. If `opencode-golden` does carry more, set
  `goldenBase: "opencode-golden"` in `fra` and write a `goldenSetup` for `nyc`. Either way, every build is scrubbed
  (§2.3). **Also: does `opencode-golden` hold an `auth.json`** (v0's documented fallback)? If so, it cannot be a base
  until that file is removed, and works need their model key from a sealed `boxd env` secret instead (§2.3).
- **Q2. Notices.** Should a work's change start an idle coordinator's turn, or wait for its next turn? **Recommended
  default: `"wake"`**, as #14 asked, now limited to model-path coordinators and at most one notice a minute each
  (§3.13). The reviewer recommends `"queue"`; it is one option away.
- **Q3. The import exception.** The v0 import needs a written, time-limited exception to AGENTS.md's "no migration
  code" (§6; removed in v0.2.0). **Recommended default: allowed.**
- **Q4. The CI reserve.** How many machines should `auto` leave free per region for the org's CI runner pool?
  **Recommended default: configurable with `keepFree`, default 0** in each region.
- **Q5. The live check.** **Recommended default:** run L1–L11 on this VM with a short-lived key (24 h; an owner's or
  admin's key if cost is to be checked) **if you provide one**, plus a copy of a real v0 ledger for L11. **Without a key,
  the release rests on the unit and host suites only,** and the docs say which live items were not run. L12–L13 need
  your Mac either way.
