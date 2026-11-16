// Laptop paths for the files a work moves in and out. A path must be inside the project or a root the user names, it
// must not be a symlink, and it must stay inside the root once resolved: a plugin that writes a user's files is exactly
// where a `..` or a symlinked folder would escape.
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { chmod, lstat, realpath, stat, rename, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { boxdError } from "./errors.js"

/** The largest single file a work moves in or out. */
export const FILE_LIMIT = 8 * 1024 * 1024
/** The largest set of files one call moves. */
export const TOTAL_LIMIT = 32 * 1024 * 1024

/** A path relative to the work tree, as the guest and the ledger name it: no absolute path, no `..`. */
export function assertWorkPath(path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || /(^|\/)\.\.?(\/|$)/.test(path) || path.endsWith("/")) {
    throw boxdError("PATH_REFUSED", `"${path}" is not a path inside the work tree.`)
  }
  return path
}

const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)

/**
 * Resolves a laptop path against the project and the allowed roots, and refuses one that escapes them, or one that is a
 * symlink. `create` permits a path that does not exist yet, as long as its nearest existing parent is inside a root.
 */
export async function resolveLaptopPath(path: string, roots: readonly string[], options: { create?: boolean } = {}): Promise<string> {
  const absolute = isAbsolute(path) ? path : resolve(roots[0] ?? process.cwd(), path)
  const realRoots = await Promise.all(roots.map(async (root) => realpath(root).catch(() => resolve(root))))
  let real: string
  try {
    // The final component may not be a link, even one that stays inside the root: a work file is a file.
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw boxdError("PATH_REFUSED", `"${path}" is a symlink, which this plugin never follows.`)
    real = await realpath(absolute)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT" && options.create) {
      const parent = await nearestExisting(absolute)
      const realParent = await realpath(parent).catch(() => parent)
      if (!realRoots.some((root) => inside(root, realParent))) throw refused(path, roots)
      return join(realParent, relative(parent, absolute))
    }
    if (error instanceof Error && error.message.startsWith("PATH_REFUSED")) throw error
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // A missing path inside a root is a typo; one outside every root is refused by name, before anything is read.
      const parent = await nearestExisting(absolute)
      const realParent = await realpath(parent).catch(() => parent)
      if (!realRoots.some((root) => inside(root, realParent))) throw refused(path, roots)
      throw boxdError("NAME_INVALID", `"${path}" does not exist.`)
    }
    throw boxdError("PATH_REFUSED", `"${path}" cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  // A root reached through a symlink (macOS `/var` is one) is fine: containment is checked against the real root, so a
  // link anywhere below it that points outside is refused here.
  if (!realRoots.some((root) => inside(root, real))) throw refused(path, roots)
  return real
}

/**
 * An existing laptop folder, resolved through every symlink, is still inside a real root: the check after a `mkdir`, so
 * a symlink put in a destination's way since it was resolved is refused before anything is written there.
 */
export async function assertInsideRoots(folder: string, roots: readonly string[]): Promise<void> {
  const real = await realpath(folder)
  const realRoots = await Promise.all(roots.map(async (root) => realpath(root).catch(() => resolve(root))))
  if (!realRoots.some((root) => inside(root, real))) throw refused(folder, roots)
}

/** The root list: the project first, then the user's allowed roots. */
export function rootsOf(projectDirectory: string, allowedRoots: readonly string[]): string[] {
  return [projectDirectory, ...allowedRoots]
}

const refused = (path: string, roots: readonly string[]) =>
  boxdError(
    "PATH_REFUSED",
    `"${path}" is outside the project${roots.length > 1 ? " and the allowed roots" : ""}. Allowed: ${roots.join(", ")}.`,
  )

async function nearestExisting(path: string): Promise<string> {
  let current = path
  for (;;) {
    try {
      await lstat(current)
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return current
      current = parent
    }
  }
}

/** The cap over a whole call: every file counted together. */
export function assertTotal(files: readonly { bytes: number }[]): void {
  const total = files.reduce((sum, file) => sum + file.bytes, 0)
  if (total > TOTAL_LIMIT) throw boxdError("FILE_TOO_LARGE", `The files total ${total} bytes; the limit is ${TOTAL_LIMIT}.`)
}

/** A file's size and sha256, streamed, so a large file never sits whole on the server's thread (design §4.3). */
export async function digestFile(path: string): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const hash = createHash("sha256")
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    bytes += (chunk as Buffer).byteLength
    hash.update(chunk as Buffer)
  }
  return { bytes, sha256: hash.digest("hex") }
}

/**
 * A laptop file a submit copies up: inside a root, not a symlink, a regular file within `FILE_LIMIT`, with its size and
 * streamed sha256. Its bytes are never read into the server; `machine cp` sends them.
 */
export async function laptopFile(path: string, roots: readonly string[]): Promise<{ readonly path: string; readonly bytes: number; readonly sha256: string }> {
  const real = await resolveLaptopPath(path, roots)
  const info = await stat(real)
  if (!info.isFile()) throw boxdError("PATH_REFUSED", `"${path}" is not a file.`)
  if (info.size > FILE_LIMIT) throw boxdError("FILE_TOO_LARGE", `"${path}" is ${info.size} bytes; the limit is ${FILE_LIMIT}.`)
  const digest = await digestFile(real)
  if (digest.bytes > FILE_LIMIT) throw boxdError("FILE_TOO_LARGE", `"${path}" is ${digest.bytes} bytes; the limit is ${FILE_LIMIT}.`)
  return { path: real, ...digest }
}

/**
 * Puts a file that came back from the guest in place: `temp` (already beside `path`, written by `machine cp`) is checked
 * against the size limit, then renamed over `path`, 0600. A laptop file whose digest differs from both the new one and
 * the one last harvested is a local edit, so it is kept and the temp file deleted (`FILE_CONFLICT`).
 */
export async function placeFile(temp: string, path: string, previous: string | undefined): Promise<{ readonly bytes: number; readonly sha256: string }> {
  try {
    const digest = await digestFile(temp)
    if (digest.bytes > FILE_LIMIT) throw boxdError("FILE_TOO_LARGE", `"${path}" came back as ${digest.bytes} bytes; the limit is ${FILE_LIMIT}.`)
    const existing = await digestFile(path).catch(() => undefined)
    if (existing && existing.sha256 !== digest.sha256 && existing.sha256 !== previous) {
      throw boxdError("FILE_CONFLICT", `"${path}" changed since the last harvest, so it was not overwritten.`)
    }
    await chmod(temp, 0o600)
    await rename(temp, path)
    return digest
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}
