# Upgrading

## From 0.0.0 to 0.1.0

Change the plugin entry's tag from `v0.0.0` to `v0.1.0`, then run `opencode reload` or restart OpenCode. No option is
renamed or removed, and the ledger at `~/.local/share/boxd-plugin/v1` is read as it is: there is no migration. Running
works keep running and stay in the ledger. Read the `Upgrading` heading of the 0.1.0 section in
[CHANGELOG.md](../CHANGELOG.md) first: a work's machine must now hold only placeholder identities, and a work's
OpenCode server gets only the variables it declares.

## From a build before the 0.0.0 rebuild

A host that pins a build from before the rebuild, such as `github:joe-broadhead/opencode-boxd#v0.1.2`, is moving to a
different plugin with the same tool names. 0.1.0 does not read that build's ledger, does not drive the works it
started, and needs a newer OpenCode. Treat the move as a new install, in this order.

### 1. Finish the old works on the old build

The old build is the only one that can harvest its works, so do this before anything else, on the OpenCode you run
today:

1. Run `/boxd` and list every open work.
2. For each work you still need, `boxd_harvest` it, so its transcript, patch and untracked files reach the old ledger.
3. Then `boxd_drop` it, or `boxd_sleep` it if you want to keep the machine for a while.

A work you leave open keeps running on boxd after the upgrade, and keeps costing money, but nothing on this host can
submit to it, read it or harvest it any more.

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

### 6. Running works keep running, unmanaged

The upgrade does not stop, sleep or remove any machine. A work the old build left open keeps its machine, its guest
OpenCode server and its session, which run until they finish, and the machine hibernates after its own
`autoHibernateMinutes` of idle time, as boxd set it at creation.

0.1.0 does not take those works over. Their guest helper and OpenCode server live under `~/.opencode-boxd` on the
machine, on the port 0.1.0's helper also uses, so `boxd_ensure({ select: "orphans" })` skips them (their machine has no
helper where 0.1.0 reads it), and adopting one with `boxd_ensure({ workId, adopt: true })` would start a new
conversation beside the old one rather than continue it. Finish them on the old build first, as step 1 says.

After the upgrade, `/boxd` lists any machine the old build left as an orphan, with the next step. Either:

- keep it out of the orphan list while it finishes, with `"keep": ["owner=opencode-boxd"]`, which matches the old
  build's label; or
- copy what you need off it with `boxd machine cp -r oc-<id>:work/<id> .`, then remove it with
  `boxd machine remove oc-<id> -y`.

### 7. Expect a new golden image and a registry machine

Golden images are named for the OpenCode version, so the first `boxd_ensure` builds `oc-golden-2.4.1-<size>` from
stock, running `goldenSetup`, which takes a few minutes; set `buildGolden` to `never` to be told instead. The old
build's `oc-golden-2.3.*` images are not used; remove them with `boxd snapshots rm <name>` when you are sure.

The first sweep that needs it creates this ledger's registry machine, `oc-reg-<ledger id>`, labelled `role=registry`,
with daily disk backups, and keeps a copy of the ledger there. Leave it in place.

### 8. Check

Run `/boxd`. It should show the plugin on OpenCode 2.4.1, no option problems, and the orphans you chose to keep or
remove. Then start one work with `boxd_ensure` and confirm it reaches `ready`. A work whose machine holds a real
GitHub, model or cloud credential, such as the github.com login boxd's git integration gives a private machine, is
refused with `ACTS_AS_OPERATOR`; see [security.md](security.md) for how to give it a placeholder identity instead.
