# Scripting

Every boxd tool is a method of the `boxd.machines.tools` RPC, so a script calls it with no model, as a session and the
agent it names. A script's grant is a rule in config: only a resolved `allow` runs, an `ask` is refused because no one
can answer it, and a `deny` runs nothing.

The session is created for the script with an agent (`opencode api post /api/session -d '{"title":"…","agent":"build","location":{"directory":"/path/to/project"}}'`, with `data.id` kept). The body is
`{"input":{"sessionID":"<id>","input":{…}}}`; both keys are required, and no other key is allowed. Give the project as the session's `location`: a session made without one belongs to the service's default location, where the project's agents may not exist, and each call then fails `Agent not found`.

```sh
opencode api post /api/rpc/boxd.machines.tools/boxd_job -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"<id>","input":{"workId":"review-api"}}}'
```

`describe` takes no input, or a session, and lists every method with its class and — given a session — the permission the
call would get:

```sh
opencode api post /api/rpc/boxd.machines.tools/describe -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"<id>"}}'
```

A plugin-owned method's result is the method's output object, as `describe` gives its schema: for boxd, the JSON the
tool itself returns, with a `state` on every answer. `text` is what the model path would show.

## Watching a fleet

`boxd_status` answers for the whole fleet in one call: `counts` by phase, each region's machine headroom, the works that
need a decision (`attention`, worst first, at most `limit`, with `more` for the rest), repeated causes folded into
`groups`, and the `cost` and `cleanup` blocks. It never wakes a machine and never reads an idle guest. Its `cursor`,
passed back as `since`, answers only the works that changed since; a cursor older than the kept event log answers the
full view with `cursorExpired: true`, so a gap is never mistaken for "nothing changed".

```sh
opencode api post /api/rpc/boxd.machines.tools/boxd_status -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<id>","input":{"since":1842,"limit":50}}}'
```

A script's own session gets no notices: notices go to the coordinator that last drove a work from the model path. A
script names one with `notify` on `boxd_submit` (a session id, or `false` to clear it), and a submit without `notify`
leaves an earlier subscription in place.

## Many works in one call

`boxd_ensure`, `boxd_submit`, `boxd_job`, `boxd_harvest`, `boxd_sleep`, `boxd_resume` and `boxd_drop` take
`works: [...]`, 1 to 300 items, and answer `{ state, counts, results }` with one result per item in input order. `state`
is `done`, `partial`, `failed` or `cancelled`. A list call has a bound: an item still `creating` or `starting` when it
runs out answers that state, and an item that never started answers `cancelled` with `started: false`; both carry the
same `next`, which only waits and converges. Use one list call rather than many single calls at once.

```sh
opencode api post /api/rpc/boxd.machines.tools/boxd_ensure -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<id>","input":{"works":[{"workId":"api-a","repo":"https://github.com/o/a"},{"workId":"api-b","repo":"https://github.com/o/b"}]}}}'
opencode api post /api/rpc/boxd.machines.tools/boxd_job -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<id>","input":{"works":["api-a","api-b"]}}}'
```

`boxd_sleep`, `boxd_harvest` and `boxd_drop` also take `select` instead of `works`, resolved against a fresh listing and
the ledger; `dryRun: true` lists the matches and changes nothing:

```sh
opencode api post /api/rpc/boxd.machines.tools/boxd_sleep -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<id>","input":{"select":"finished","dryRun":true}}}'
```

## Methods

| Method | Class | Runs when |
|---|---|---|
| `boxd_status` | read | allowed |
| `boxd_job` | read | allowed |
| `boxd_read` | read | allowed |
| `boxd_ensure` | write | the agent or session allows `boxd_ensure` |
| `boxd_submit` | write | the agent or session allows `boxd_submit` |
| `boxd_harvest` | export | the agent or session allows `boxd_harvest` (it writes here) |
| `boxd_events_list` | read | allowed (the `boxd.works` source's `events_list` as a tool) |
| `boxd_sleep` | write | the agent or session allows `boxd_sleep` |
| `boxd_resume` | write | the agent or session allows `boxd_resume` |
| `boxd_reassign` | write | the agent or session allows `boxd_reassign` |
| `boxd_golden` | write | the agent or session allows `boxd_golden` |
| `boxd_exec` | write | the agent or session allows `boxd_exec` |
| `boxd_drop` | destructive | the agent or session allows `boxd_drop` |
| `events_list` | read | allowed (its action is `boxd_events_list`) |
| `probe` | read | allowed (its action is `boxd_probe`) |

A class is the worst thing the method does; it never decides whether a call runs. The rules do.

## The boxd.works source

`events_list` and `probe` are the `boxd.works` source's methods (source contract, `package.json`'s `sources`), for a
collector. They read this machine's ledger only: no boxd call, no machine woken, no lock taken.

```sh
opencode api post /api/rpc/boxd.machines.tools/probe -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"<id>","input":{}}}'
opencode api post /api/rpc/boxd.machines.tools/events_list -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<id>","input":{"since":"2026-11-01T00:00:00Z","limit":100}}}'
```

- **The account and owner.** The account is this computer's host name, as a slug, and the owner its OS user,
  `{ "id": "os-user:<user>@<computer>", "label": "<user> on <computer>" }`. A read that names another account is
  `ACCOUNT_MISMATCH`.
- **An event** is one line of the ledger's `events.jsonl`: `external_id` `<work id>:<seq>`, `kind` `x-boxd/work`,
  `occurred_at` the change's time, `thread` `boxd-work:<work id>`, a `title` in the plugin's own words, such as
  `Work fix-auth: its run failed (RUN_FAILED)`, and `labels` `phase:<phase>`, `outcome:<outcome>`, `code:<code>`,
  `asleep-by:<who>` and `needs:<form or permission>` where they apply. It has no `text`, `actors` or `url`. An event
  whose title holds a secret (a work id shaped like a key) is listed in `refused[]` with reason `secret`, never sent.
- **The cursor** is the log's sequence number, bound to the plugin, the source and the account. The ledger keeps at
  least the last 5 MiB of events: a cursor older than the oldest kept event, or one from another ledger, answers the
  oldest kept events with `gap: { "reason": "expired", "since": <the time the cursor covered> }`, once, and a first
  read whose `since` is older than the oldest kept event answers the same. Without a cursor or `since`, a read starts
  24 hours ago.
- **While the v0 import runs**, or after it failed, there is no ledger to read: `events_list` answers `UNAVAILABLE` with
  the import's progress, and never starts the import itself. A ledger that cannot be read is `UNAVAILABLE` too.
- **Refusals** carry the source contract's codes: `INPUT_INVALID`, `SOURCE_UNKNOWN` (any source but `works`),
  `ACCOUNT_MISMATCH`, `CURSOR_INVALID` and `UNAVAILABLE`, each as `CODE: what happened. Next step: …`.

## Files in and out

`boxd_submit` takes `files` to copy data to the machine, and `boxd_harvest` takes `files` to copy results back. A path is
relative to the work tree; a path here must be inside the project or a folder in `allowedRoots`, and a symlink is never
followed. The caps are 8 MiB a file and 32 MiB a call, and the ledger records each file's name, size and sha256, never
its content.

A worked example: summarise the bookmarks a previous step saved, and bring the summary back.

```sh
# 1. One work, with the folder here it belongs to. It answers when the guest's OpenCode is up.
opencode api post /api/rpc/boxd.machines.tools/boxd_ensure -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<id>","input":{"workId":"bookmarks"}}}'

# 2. The data in, then the prompt. The model reads data/bookmarks.json, not a pasted list.
opencode api post /api/rpc/boxd.machines.tools/boxd_submit -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<id>","input":{"workId":"bookmarks","text":"Read data/bookmarks.json and write SUMMARY.md: one line per site, grouped by topic.","files":[{"from":"bookmarks.json","to":"data/bookmarks.json"}]}}}'

# 3. Later: the outcome, then the transcript and the summary, then the machine down.
opencode api post /api/rpc/boxd.machines.tools/boxd_job -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<id>","input":{"workId":"bookmarks"}}}'
opencode api post /api/rpc/boxd.machines.tools/boxd_harvest -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<id>","input":{"workId":"bookmarks","files":["SUMMARY.md"]}}}'
opencode api post /api/rpc/boxd.machines.tools/boxd_drop -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<id>","input":{"workId":"bookmarks"}}}'
```

`boxd_job` answers `state: "idle"` with `outcome: "completed"` when the model finished. The harvest makes the work
`saved: "fresh"`, and the drop succeeds because `SUMMARY.md` came back at the digest the guest still has; a file that
was never harvested keeps the refusal (`UNTRACKED`).

Two more reads help a script without a harvest:

```sh
opencode api post /api/rpc/boxd.machines.tools/boxd_read -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<id>","input":{"workId":"bookmarks","path":"SUMMARY.md"}}}'
opencode api post /api/rpc/boxd.machines.tools/boxd_exec -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<id>","input":{"workId":"bookmarks","command":["git","status","--short"],"timeout":30}}}'
```

`boxd_exec` is a change, because a command can do anything; each argument reaches the remote shell exactly as given.
When the work's machine runs out of room, `boxd_reassign` moves an unstarted work's machine to a new id, and
`boxd_golden` builds or prunes the golden images:

```sh
opencode api post /api/rpc/boxd.machines.tools/boxd_reassign -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<id>","input":{"from":"spare-1","to":"bookmarks-2"}}}'
opencode api post /api/rpc/boxd.machines.tools/boxd_golden -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<id>","input":{"region":"nyc","size":"4x16"}}}'
```

If the host asks for permission to touch a folder outside the project, allow it with the `external_directory` rule as
well as the path rule:

```jsonc
{ "permissions": [
  { "action": "external_directory", "resource": "/srv/work/*", "effect": "allow" },
  { "action": "read", "resource": "/srv/work/**", "effect": "allow" },
  { "action": "edit", "resource": "/srv/work/**", "effect": "allow" }
] }
```

A refusal that names `permission.rejected: external_directory` is fixed by that rule, and by naming the folder in the
plugin's `allowedRoots` option.

## Restricting one agent

To let one agent run a script that harvests, give that agent its own rule:

```jsonc
{ "agents": { "harvester": { "permissions": [{ "action": "boxd_harvest", "resource": "*", "effect": "allow" }] } } }
```

Every tool is allowed by default (the plugin's `access` option is `"all"`), and a script gets the same default: the
tools RPC resolves a rule before dispatch, and the default allow is that rule, so a script can call every method. To
restrict a script, set `access` to `"ask-changes"` (an `ask` is refused, because no one can answer it) or
`"read-only"`, or give the script's agent its own `deny` rule — the script's grant is a rule in config.

## The location

Run the command in the project whose agent you mean, and send the call to that location explicitly:

```sh
opencode api post /api/rpc/<id>/<method> -H "x-opencode-directory:$PWD" -d '{…}'
```

Without it the call goes to the service's default location and fails `rpc.unavailable` if the plugin is not loaded
there. The HTTP equivalents are the `location[directory]` query parameter and the same header. `describe` reports the
`location` that answered and a `locationHint`.

A location unloads after OpenCode's idle timeout. If a scheduled script gets `rpc.unavailable` from a location that was
loaded before, send the call again once: the request loads the location. Jobs keeps its own location loaded.

## Refusals

A call the RPC refuses before the method runs is the RPC error `failed`, with `data: { code, next }`:

| Code | When | What to do |
|---|---|---|
| `PERMISSION_DENIED` | the rule resolves to ask, or a deny hides the method | add an allow rule for the action to the session's agent or to the session |
| `SESSION_UNKNOWN` | OpenCode does not know the session in this location | create the session in the location you mean, and pass its id |
| `SESSION_AGENT_REQUIRED` | the session names no agent | create a session that names an agent |
| `TOOL_UNAVAILABLE` | OpenCode does not list the method's tool now | call `describe` to see the methods there are |

A method that ran and refused answers with its output, not an RPC error, in the same shape as a success: `{ "state":
"<state>", "error": "<code>", "message": "<what happened>", "next": "<the one next call>" }`, with `workId`, `machine`
and `region` when the call named a valid work, and the facts its code carries: `field` (`NAME_INVALID`), `paths`,
`count` and `kind` (`UNTRACKED`), `limit` per region (`MACHINE_LIMIT`), `progress` (`LEDGER_IMPORTING`), `uncertain`
(`CANCELLED`), and `today`, `daily` and `currency` (`BUDGET_REACHED`). `state` is `refused`, `failed`, `unreachable`,
`busy`, `starting`, `gone`, `asleep` or `cancelled`, so a loop reads `state` on every answer. The codes a script meets
most:

| Code | When | What to do |
|---|---|---|
| `LEDGER_IMPORTING` | the import of earlier works is not complete yet | the same call again in a few seconds |
| `NOT_OURS` | no open work has that id, or its name now points at another machine | `boxd_ensure` for an unknown id; otherwise look at the machines the message names |
| `MACHINE_LIMIT` | no region has room | the other `region` when it has room, or free machines with `boxd_drop` or `boxd_reassign` |
| `SESSION_BUSY` | the session is running and the call needs it idle | wait for the notice or `boxd_status`, or `mode: "interrupt"` |
| `NOT_SAVED` | drop without a fresh harvest, or the guest moved on since it | `boxd_harvest`, then drop again |
| `RUN_FAILED`, `GUEST_AUTH_FAILED` | the session's last run failed | read `lastText`; fix the credential for an auth failure; then `boxd_submit` again |
| `BUDGET_REACHED` | the daily budget is reached with `action: "refuse"` | sleep and drop finished works, or raise the budget |

Every other code the plugin raises is in `docs/configuration.md`, with its one next step.

Known limit: a saved "Always allow" answer from an earlier session is not part of the agent and session rules, so it
does not authorize an ad hoc script. A script's grant is a rule in config.
