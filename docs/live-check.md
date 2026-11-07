# Live check on a real boxd machine

Everything in this file needs one real machine and your own boxd account. Nothing here runs in a check or a test: each
item is a place where the plugin's assumption is boxd's behaviour, and a fake has hidden any gap.

Run it once before the first release, and again after a boxd CLI or API change. Use a throwaway work id and snapshot,
and start from a clean ledger (`~/.local/share/opencode-boxd/works/` with no work you care about).

## 1. The argv the CLI actually accepts

- `boxd machine new <name> --from-snapshot <snapshot> --label role=session --label work=<id> --json` — label syntax, and
  the rules for a `work=` value.
- `boxd machine config set <name> auto-hibernate.timeout 1800`, and `… 14400`.
- `boxd machine config set <name> idle.ignore-outbound off`, and `… on`.
- `boxd machine hibernate <name> --json`, `boxd machine wake <name> --json`, `boxd machine remove <name> -y`.
- `boxd snapshots list --json`, `boxd snapshots save <machine> <name> --json`.
- `boxd machine cp - <name>:/tmp/opencode-boxd/guest.py` reads stdin.
- `boxd machine exec <name> -- python3 /tmp/opencode-boxd/guest.py` passes stdin through and returns stdout.
- `boxd machine list --json` lists every machine of the account, with `name`.
- `boxd auth login` is how a user signs in; the plugin never runs it.

If any key or flag differs, the whole control plane is inert and the fakes hid it. Note the exact shape in
`docs/architecture.md` once confirmed.

## 2. The billing model

- Whether a hibernated machine bills.
- What `auto-hibernate.timeout` a new machine has before the plugin sets it, and whether `wake` resets it.
- Whether inbound `machine exec` traffic resets idleness once `idle.ignore-outbound` is `off`: that is the claim that a
  crashed laptop stops paying after 30 minutes.
- Whether `hibernate` and `stop` differ in billing and in what survives.

## 3. Provisioning time

Time `machine new` from the golden snapshot, against the 30 s timeout, and confirm whether a create that times out still
lands. Then check `boxd_status`: a machine that landed must appear as an orphan (or be adopted by `boxd_ensure`), never
be invisible.

## 4. The `machine get --json` vocabulary

Record the exact `status`/`boot`/`sharing`/`isolated` strings for running, starting, hibernating, suspended/standby,
destroyed and not-found. `src/cli-boxd.ts` maps them, and a wrong mapping lets a shared machine past `refuseUnsafe`.

## 5. The golden image

- Its OpenCode version, and whether it equals the laptop's (`boxd_status` shows the expected version).
- Whether `opencode serve --hostname 127.0.0.1 --port 4096` accepts `OPENCODE_PASSWORD` from the guest helper.
- That port 4096 is not published, and nothing else listens on it.
- That `git`, `python3` and the in-VM `boxd` CLI exist, and that the machine is not created `--shared` or `--isolated`.

## 6. One full work, then the failure paths

1. `boxd_ensure` → `boxd_submit` → `boxd_job` → `boxd_harvest` → `boxd_sleep` → `boxd_resume` (wake).
2. Destroy the machine from the boxd CLI, then `boxd_resume` (rebuild from the golden snapshot and the transcript), then
   destroy and rebuild a second time in the same OpenCode run: the guest helper must be re-uploaded each time.
3. `boxd_image` from a machine with a fresh proof; then a machine whose image version differs from the laptop's (expect
   `GUEST_VERSION`, and `boxd_sleep` must still work).
4. Kill the guest OpenCode mid-run: `boxd_job`, `boxd_harvest` and `boxd_resume` must each give a coded error, and
   `boxd_sleep` must still hibernate.
5. A drop with an untracked file, with an ignored file, in a non-git directory, and with a staged change (expect
   `UNTRACKED`, `GIT_UNKNOWN`, or a stored patch and a successful drop).
6. `boxd_job` on a hibernated work: `asleep`, no wake, no billing.
7. After a wake, read `boxd machine get` and confirm `auto-hibernate.timeout` is 1800 and `idle.ignore-outbound` is off.

## 7. Concurrency

Two boxd tools in one `Promise.all` script (`boxd_submit` and `boxd_harvest`): the ledger must keep both, and the
harvest must record the proof as stale when the submit wins. Then two `boxd` CLI commands at once: note whether boxd
serialises them or refuses one.

## What to write down

For each item, the exact command, the exact output and the date, in `docs/architecture.md` under "Platform facts", or as
a corrected assumption in the code. An item that fails is a blocker for the release, not a note.
