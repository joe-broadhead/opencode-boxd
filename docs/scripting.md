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
tool itself returns (a work's state, a harvest's sessions, a job's outcome). `text` is what the model path would show.

## Methods

| Method | Class | Runs when |
|---|---|---|
| `boxd_status` | read | allowed |
| `boxd_job` | read | allowed |
| `boxd_ensure` | write | the agent or session allows `boxd_ensure` |
| `boxd_submit` | write | the agent or session allows `boxd_submit` |
| `boxd_harvest` | export | the agent or session allows `boxd_harvest` (it writes this laptop) |
| `boxd_sleep` | write | the agent or session allows `boxd_sleep` |
| `boxd_resume` | write | the agent or session allows `boxd_resume` |
| `boxd_image` | write | the agent or session allows `boxd_image` |
| `boxd_drop` | destructive | the agent or session allows `boxd_drop` |

A class is the worst thing the method does; it never decides whether a call runs. The rules do.

## Files in and out

`boxd_submit` takes `files` to copy data to the machine, and `boxd_harvest` takes `files` to copy results back. A path is
relative to the work tree; a laptop path must be inside the project or a folder in `allowedRoots`, and a symlink is never
followed. The caps are 8 MiB a file and 32 MiB a call, and the ledger records each file's name, size and sha256, never
its content.

A worked example: summarise the bookmarks a previous step saved, and bring the summary back.

```sh
# 1. One work, with the laptop folder it belongs to.
opencode api post /api/rpc/boxd.machines.tools/boxd_ensure -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<id>","input":{"workId":"bookmarks"}}}'

# 2. The data in, then the prompt. The model reads data/bookmarks.json, not a pasted list.
opencode api post /api/rpc/boxd.machines.tools/boxd_submit -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<id>","input":{"workId":"bookmarks","text":"Read data/bookmarks.json and write SUMMARY.md: one line per site, grouped by topic.","files":[{"from":"bookmarks.json","to":"data/bookmarks.json"}]}}}'

# 3. Later: the outcome, then the transcript and the summary.
opencode api post /api/rpc/boxd.machines.tools/boxd_job -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<id>","input":{"workId":"bookmarks"}}}'
opencode api post /api/rpc/boxd.machines.tools/boxd_harvest -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<id>","input":{"workId":"bookmarks","files":["SUMMARY.md"]}}}'
```

The harvest answers `outcome: "completed"` when the model finished, and the file lands beside the work's laptop folder.
An `outcome` of `failed` is a warning on a successful harvest: the transcript and the files are still here, and the next
step says what to fix. A `boxd_drop` after that harvest succeeds, because `SUMMARY.md` came back at the digest the guest
still has; a file that was never harvested keeps the refusal.

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

A refusal is the RPC error `failed`, with `data: { code, next }`:

| Code | When | What to do |
|---|---|---|
| `PERMISSION_DENIED` | the rule resolves to ask, or a deny hides the method | add an allow rule for the action to the session's agent or to the session |
| `SESSION_UNKNOWN` | OpenCode does not know the session in this location | create the session in the location you mean, and pass its id |
| `SESSION_AGENT_REQUIRED` | the session names no agent | create a session that names an agent |
| `TOOL_UNAVAILABLE` | OpenCode does not list the method's tool now | call `describe` to see the methods there are |
| `NOT_OURS` | no open work has that id, or it is bound to another machine | call `boxd_ensure` for that work id |
| `MACHINE_GONE` | the machine is missing or destroyed | call `boxd_resume` to rebuild it from the golden snapshot |
| `SNAPSHOT_MISSING` | the golden snapshot is not in this boxd account | build the image as `docs/golden-image.md` describes, and set `snapshot` |
| `SESSION_BUSY` | the guest session is still running | call `boxd_job` until it reports idle, then harvest |
| `NOT_PROVEN` | no fresh laptop import since the last prompt | call `boxd_harvest` first |
| `GUEST_RUN_FAILED`, `GUEST_AUTH_FAILED` | the guest session's last run failed | read the transcript, then `boxd_submit` again; an auth failure is fixed in the image |
| `RUN_INTERRUPTED` | `boxd_resume` only: the guest's OpenCode stopped during the session's run | harvest what exists with `boxd_harvest`, then `boxd_submit` again |

Every other code the plugin raises is in `docs/configuration.md`, with its one next step.

Known limit: a saved "Always allow" answer from an earlier session is not part of the agent and session rules, so it
does not authorize an ad hoc script. A script's grant is a rule in config.
