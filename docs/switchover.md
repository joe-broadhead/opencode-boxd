# Switchover from the pre-rebuild build

This runbook moves a host that runs the build from before the rebuild
(`github:joe-broadhead/opencode-boxd#v0.1.2`, ledger `~/.local/share/opencode-boxd/v1`) to this plugin, with no
downtime. It is written for a host with hundreds of open works and automations that make works through `tools.boxd.*`
in Code Mode. Each step has a check and a rollback. Do the steps in order and do not start a step until the check
before it passes.

The rule throughout: no running work loses its session, and the host never stops being able to make works.

## How the move works

- **The old works move in place.** Since the release that carries #149, `boxd_ensure({ select: "orphans" })` takes
  over a machine the old build started. It copies the old OpenCode server's sign-in to this plugin's helper, so it
  speaks to the same running server and the same root session. It then fences the old build off: a stub answers every
  call from the old build with `WORK_MOVED`, and the old helper is kept as `~/.opencode-boxd/guest.py.moved`. Last, it
  writes this ledger's labels and record. It never starts, stops or prompts the session. A busy work is adopted and left
  running.
- **Two OpenCode services run side by side during the move.** Service A is the one you run today, with the old build.
  Service B runs this plugin, with its own XDG folders and its own port. Each service loads only its own plugin entry
  and runs only its own automations, so an automation reaches the plugin of the service that holds it. Both are the same
  OpenCode 2.4.1 binary.
- **Both services share this plugin's ledger at the end.** This plugin keeps its ledger at
  `~/.local/share/boxd-plugin/v1` under the user's home, whatever the XDG folders say. Its cross-process locks and its
  automation owner lock let two services on one host share it. So once A's plugin entry is switched to this plugin in
  the last phase, the session that runs the host today sees every work, without moving to another service.
- **The old works already have the right identity.** On a lane the old build made, the `ACTS_AS_OPERATOR` check of this
  plugin finds nothing: boxd's git integration is not connected, `GH_TOKEN` is a `bxds_` placeholder bound to the GitHub
  hosts, and git asks `gh auth git-credential`, which hands git the placeholder. See "GitHub identity" below.

## Before you start

| Check | Command | Expect |
|---|---|---|
| OpenCode on the host | `opencode --version` | `2.4.1` |
| The external boxd CLI | `boxd --help` | the laptop CLI, signed in (`boxd auth` shows the org) |
| No git integration | `boxd manage integrations` | Git is listed under "Available to connect" |
| Placeholders only | `boxd env list` | `GH_TOKEN` and each model key are secrets bound to their hosts |
| The release | `git ls-remote https://github.com/we-the-rebel-alliance/boxd-plugin refs/tags/v0.1.1` | one line |

If the release is not cut yet: merge #149, then a maintainer runs `npx plugin-kit release 0.1.1`, and CI publishes
the tag. The steps below name `v0.1.1`. Use the newest 0.1.x tag that carries #149.

Write down, from service A: its plugin entry and options, every automation that calls `tools.boxd.*` (with its
trigger and code), and the count of open works in `/boxd`.

## Phase 1: start service B beside A

A is not changed in this phase.

### 1. Give B its own folders and port

```sh
export OCB="env XDG_CONFIG_HOME=$HOME/.oc-b/config XDG_DATA_HOME=$HOME/.oc-b/data XDG_STATE_HOME=$HOME/.oc-b/state XDG_CACHE_HOME=$HOME/.oc-b/cache"
mkdir -p "$HOME/.oc-b/config/opencode"
$OCB opencode service set port 49380
```

- **Check:** `opencode api get /api/info` and `$OCB opencode api get /api/info` answer with two different `pid`s
  and ports, and `ps -eo pid,args | grep "serve --service"` shows two services.
- **Rollback:** `$OCB opencode service stop`, then remove `~/.oc-b`. A never noticed.

Without its own port, B's service refuses to start because A holds the managed port, or the other way round. That is
the only collision.

### 2. Configure B

Write `~/.oc-b/config/opencode/opencode.json` with what the host needs from A's global config (providers, agents,
skills, MCP servers), and this plugin entry:

```json
{
  "plugins": [
    {
      "package": "github:we-the-rebel-alliance/boxd-plugin#v0.1.1",
      "options": {
        "keep": ["owner=opencode-boxd"],
        "automation": "off"
      }
    }
  ]
}
```

Copy every option A's entry sets, except `costContext` and `idleCheck`, which this plugin refuses with
`OPTIONS_INVALID`. Keep `git` as `{ "name", "email" }` of the identity the works commit as. The `keep` selector stops B
from adopting any old work before phase 3. `automation: "off"` keeps B's own harvest and hibernate off until phase 3
is done. Sign B's service in to any model provider that keeps its sign-in in OpenCode's data folder, because B's data
folder starts empty.

Start B from a folder outside A's project tree, so that no project `opencode.json` of A's is merged into B's.

- **Check:** in a session on B, `/boxd` shows the plugin on OpenCode 2.4.1, no option problems, zero works, and the
  old machines counted as kept.
- **Rollback:** stop B. Nothing outside `~/.oc-b` and `~/.local/share/boxd-plugin` changed.

### 3. Make one canary work from B

In a session on B:

```js
await tools.boxd.ensure({ workId: "mig-canary", repo: { url: "https://github.com/<owner>/<repo>" }, env: ["GH_TOKEN", "<the model key names the works use>"], wait: "ready" })
await tools.boxd.submit({ workId: "mig-canary", text: "Open a draft pull request that adds one line to a scratch file on a branch named lane/mig-canary, then close it and delete the branch." })
```

Then follow it with `boxd_job`, and `boxd_harvest` and `boxd_drop` it when it is done.

- **Check:** `ensure` answers `ready`, with no `ACTS_AS_OPERATOR`. The pull request's author is the app the works act
  as, and it is closed. The first `ensure` also creates the registry machine `oc-reg-<ledger id>`. Leave it.
- **Rollback:** drop the canary. If `ensure` answers `ACTS_AS_OPERATOR`, it names what it found (never a value). Fix
  that on the org (see "GitHub identity") before going on. A is unaffected either way.

## Phase 2: B makes every new work

Move each automation that makes works, one at a time:

1. Create it in a session on B, with the same trigger and code. Its `tools.boxd.*` calls now reach B's plugin. Add
   `env: ["GH_TOKEN", ...]` to each `ensure` it calls: this plugin starts a work's OpenCode server with only the
   variables the work declares.
2. Let it fire once, or run its code by hand in B.
3. Delete the same automation in A.

- **Check:** after each move, the new work's machine carries `ledger=<B's ledger id>` and reaches `ready` in B. A's
  `/boxd` count of open works only goes down from here.
- **Rollback:** delete it in B and create it again in A. There is never a moment with no automation making works, and
  never two.

A keeps driving the old works through this phase: its reviewers, watchers and green-keepers carry on unchanged.

## Phase 3: take the old works over, in batches

### 4. One canary old work

Pick an old work that is idle, with nothing waiting on a person. Mark it with an owner that B does not keep:

```sh
boxd machine label set oc-<id> owner opencode-boxd-moving --region <region>
```

The old build still owns the machine through its `role=session` label, so A keeps driving it until it is fenced.

In a session on B, run `boxd_ensure({ select: "orphans", dryRun: true })` first. The answer must list exactly
`oc-<id>` as actionable. Any other actionable orphan is a machine to keep: add a selector for it to `keep`, and look
again. Then run it for real: `boxd_ensure({ select: "orphans" })`.

- **Check:** the result says `adopted` for `oc-<id>`. `boxd_job({ workId: "<id>" })` reads the old root session. A
  `boxd_submit` to it, such as a question about what it did last, is answered in the same conversation. In A, the work
  now fails with `WORK_MOVED`.
- **Rollback:** give it back to A:

  ```sh
  boxd machine exec oc-<id> --region <region> -- 'mv ~/.opencode-boxd/guest.py.moved ~/.opencode-boxd/guest.py'
  boxd machine label set oc-<id> owner opencode-boxd --region <region>
  boxd machine label remove oc-<id> ledger --region <region>
  ```

  Then make no more calls for that work in B. The work's session was never touched, so A carries on where it was.

### 5. The rest, in batches

Mark the next batch the same way (for example 25 machines, or one product's lanes), dry-run, adopt, then check the
batch. A busy work, or one waiting on a person, is adopted and left running. For each batch, move the automations in A
that watch those works to B, as in phase 2. When the batches are going cleanly, remove `owner=opencode-boxd` from B's
`keep` and adopt everything that is left in one call.

- **Check:** after each batch, every marked machine is `adopted`, or `skipped` with its reason. A skipped machine is
  untouched, apart from its password copy, and stays A's. Run the call again later for it. B's `/boxd` count of open
  works plus A's count of works it can still drive equals the count you wrote down, less what finished.
- **Rollback:** per work, as in step 4.

### 6. Converge each adopted work

The adopted works still run the server the old build started, with the whole machine environment. That is how they
were already running, and they keep working. At each work's next idle moment, run
`boxd_ensure({ workId, env: ["GH_TOKEN", ...] })` on B. It writes the done tool and restarts the work's server with only
the declared variables. The session is kept in the machine's store, so it continues after the restart. While the
session runs, the call answers `SESSION_BUSY`. Try again later.

- **Check:** `ensure` answers `ready`, and the next `boxd_submit` continues the same conversation.
- **Rollback:** none needed. A restart does not lose the session.

Then set B's `automation` back to A's value (or remove it for the default).

## Phase 4: retire the old build

### 7. Switch A's plugin entry

Do this when A's `/boxd` lists no work it can still drive: every work is adopted, finished or dropped. In A's
`opencode.json`, replace the old entry's `package` with `github:we-the-rebel-alliance/boxd-plugin#v0.1.1`, with the
same options as B's entry. OpenCode reloads plugins when the file is saved.

- **Check:** in the session that runs the host, `/boxd` shows the same works as B's, because both read
  `~/.local/share/boxd-plugin/v1`. `tools.boxd.*` in that session now reaches this plugin.
- **Rollback:** put the old entry back. The adopted works stay fenced from it. Give a work back with step 4's
  rollback if A must drive it again.

### 8. Settle on one service

Either keep B as the service that holds the automations, or move them back to A one at a time, as in phase 2, and
stop B with `$OCB opencode service stop`. Keep the old ledger folder `~/.local/share/opencode-boxd` as the archive of
what the old build harvested, until nothing in it is needed.

## GitHub identity

A work passes `ACTS_AS_OPERATOR` and still pushes branches and opens pull requests as the app when:

1. **boxd's git integration is not connected.** `boxd manage integrations disconnect git` if it is. With it
   connected, git is handed a real github.com login, and the check refuses the work.
2. **`GH_TOKEN` is a sealed secret bound to the GitHub hosts**, holding the app's token:

   ```sh
   boxd env set GH_TOKEN <the app's token> --secret --domains github.com,api.github.com,codeload.github.com,uploads.github.com
   ```

   The machine sees only the `bxds_` placeholder. boxd swaps in the real value on the way to those hosts. The factory
   already runs this way.
3. **git asks gh for credentials.** `gh auth setup-git` on the machine, or in the golden image's setup, makes git use
   `gh auth git-credential`, which hands git the placeholder.
4. **The work declares the name.** `boxd_ensure({ ..., env: ["GH_TOKEN"] })`, so the work's OpenCode server, and every
   command it runs, has it.

The other option is `workSecrets`, with a `mint` command that prints a per-work token and a `revoke` command that the
plugin runs at drop. Such a value is real on the guest, and `boxd_exec` can print it. Prefer the sealed placeholder.

Repositories that require signed commits refuse a plain `git push` of a local commit with GH013, as they refuse it from
any lane today. A work makes signed commits through GitHub's API instead (for example
`gh api -X PUT repos/<owner>/<repo>/contents/<path> -f branch=<branch> ...`), and GitHub signs them for the app.

## What was proved

On throwaway machines, with OpenCode 2.4.1 and the guest helper from #149:

- A machine set up and prompted by the old build's own helper (`d7e0a96`) was taken over with `legacy` `adopt`,
  `describe` and `legacy` `fence`. The old helper's next call answered `WORK_MOVED`, and a prompt through the new helper
  continued the old root session: the model repeated a codeword given in the old build's turn.
- `setup` with `env: ["GH_TOKEN", "OPENCODE_API_KEY"]` passed `ACTS_AS_OPERATOR` and restarted the server with only
  those variables and the basics. The same session then made a signed commit through GitHub's API, opened draft pull
  request #150 as the app, closed it, deleted its branch and still knew the codeword.
- Two OpenCode 2.4.1 services ran on one host with separate XDG folders and ports.
