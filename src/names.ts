import { createHash } from "node:crypto"
import { boxdError } from "./errors.js"

const WORK = /^[a-z][a-z0-9-]{0,24}$/
const SNAPSHOT = /^[a-z0-9][a-z0-9._-]{0,63}$/
const REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/
const REF = /^[A-Za-z0-9._/-]{1,120}$/
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

/** The one spelling of a repository URL: its optional `.git` is not part of the repository's name or hash. */
export function normaliseRepo(url: string): string {
  assertRepo(url)
  return url.endsWith(".git") ? url.slice(0, -4) : url
}

export function assertRef(ref: string): string {
  if (!REF.test(ref)) throw boxdError("NAME_INVALID", `ref "${ref}" is not a branch or tag name: up to 120 letters, digits, dots, underscores, slashes or hyphens.`)
  return ref
}
/** A repository's short name, lowercased and made a snapshot name's part: the last path segment. */
export function repositorySlug(url: string): string {
  const name = new URL(normaliseRepo(url)).pathname.split("/").filter(Boolean).pop() ?? "repo"
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")
  return slug || "repo"
}

/** The first 8 hex of a repository URL's SHA-256: what tells two repositories with one name apart. */
export function repositoryHash(url: string): string {
  return createHash("sha256").update(normaliseRepo(url)).digest("hex").slice(0, 8)
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
