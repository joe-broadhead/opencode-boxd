import { boxdError } from "./errors.js"

const WORK = /^[a-z][a-z0-9-]{0,24}$/
const SESSION = /^ses_[A-Za-z0-9_-]{1,80}$/
const SNAPSHOT = /^[a-z0-9][a-z0-9._-]{0,63}$/
const DIRECTORY = /^\/[A-Za-z0-9_./-]+$/
const REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/

export function assertWorkId(workId: string): void {
  if (!WORK.test(workId)) throw boxdError("NAME_INVALID", `Work id "${workId}" is not a short lowercase name.`)
}

export function machineName(workId: string): string {
  assertWorkId(workId)
  return `oc-${workId}`
}

export function assertSessionId(id: string): string {
  if (!SESSION.test(id)) throw boxdError("NAME_INVALID", `Session id "${id}" is not an OpenCode session id.`)
  return id
}

export function assertDirectory(path: string): string {
  if (!DIRECTORY.test(path) || path.includes("..") || path.endsWith("/")) {
    throw boxdError("NAME_INVALID", `Directory "${path}" must be an absolute guest path with no spaces or "..".`)
  }
  return path
}

export function assertSnapshot(name: string): string {
  if (!SNAPSHOT.test(name)) throw boxdError("NAME_INVALID", `Snapshot name "${name}" is not a boxd snapshot name.`)
  return name
}

export function assertRepo(url: string): string {
  if (!REPO.test(url)) throw boxdError("NAME_INVALID", "Repo must be an https://github.com/owner/repo URL.")
  return url
}

export function workDirectory(workId: string): string {
  assertWorkId(workId)
  return `/home/boxd/work/${workId}`
}
