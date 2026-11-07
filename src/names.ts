import { BoxdError } from "./errors.js"

const WORK = /^[a-z][a-z0-9-]{0,24}$/
const SESSION = /^ses[A-Za-z0-9_-]{1,80}$/
const SNAPSHOT = /^[a-z0-9][a-z0-9._-]{0,63}$/
const DIRECTORY = /^\/[A-Za-z0-9_./-]+$/
const REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/

export function assertWorkId(workId: string): void {
  if (!WORK.test(workId)) {
    throw new BoxdError("NAME_INVALID", `Work id "${workId}" is not a short lowercase name.`, "Use a work id like review-api.")
  }
}

export function machineName(workId: string): string {
  assertWorkId(workId)
  return `oc-${workId}`
}

export function assertSessionId(id: string): string {
  if (!SESSION.test(id)) {
    throw new BoxdError("NAME_INVALID", `Session id "${id}" is not an OpenCode session id.`, "Use the id a boxd tool returned.")
  }
  return id
}

export function assertDirectory(path: string): string {
  if (!DIRECTORY.test(path) || path.includes("..") || path.endsWith("/")) {
    throw new BoxdError(
      "NAME_INVALID",
      "Directory must be an absolute guest path with no spaces or ..",
      "Pass a path like /home/boxd/work/review-api.",
    )
  }
  return path
}

export function assertSnapshot(name: string): string {
  if (!SNAPSHOT.test(name)) {
    throw new BoxdError("NAME_INVALID", `Snapshot name "${name}" is not a boxd snapshot name.`, "Use a lowercase snapshot name.")
  }
  return name
}

export function assertRepo(url: string): string {
  if (!REPO.test(url)) {
    throw new BoxdError("NAME_INVALID", "Repo must be an https://github.com/owner/repo URL.", "Do not pass a shell command or a token.")
  }
  return url
}

export function workDirectory(workId: string): string {
  return `/home/boxd/work/${assertWorkIdReturn(workId)}`
}

function assertWorkIdReturn(workId: string): string {
  assertWorkId(workId)
  return workId
}
