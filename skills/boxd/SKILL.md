---
name: boxd
description: Run an OpenCode session on a private boxd machine and keep the transcript on this laptop. Use when the user says boxd, a cloud machine, a snapshot, or scaling sessions off this computer.
---

# boxd

The laptop is the source of truth. The machine is a cache with more CPU.

OpenCode on the machine must be the same version this plugin targets. If a tool returns `GUEST_VERSION`, stop. Do not start a session on that disk.

## Do not

- Do not treat a boxd snapshot as the session. A snapshot is an image.
- Do not copy `opencode.db`.
- Do not publish the OpenCode port. The tools talk to `127.0.0.1` through `boxd machine exec`.
- Do not pass `--shared` or `--isolated`. Sharing deletes OpenCode auth. Isolation drops git.
- Do not call `opencode run` on the machine. On 2.2.6 it waits for background jobs with no time limit.
- Do not wait inside a tool call. `submit` admits the prompt and returns. Call `job` later.
- Do not `sleep` or `drop` unless `harvest` has returned `proven` since the last `submit`.
- Do not destroy a machine to restart a session. `resume` wakes it, or imports the proven transcript onto a new machine from the golden snapshot.
- Do not set auto-hibernate to 0. A machine left behind sleeps on its own.

## Order

1. `boxd_ensure` with a short work id. If it returns `starting`, call `boxd_status` later. Do not poll in a loop in this turn.
2. `boxd_submit` with the task. Then do other work, or stop.
3. `boxd_job`. Busy means call it again on a later turn.
4. `boxd_harvest` with the laptop directory that should receive the import. Parents are imported before children.
5. `boxd_sleep` to free RAM, or `boxd_drop` only after harvest. Dirty git without a stored patch cannot be dropped.
6. `boxd_resume` after a shutdown. A wake is not an import. An import means the old machine is gone.

`boxd_image` saves a new golden image. It is refused while a session on that machine is unharvested.
