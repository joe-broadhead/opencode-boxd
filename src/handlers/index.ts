/** The one handler table `contract.register` wires through every door (contract §9). */
import type { HandlerTable } from "@we-the-rebel-alliance/plugin-contract/register"
import type { Selectors, ToolRuns } from "../services.js"
import { dropHandler } from "./drop.js"
import { ensureHandler } from "./ensure.js"
import { eventsHandlers, type SourceDeps } from "./events.js"
import { execHandler } from "./exec.js"
import { goldenHandler } from "./golden.js"
import { harvestHandler } from "./harvest.js"
import { jobHandler } from "./job.js"
import { readHandler } from "./read.js"
import { reassignHandler } from "./reassign.js"
import { resumeHandler } from "./resume.js"
import { sleepHandler } from "./sleep.js"
import { statusHandler, type StatusDeps } from "./status.js"
import { submitHandler } from "./submit.js"

export interface HandlerDeps {
  readonly runs: ToolRuns
  readonly selectors: Selectors
  readonly source: SourceDeps
  readonly status: StatusDeps
}

export function createHandlers(deps: HandlerDeps): HandlerTable {
  const source = eventsHandlers(deps.source)
  return {
    status: statusHandler(deps.status),
    events_list: source.events_list,
    probe: source.probe,
    job: jobHandler(deps.runs),
    read: readHandler(deps.runs),
    ensure: ensureHandler(deps.runs),
    submit: submitHandler(deps.runs),
    harvest: harvestHandler(deps.runs, deps.selectors),
    sleep: sleepHandler(deps.runs, deps.selectors),
    resume: resumeHandler(deps.runs),
    reassign: reassignHandler(deps.runs),
    golden: goldenHandler(deps.runs),
    exec: execHandler(deps.runs),
    drop: dropHandler(deps.runs, deps.selectors),
  }
}
