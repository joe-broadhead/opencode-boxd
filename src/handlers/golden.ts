/** `golden`: build, list or prune golden images. */
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import type { ToolRuns } from "../services.js"
import { callOf, guarded, method, nudge, settle } from "./run.js"
import { GOLDEN_INPUT } from "./schemas.js"

const DESCRIPTION =
  "Build, list or prune golden images, named <prefix>-<opencode version>-<size>. With repo, build that repository's warm image, named <prefix>-<repository>-<hash>-<opencode version>-<size>, from its version's image, with the repository's checkout and setup script. A build runs a fixed recipe on a short-lived builder machine (stock or a base snapshot, the OpenCode upgrade and the goldenSetup script, or a warm checkout and the repository's setup, then a scrub) and never saves a work's machine. With no input, it builds the default size in every region the plugin option \"regions\" allows that lacks one, and never builds in a region outside it; a prune removes images in every region, because deleting is not placement. An existing image answers present unless rebuild is true. A base that holds model credentials is refused."

export function goldenHandler(runs: ToolRuns): MethodHandler {
  return method(DESCRIPTION, GOLDEN_INPUT, { type: "object", additionalProperties: true }, (input, call) =>
    guarded(async () => {
      const value = await settle(() => runs.boxd_golden(input, callOf(call)))
      await nudge(call)
      return value
    }),
  )
}
