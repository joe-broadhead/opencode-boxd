/**
 * The JSON Schemas the boxd methods take. One schema per method: `contract.register` adds the account selector where a
 * method takes one (none do: boxd's one account is the machine's own identity) and validates every door against it.
 */
import type { JsonSchema } from "@we-the-rebel-alliance/plugin-contract/manifest"
import { LIST_MAX_ITEMS, REGIONS, SIZES } from "../ports.js"
import { WORK_PATTERN } from "../call.js"

const object = (properties: Record<string, JsonSchema>, required: readonly string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

export const EMPTY: JsonSchema = object({})

export const SESSION_PATTERN = "^ses_[A-Za-z0-9_-]{1,80}$"

export const WORK = { type: "string", pattern: WORK_PATTERN, description: 'A short lowercase work id, such as "review-api". Its machine is oc-<id>.' }
export const string = (description: string): JsonSchema => ({ type: "string", description })
export const boolean = (description: string): JsonSchema => ({ type: "boolean", description })
export const integer = (minimum: number, maximum: number, description: string): JsonSchema => ({ type: "integer", minimum, maximum, description })
export const choice = (values: readonly string[], description: string): JsonSchema => ({ type: "string", enum: [...values], description })

export const REGION = choice(REGIONS, "A boxd region.")
export const SIZE = choice(SIZES, "The machine's size, vCPU x GiB, in boxd's own spelling.")
export const MODEL = string('A model on the guest\'s OpenCode, as provider/model with #variant when it has one, such as "anthropic/claude-sonnet-4-5".')
export const GIT = {
  type: "object",
  description: "The guest's git identity, set with git config --global. Never a token: a guest pushes with boxd's git integration or a host-bound boxd env secret.",
  properties: { name: { type: "string" }, email: { type: "string" } },
  required: ["name", "email"],
  additionalProperties: false,
} satisfies JsonSchema
export const ENV = {
  type: "array",
  items: { type: "string", pattern: "^[A-Z_][A-Z0-9_]{0,63}$" },
  maxItems: 64,
  description:
    "The names of the machine's variables the work's OpenCode, and every command it runs, may inherit, such as [\"GH_TOKEN\"]. Names only, never values. The OpenCode server starts without every other variable the machine holds, the operator's among them; the machine's basics (PATH, HOME, locale, proxy and certificate settings) always pass. This is not a barrier: a session can still read boxd's variables file, source it in a login shell, or use sudo. Recorded; an empty list declares none, and omitting it keeps the recorded list.",
} satisfies JsonSchema
export const REPO = string("An https://github.com/owner/repo URL, cloned into the guest folder when it is not a checkout yet. Stored and returned without userinfo.")
export const REF = string("A branch or tag for the clone.")
export const DIRECTORY = string("The folder here for the work, inside the project or an allowed root; the project by default. The guest always works in /home/boxd/work/<work id>.")
export const TITLE = string("The guest session's title; the work id by default.")
export const SHARED_MACHINE = {
  type: "string",
  pattern: "^[a-z][a-z0-9-]{0,24}$",
  description: 'Take a slot on the shared machine oc-shared-<name> instead of a machine of the work\'s own. The first work that names it creates it at that work\'s region and size; later works join it, and a differing size or region is refused.',
} satisfies JsonSchema

/**
 * A single form and a list form in one object schema: exactly one of `workId` and `works` (or a selector, in `extra`).
 * A list item takes the single form's fields; `extra` belongs to the call only.
 */
export function listable(
  item: Record<string, JsonSchema>,
  itemRequired: readonly string[],
  what: string,
  extra: Record<string, JsonSchema> = {},
  shorthand = false,
): JsonSchema {
  const items = object(item, itemRequired)
  return object({
    ...item,
    ...extra,
    works: {
      type: "array",
      minItems: 1,
      maxItems: LIST_MAX_ITEMS,
      description: `Many works in one call, 1 to ${LIST_MAX_ITEMS}, each ${what}${shorthand ? ', or just its work id ("review-api" means { workId: "review-api" })' : ""}. Results come back in input order. Pass either works or workId, not both.`,
      items: shorthand ? { anyOf: [{ type: "string", pattern: WORK_PATTERN }, items] } : items,
    },
  })
}

export const WORK_ITEM = { workId: WORK }

/**
 * A selector instead of works: resolved at call time against a fresh listing and the ledger; the result lists every
 * matched work with its own result, and `dryRun` answers the match without acting.
 */
export const selector = (values: readonly string[], matches: string): Record<string, JsonSchema> => ({
  select: choice(values, `Act on every work that matches, instead of naming them: ${matches}. Pass either select, works or workId.`),
  dryRun: boolean("With select: list the works that match, and change nothing."),
})

export const PROBE_INPUT: JsonSchema = object({
  source: { type: "string", enum: ["works"], description: 'The source: "works", the only one.' },
})

export const STATUS_INPUT: JsonSchema = object({
  list: { type: "string", enum: ["works"], description: 'For a consumer binding the boxd.works.list snapshot: "works" answers the contract\'s list output instead of the plugin status.' },
})

export const JOB_INPUT: JsonSchema = object({
  workId: WORK,
  works: { type: "array", minItems: 1, maxItems: LIST_MAX_ITEMS, items: { type: "string", pattern: WORK_PATTERN }, description: "Many work ids in one call. Pass either works or workId, not both." },
  tail: integer(1, 20, "Also return this many of the session's newest assistant messages, oldest first, each redacted and cut to 300 characters."),
  full: boolean("Return the whole last assistant message in lastText, line breaks kept, up to 64,000 characters, instead of the 300-character cut. One work, or at most 10 items in a works list."),
  cost: boolean("Also return the work's machine and model cost."),
})

export const READ_INPUT: JsonSchema = object(
  {
    workId: WORK,
    path: string("A path relative to the guest folder, with no '..'. A symlink that leaves the tree is refused."),
    log: choice(["server"], "The guest's OpenCode server log, instead of a path."),
    tail: integer(1, 2000, "Only the last lines."),
    maxBytes: integer(1, 262144, "The most bytes returned; 32768 by default."),
  },
  ["workId"],
)

const ENSURE_ITEM = {
  labels: {
    type: "object",
    description:
      "What the work is, for the fleet: product, role, feature and task, each a boxd label value. An ensure that passes labels replaces them; one that omits them keeps the recorded ones. A work on its own machine also carries them as work.product, work.role, work.feature and work.task; a slot on a shared machine records them here only.",
    properties: {
      product: string('The product it serves, such as "checkout".'),
      role: string('What it is doing for the feature, such as "lane" or "review".'),
      feature: string('The feature it serves, as a tracker reference such as "boxd-plugin/59".'),
      task: string('The task it does, as a tracker reference such as "boxd-plugin/130".'),
    },
    additionalProperties: false,
  },
  ...WORK_ITEM,
  machine: SHARED_MACHINE,
  region: choice(["auto", ...REGIONS], 'Where a new work goes; "auto" picks the region with the most free machines among those the option "regions" allows. An existing work keeps its own region, though a named region is still checked against "regions".'),
  size: SIZE,
  model: { ...MODEL, description: `${MODEL.description as string} Recorded as the work's default, for its first session.` },
  git: GIT,
  env: ENV,
  repo: REPO,
  ref: REF,
  directory: DIRECTORY,
  title: TITLE,
  wait: choice(["ready", "created", "none"], 'How long to wait: "ready" (default) waits up to 90 s for the guest\'s OpenCode; a list of more than 50 defaults to "created".'),
  repair: choice(["reboot"], "Reboot a machine whose boxd VM agent does not answer; a reboot ends a running run."),
  adopt: boolean("Adopt an existing oc-<id> that lacks the plugin's labels."),
}

export const ENSURE_INPUT = listable(ENSURE_ITEM, ["workId"], "an object like the single form", {
  select: choice(["orphans"], 'Adopt every actionable orphan that boxd_status lists, instead of naming works: it reads each guest\'s describe and work.* labels, records the work it finds and sets this ledger\'s labels, without setup, clone, upgrade or resize. Pass either select, works or workId.'),
  dryRun: boolean("With select: list the orphans that match, and change nothing."),
})

export const SUBMIT_INPUT = listable(
  {
    ...WORK_ITEM,
    text: string("The prompt."),
    mode: choice(["steer", "queue", "interrupt"], "How the prompt reaches a running session."),
    model: { ...MODEL, description: `${MODEL.description as string} A new session starts on it and an idle one switches; a running one switches only with mode "interrupt".` },
    files: {
      type: "array",
      description: "Files here to copy into the work tree before the prompt. 8 MiB each, 32 MiB together.",
      items: object({ from: string("A file here inside the project or an allowed root; no symlinks."), to: string('A path inside the work tree, such as "data/input.json".') }, ["from", "to"]),
    },
    title: TITLE,
    notify: {
      anyOf: [{ type: "boolean" }, { type: "string", pattern: SESSION_PATTERN }],
      description: "Which session gets this work's notices: true (the root of the calling session), false (none), or a session id. Left out from a script, the existing subscription stays.",
    },
  },
  ["workId", "text"],
  "an object like the single form",
)

export const HARVEST_INPUT = listable(
  {
    ...WORK_ITEM,
    files: { type: "array", items: { type: "string" }, description: "Paths inside the work tree to copy back, such as SUMMARY.md. 8 MiB each, 32 MiB together." },
    to: string("The folder here that receives the files; the work's folder by default."),
    localDirectory: string("The folder here the transcript is imported into; the work's folder by default."),
    partial: boolean("Harvest a running session as it is now. The work stays not saved, so drop still refuses."),
  },
  ["workId"],
  "an object like the single form",
  selector(["unsaved-finished"], '"unsaved-finished" is every finished work, running or asleep, that is not saved'),
  true,
)

export const SLEEP_INPUT = listable(
  WORK_ITEM,
  ["workId"],
  "an object with a workId",
  selector(["idle", "finished"], '"idle" is every running work that is idle or ready and not waiting on a person; "finished" is every idle work whose last run has an outcome'),
  true,
)

export const RESUME_INPUT = listable(WORK_ITEM, ["workId"], "an object with a workId", {}, true)

export const REASSIGN_INPUT = object(
  {
    from: { ...WORK, description: "The work whose machine moves." },
    to: { ...WORK, description: "The new work id." },
    directory: DIRECTORY,
    repo: REPO,
    ref: REF,
    model: MODEL,
    git: GIT,
    title: TITLE,
  },
  ["from", "to"],
)

export const GOLDEN_INPUT = object({
  region: choice([...REGIONS, "all"], 'Which region; every region the option "regions" allows by default, and a prune may name any region.'),
  size: SIZE,
  from: string('"stock", or a base snapshot name in that region; the goldenBase option by default. A warm build always starts from its version\'s image.'),
  repo: string('An https://github.com/owner/repo URL listed in the plugin option "warm": build that repository\'s warm image, with its checkout and setup script, from its OpenCode version\'s golden image.'),
  rebuild: boolean("Rebuild an image that exists, under the same name."),
  prune: boolean("Remove the images that no open work records and that are not the current version's, and list them."),
})

export const EXEC_INPUT = object(
  {
    workId: WORK,
    command: { type: "array", minItems: 1, items: { type: "string" }, description: 'The command and its arguments, such as ["git", "status", "--short"].' },
    timeout: integer(1, 600, "Seconds before boxd kills the command; 60 by default."),
    wake: boolean("Wake a hibernated machine first."),
  },
  ["workId", "command"],
)

export const DROP_INPUT = listable(
  { ...WORK_ITEM, confirmGone: boolean("Close a work with no recorded machine id as gone.") },
  ["workId"],
  "an object like the single form",
  selector(["saved-finished"], '"saved-finished" is every work, running or asleep, that is saved and whose last run completed; each still passes the whole guard'),
  true,
)
