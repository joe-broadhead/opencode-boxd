// Laptop paths for the files a work moves in and out. A path must be inside the project or a root the user names, it
// must not be a symlink, and it must stay inside the root once resolved: a plugin that writes a user's files is exactly
// where a `..` or a symlinked folder would escape.
import { createHash } from "node:crypto"
import { lstat, readFile, realpath, stat, writeFile, mkdir, rename, unlink } from "node:fs/promises"
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

/** A laptop file, read once, with the size and digest the ledger records. */
interface LoadedFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly body: Buffer
}

export async function loadFile(path: string, roots: readonly string[]): Promise<LoadedFile> {
  const real = await resolveLaptopPath(path, roots)
  const info = await stat(real)
  if (!info.isFile()) throw boxdError("PATH_REFUSED", `"${path}" is not a file.`)
  if (info.size > FILE_LIMIT) throw boxdError("FILE_TOO_LARGE", `"${path}" is ${info.size} bytes; the limit is ${FILE_LIMIT}.`)
  const body = await readFile(real)
  return { path: real, bytes: body.byteLength, sha256: sha256(body), body }
}

/** The cap over a whole call: every file counted together. */
export function assertTotal(files: readonly { bytes: number }[]): void {
  const total = files.reduce((sum, file) => sum + file.bytes, 0)
  if (total > TOTAL_LIMIT) throw boxdError("FILE_TOO_LARGE", `The files total ${total} bytes; the limit is ${TOTAL_LIMIT}.`)
}

export const sha256 = (body: Buffer) => createHash("sha256").update(body).digest("hex")

/**
 * Writes a file the guest produced: a unique temp file beside it, then a rename, 0600. It refuses to replace a file whose
 * current digest differs from the one last harvested, so a local edit is never overwritten.
 */
export async function storeFile(path: string, body: Buffer, previous: string | undefined): Promise<void> {
  const existing = await readFile(path).catch(() => undefined)
  if (existing) {
    const digest = sha256(existing)
    if (digest !== sha256(body) && digest !== previous) {
      throw boxdError("FILE_CONFLICT", `"${path}" changed since the last harvest, so it was not overwritten.`)
    }
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, body, { mode: 0o600 })
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw boxdError("LEDGER_FAILED", `"${path}" could not be written: ${error instanceof Error ? error.message : String(error)}`)
  }
}
