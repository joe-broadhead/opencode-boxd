# Scripting

Every boxd tool is a method of the `boxd.machines.tools` RPC, so a script calls it with no model, as a session and the
agent it names. A script's grant is a rule in config: only a resolved `allow` runs, an `ask` is refused because no one
can answer it, and a `deny` runs nothing.

```sh
opencode api post /api/rpc/boxd.machines.tools/describe \
  -d '{"sessionID":"<session id>"}' -H "x-opencode-directory:$PWD"
```

```sh
# One read, allowed by the default rules.
opencode api post /api/rpc/boxd.machines.tools/boxd_job \
  -d '{"sessionID":"<session id>","input":{"workId":"review-api"}}' -H "x-opencode-directory:$PWD"
```

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

To let one agent run a script that harvests, give that agent its own rule:

```jsonc
{ "agents": { "harvester": { "permissions": [{ "action": "boxd_harvest", "resource": "*", "effect": "allow" }] } } }
```

Everything else still asks, and a script's ask is refused with `PERMISSION_DENIED` rather than left waiting.

Known limit (`DC-2`, shared across the family): a saved "Always allow" answer from an earlier session is not part of the
agent and session rules, so it does not authorize an ad hoc script. A script's grant is a rule in config.
