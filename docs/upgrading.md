# Upgrading

## From 0.0.0 to 0.1.0

Change the plugin entry's tag from `v0.0.0` to `v0.1.0`, then run `opencode reload` or restart OpenCode. No option is
renamed or removed, and the ledger at `~/.local/share/boxd-plugin/v1` is read as it is: there is no migration. Running
works keep running and stay in the ledger. Read the `Upgrading` heading of the 0.1.0 section in
[CHANGELOG.md](../CHANGELOG.md) first: a work's machine must now hold only placeholder identities, and a work's
OpenCode server gets only the variables it declares.

## From a build before the 0.0.0 rebuild

A host that pins a build from before the rebuild, such as `github:joe-broadhead/opencode-boxd#v0.1.2`, is moving to a
different plugin with the same tool names. This plugin does not read that build's ledger, but it takes over the works
that build started, on their machines, with their running OpenCode server and their sessions: the same conversation
continues. The steps below do it without stopping a work. A host with many running works should follow the switchover
runbook in [switchover.md](switchover.md), which runs both builds side by side while it moves.

### 1. Plan how the old works move

The old build left each work's helper, its OpenCode server's password and pid under `~/.opencode-boxd` on the machine,
its server on port 4096 and its sessions in the machine's one OpenCode store. Its machines carry `owner=opencode-boxd`,
`role=session` and `work=<id>`, and no `ledger` label. Once steps 2 to 4 are done, `/boxd` lists each one as an orphan with the next step
`boxd_ensure({ select: "orphans" })`. That call, for each such machine:

1. uploads this plugin's helper, which copies the old server's password and pid to `~/.boxd-plugin`, so it speaks to
   the same server; nothing is started, stopped or prompted;
2. reads the machine's work checkout and root session with `describe`;
3. fences the old build off: a stub takes the old helper's place and answers every call from the old build with
   `WORK_MOVED`, and the old helper is kept beside it as `~/.opencode-boxd/guest.py.moved`;
4. sets this ledger's labels and writes a record with the root session.

A busy work is adopted and left running. The next `boxd_submit` continues its root session. The next `boxd_ensure` with
the work's `env` writes the done tool and, once the session is idle, restarts its server with only the declared
variables; the session is kept in the store, so it continues after the restart. A failed step skips the machine with
its error, and the next call tries again. To give a machine back to the old build, move
`~/.opencode-boxd/guest.py.moved` back to `~/.opencode-boxd/guest.py` and remove the machine's `ledger` label.

A work you would rather finish on the old build: `boxd_harvest` it there and `boxd_drop` it before step 3, or keep
it out of the orphan list with `"keep": ["owner=opencode-boxd"]`.

### 2. Move OpenCode to 2.4.1

The old build runs on OpenCode `>=2.2.3 <2.4.0`; 0.1.0 runs on `>=2.4.1 <2.5.0` and is tested on 2.4.1. Install
OpenCode 2.4.1. Do not set `allowUntestedHost` to keep either build running outside its range.

### 3. Change the plugin entry

In `opencode.json`, replace the old entry's package:

```json
{
  "plugins": [
    {
      "package": "github:we-the-rebel-alliance/boxd-plugin#v0.1.0",
      "options": {}
    }
  ]
}
```

That is, `"package": "github:joe-broadhead/opencode-boxd#v0.1.2"` becomes
`"package": "github:we-the-rebel-alliance/boxd-plugin#v0.1.0"`. A Git install does not update by itself, so remove the
old entry rather than adding a second one beside it. Then run `opencode reload`, or restart OpenCode, and run `/boxd`.

### 4. Keep the options, with these notes

None of these options is renamed or removed. Every one keeps its name, its values and its default:

| Option | In 0.1.0 |
|---|---|
| `size` | Unchanged: `1x4`, `2x8`, `4x16` or `8x32`, `2x8` by default. |
| `region` | Unchanged values (`auto`, `fra` or `nyc`), but a named region must now be listed in the new option `regions`, which lists both by default. |
| `allowedRoots` | Unchanged: absolute folders here, besides the project, that work files may use. |
| `goldenSetup` | Unchanged: an absolute path here to the script the golden builder runs before the scrub. |
| `git` | Unchanged: `{ "name", "email" }`, never a token. |
| `notices` | Unchanged: `wake`, `queue` or `off`. |
| `autoHibernateMinutes` | Unchanged: 30 to 1440, 120 by default. |
| `allowUntestedHost` | Unchanged, but measured against `>=2.4.1 <2.5.0`. Keep it `false`. |
| `automation` | Unchanged: `auto`, `on` or `off`. |

The old build's `costContext` and `idleCheck` options are gone: an entry that still sets either stops the plugin with
`OPTIONS_INVALID`, so remove them if they are there. Every other 0.1.0 option is new and optional; see
[configuration.md](configuration.md). `keep`, `regions`, `slotsPerMachine`, `workSecrets`, `warm` and `budget` are the
ones a host that spins up many works usually sets.

### 5. The ledger is not migrated

0.1.0 keeps its ledger at `~/.local/share/boxd-plugin/v1` and starts it empty. It does not read, import, migrate or
change `~/.local/share/opencode-boxd/v1`, nor the older `~/.local/share/opencode-boxd/works`. That folder stays as the
archive of what the old build harvested; delete it yourself once nothing in it is needed.

Nothing carries over from the old ledger: its records, its cost history and its events. An events cursor saved from the
old build means nothing to 0.1.0, so an automation that reads events must start again from the beginning, on the
`boxd.works` source with RPC id `boxd`. The old build's `/boxd-cleanup` command and its terminal view are gone; `/boxd`
reports the fleet, the cost and one next step.

### 6. Running works keep running

The upgrade does not stop, sleep or remove any machine. A work the old build left open keeps its machine, its guest
OpenCode server and its session until step 1 takes it over. Adopting one by name with `boxd_ensure({ workId, adopt:
true })` does not take its old server over; use `boxd_ensure({ select: "orphans" })`.

### 7. Expect a new golden image and a registry machine

Golden images are named for the OpenCode version, so the first `boxd_ensure` builds `oc-golden-2.4.1-<size>` from
stock, running `goldenSetup`, which takes a few minutes; set `buildGolden` to `never` to be told instead. The old
build's `oc-golden-2.3.*` images are not used; remove them with `boxd snapshots rm <name>` when you are sure.

The first sweep that needs it creates this ledger's registry machine, `oc-reg-<ledger id>`, labelled `role=registry`,
with daily disk backups, and keeps a copy of the ledger there. Leave it in place.

### 8. Check

Run `/boxd`. It should show the plugin on OpenCode 2.4.1, no option problems, the old works as this ledger's works,
and the orphans you chose to keep or remove. Then start one work with `boxd_ensure` and confirm it reaches `ready`. A work whose machine holds a real
GitHub, model or cloud credential, such as the github.com login boxd's git integration gives a private machine, is
refused with `ACTS_AS_OPERATOR`; see [security.md](security.md) for how to give it a placeholder identity instead.
