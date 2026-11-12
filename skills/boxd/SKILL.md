---
name: boxd
description: Run an OpenCode session on a private boxd machine and keep the transcript on this laptop. Use when the user says boxd, a cloud machine, a remote machine, a snapshot, or moving sessions off this computer.
---

# boxd

The laptop is the source of truth. A machine is a cache with more CPU, and a boxd snapshot is an image, not a session.
Read a tool's description before its first call; the input names below are the real ones.

## The order

1. `boxd_ensure` with a short `workId`, such as `review-api`. The machine is named `oc-<workId>`. Pass `directory` when
   the guest should work somewhere other than `/home/boxd/work/<workId>`, and `repo` for an https GitHub URL to clone.
2. If it returns `starting`, stop and call `boxd_status` in a later turn. Do not poll in this turn.
3. `boxd_submit` with the `workId` and the `text` to admit. It returns when the prompt is admitted, not when the model
   finishes. Keep the `sessionId` it returns.
4. `boxd_job` with the `workId` on a later turn: `busy`, `idle` or `missing`. One check, no waiting.
5. `boxd_harvest` with the `workId` and the `localDirectory` that receives the import. The session tree is imported
   here parents first, and git is recorded beside it.
6. `boxd_sleep` to hibernate (it keeps the disk and works without a harvest), `boxd_drop` to destroy, `boxd_resume`
   after a shutdown, `boxd_image` to save a snapshot.

`boxd_status` reads the ledger and each open work's machine state. It starts nothing, and it is the one call worth
making before anything else on a new turn.

## What to say before a call

Every machine change runs under `access`: with `all` (the default) it runs with no prompt, `ask-changes` makes the
prompt the yes, and `read-only` denies it. Say in one sentence what the call does and what it costs, then make the one
call: creating or waking a machine bills while it runs, `boxd_submit` runs the model on that machine, and `boxd_drop`
destroys it.

Ask in chat only when a choice must be made: a work id in use, a snapshot name, a directory, or a machine name that is
not the one the ledger records. After a decline, say nothing changed and offer the draft task.

## Report the truth

Never report work as done when the outcome is not `completed`. `boxd_job` and `boxd_harvest` give the guest session's
last outcome: `completed`, `failed` or `aborted`, with a failed run's error. A `failed` run means the model never did the
task, even when the transcript arrived; say what the error says, and fix a credential failure before another prompt.

## Do not

- Do not call `boxd_image` or `boxd_drop` until `boxd_harvest` has returned `proven` since the last `boxd_submit`.
  Both refuse, with `NOT_PROVEN`. `boxd_sleep` is always safe: it keeps the disk.
- Do not destroy a machine to restart a session. `boxd_resume` wakes it, or rebuilds it from the golden snapshot and
  the proven transcript.
- Do not copy `opencode.db`, and do not treat a snapshot as a transcript.
- Do not publish the guest port, pass `--shared` or `--isolated`, or run `opencode run` on the machine. The tools talk
  to `127.0.0.1` through `boxd machine exec`, and sharing deletes the guest's sign-in.
- Do not wait inside a tool call. `boxd_submit` admits and returns.
- Do not promise a machine sleeps forever: while a work is open it hibernates after 30 idle minutes, and after `boxd_sleep` it may stay off for up to four hours.

## When something fails

A failed call returns `error`, `message` and `next`. Read `message` first: it says which step failed or timed out.

- `GUEST_VERSION`: the machine's OpenCode is not this laptop's version. Stop; boot an image that matches.
- `MACHINE_SHARED` or `MACHINE_ISOLATED`: the machine is not usable for a session. Recreate it without that flag.
- `SESSION_BUSY`: harvest later. `boxd_job` says when.
- `RUN_INTERRUPTED`: the guest's OpenCode stopped during a run. Harvest what exists with `boxd_harvest`, then `boxd_submit` again.
- `DIRTY`: the guest tree has uncommitted work with no stored diff. Harvest before dropping.
- `NOT_OURS`: no open work, or the machine is not the ledger's. Call `boxd_ensure` for that work id.
- `BOXD_MISSING`: the boxd CLI is not on the PATH. Install it and restart OpenCode.
- `GUEST_UNRESPONSIVE`: the machine is short of memory or overloaded, and waiting will not fix it. Tell the user what
  the message names: the free memory, the load and the largest processes.
- `GUEST_SERVER_DOWN`: nothing listens on the guest's OpenCode port. `boxd_job` in a later turn starts it again.

Everything else: `/boxd-status` shows the next step, one line.
