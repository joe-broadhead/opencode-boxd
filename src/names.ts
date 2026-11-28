import { createHash } from "node:crypto"
import { boxdError } from "./errors.js"
import { LABEL_VALUE, WORK_LABEL_KEYS, WORK_LABEL_PREFIX, type MachineName, type WorkLabelKey, type WorkLabels } from "./ports.js"

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

/** The short name a work gives a shared machine: `docs` means `oc-shared-docs`. */
export function assertSharedMachine(name: string): string {
  if (!WORK.test(name)) throw boxdError("NAME_INVALID", `machine "${name}" is not a shared machine name: a letter, then up to 24 lowercase letters, digits or hyphens.`)
  return name
}

/** A work's labels, each a boxd label value; `field` names the input in a refusal, such as `works[0].labels`. */
export function assertWorkLabels(value: unknown, field = "labels"): WorkLabels {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw boxdError("NAME_INVALID", `${field} must be an object with any of "product", "role", "feature" and "task".`, { field })
  }
  const labels: Partial<Record<WorkLabelKey, string>> = {}
  for (const [key, label] of Object.entries(value)) {
    const name = `${field}.${key}`
    if (!(WORK_LABEL_KEYS as readonly string[]).includes(key)) {
      throw boxdError("NAME_INVALID", `${name} is not a work label; use product, role, feature or task.`, { field: name })
    }
    if (typeof label !== "string" || !LABEL_VALUE.test(label)) {
      throw boxdError("NAME_INVALID", `${name} must be a boxd label value: up to 63 letters, digits or . _ / @ : - with no spaces.`, { field: name })
    }
    labels[key as WorkLabelKey] = label
  }
  return labels
}

/** The `work.<key>` machine labels for a work's labels. */
export function machineWorkLabels(labels: WorkLabels | undefined): Record<string, string> {
  if (!labels) return {}
  return Object.fromEntries(Object.entries(labels).map(([key, value]) => [`${WORK_LABEL_PREFIX}${key}`, value]))
}

/** A machine's `work.*` labels as a work's labels; an empty value is no label. */
export function readWorkLabels(labels: Readonly<Record<string, string>>): WorkLabels | undefined {
  const work: Partial<Record<WorkLabelKey, string>> = {}
  for (const key of WORK_LABEL_KEYS) {
    const value = labels[`${WORK_LABEL_PREFIX}${key}`]
    if (value !== undefined && value !== "") work[key] = value
  }
  return Object.keys(work).length > 0 ? work : undefined
}

export function sharedMachineName(name: string): MachineName {
  return `oc-shared-${assertSharedMachine(name)}` as MachineName
}

/** The short name from a shared machine's name, or undefined for a machine a work owns. */
export function sharedAliasOf(machine: string): string | undefined {
  const prefix = "oc-shared-"
  if (!machine.startsWith(prefix)) return undefined
  const name = machine.slice(prefix.length)
  return WORK.test(name) ? name : undefined
}

/** A model reference the guest's OpenCode accepts, such as `anthropic/claude-sonnet-4-5`. */
export function assertModel(model: string): string {
  if (!MODEL.test(model)) throw boxdError("NAME_INVALID", `model "${model}" is not a model reference: write provider/model, such as anthropic/claude-sonnet-4-5, with #variant when the model has one.`)
  return model
}
