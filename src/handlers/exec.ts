/** `exec`: run one command on a work's machine, with a timeout. */
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import type { ToolRuns } from "../services.js"
import { callOf, guarded, method, nudge, settle } from "./run.js"
import { EXEC_INPUT } from "./schemas.js"

const DESCRIPTION =
  "Run one command on a work's machine with a timeout, for what the other methods don't cover: free -m, gh pr view, a test run. Each argument is passed exactly as given. Returns the exit code and the last 32 KiB of stdout and 8 KiB of stderr, redacted; a secret that is not host-bound is a real value on the guest and can be printed. It asks even at access all, and refuses a hibernated machine unless wake is true."

export function execHandler(runs: ToolRuns): MethodHandler {
  return method(DESCRIPTION, EXEC_INPUT, { type: "object", additionalProperties: true }, (input, call) =>
    guarded(async () => {
      const value = await settle(() => runs.boxd_exec(input, callOf(call)))
      await nudge(call)
      return value
    }),
  )
}
