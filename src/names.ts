import { boxdError } from "./errors.js"

const WORK = /^[a-z][a-z0-9-]{0,24}$/
const SNAPSHOT = /^[a-z0-9][a-z0-9._-]{0,63}$/
const REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/
/** OpenCode's model reference: `provider/model`, and `#variant` when the model has one. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:\/@-]{0,127}(?:#[A-Za-z0-9][A-Za-z0-9._-]{0,31})?$/

export function assertWorkId(workId: string): void {
  if (!WORK.test(workId)) throw boxdError("NAME_INVALID", `workId "${workId}" is not a short lowercase name: a letter, then up to 24 lowercase letters, digits or hyphens.`)
}

export function assertSnapshot(name: string): string {
  if (!SNAPSHOT.test(name)) throw boxdError("NAME_INVALID", `Snapshot name "${name}" is not a boxd snapshot name: up to 64 lowercase letters, digits, dots, underscores or hyphens.`)
  return name
}

export function assertRepo(url: string): string {
  if (!REPO.test(url)) throw boxdError("NAME_INVALID", "repo must be an https://github.com/owner/repo URL.")
  return url
}

export function workDirectory(workId: string): string {
  assertWorkId(workId)
  return `/home/boxd/work/${workId}`
}

/** A model reference the guest's OpenCode accepts, such as `anthropic/claude-sonnet-4-5`. */
export function assertModel(model: string): string {
  if (!MODEL.test(model)) throw boxdError("NAME_INVALID", `model "${model}" is not a model reference: write provider/model, such as anthropic/claude-sonnet-4-5, with #variant when the model has one.`)
  return model
}
