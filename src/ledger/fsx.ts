/**
 * The ledger's file primitives (design §2.2). Every ledger file is written copy-on-write: a unique temp file in the same
 * folder, verified where it has a digest, fsynced, and renamed over the old one. Nothing here opens an existing ledger
 * file for writing, so a file that shares its inode with another (a hard link) is replaced, never written through.
 * The one exception, `events.jsonl`, appends in `events.ts`.
 *
 * Bodies are streamed: no transcript, patch or untracked file is held whole on the server's thread (design §4.3).
 */
import { createHash, randomBytes } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { chmod, mkdir, open, rename, rm, stat, unlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { boxdError, type Code } from "../errors.js"

export const DIR_MODE = 0o700
export const FILE_MODE = 0o600

/** A short random part for temp and staging names. */
export const randomPart = () => randomBytes(6).toString("hex")

/** A unique temp path beside `path`: `.<name>.<pid>.<rand>.tmp` in the same folder, so the rename stays on one disk. */
export const tempBeside = (path: string) => join(dirname(path), `.${basename(path)}.${process.pid}.${randomPart()}.tmp`)

export const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code

/** The file's size and streamed sha256. */
export interface Digest {
  readonly bytes: number
  readonly sha256: string
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIR_MODE })
}

/** Flushes a folder's entries, so a rename in it survives a power cut. A file system that cannot do it is not an error. */
export async function fsyncDir(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, "r")
    await handle.sync()
  } catch (error) {
    if (!["EINVAL", "EISDIR", "EPERM", "EBADF", "ENOTSUP"].includes(errnoOf(error) ?? "")) throw error
  } finally {
    await handle?.close()
  }
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Streams a file's size and sha256: the body never sits whole in memory. */
export async function digestFile(path: string): Promise<Digest> {
  const hash = createHash("sha256")
  let bytes = 0
  for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 })) {
    const buffer = chunk as Buffer
    bytes += buffer.byteLength
    hash.update(buffer)
  }
  return { bytes, sha256: hash.digest("hex") }
}

/**
 * Called right before the rename that makes a write visible: the ledger's fence (its lock still held, the ledger not
 * disposed). When it throws, the temp file is deleted and the old file stays as it was.
 */
export type BeforeRename = () => Promise<void>

/** Writes `data` copy-on-write: a new temp file, fsynced, renamed over `path`, and the folder fsynced. */
export async function writeFileAtomic(path: string, data: string | Uint8Array, beforeRename?: BeforeRename): Promise<void> {
  await ensureDir(dirname(path))
  const temp = tempBeside(path)
  try {
    const handle = await open(temp, "wx", FILE_MODE)
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await beforeRename?.()
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
  await fsyncDir(dirname(path))
}

export const writeJsonAtomic = (path: string, value: unknown, beforeRename?: BeforeRename) => writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, beforeRename)

/**
 * Moves a finished temp file over `target`: checks its size and sha256 against `expect` when given, fsyncs it, sets 0600,
 * renames it, and fsyncs the folder. A mismatch deletes the temp file and leaves `target` exactly as it was.
 */
export async function commitFile(temp: string, target: string, expect?: Digest, mismatch: Code = "EXPORT_INVALID", beforeRename?: BeforeRename): Promise<Digest> {
  try {
    const actual = await digestFile(temp)
    if (expect && (actual.bytes !== expect.bytes || actual.sha256 !== expect.sha256)) {
      throw boxdError(
        mismatch,
        `${basename(target)} arrived with ${actual.bytes} bytes and sha256 ${actual.sha256.slice(0, 12)}…, not the ${expect.bytes} bytes and ${expect.sha256.slice(0, 12)}… the guest reported; the stored copy was kept.`,
      )
    }
    await chmod(temp, FILE_MODE)
    await fsyncFile(temp)
    await ensureDir(dirname(target))
    await beforeRename?.()
    await rename(temp, target)
    await fsyncDir(dirname(target))
    return actual
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

/**
 * Copies `source` to `target` copy-on-write: a streamed copy into a temp file beside `target`, hashed on the way, then
 * committed against the source's own digest. Always a copy, never a hard link: no ledger file shares an inode with its
 * source (design §6.1, round 2 M-a).
 */
export async function copyFileAtomic(source: string, target: string, beforeRename?: BeforeRename): Promise<Digest> {
  await ensureDir(dirname(target))
  const temp = tempBeside(target)
  const hash = createHash("sha256")
  let bytes = 0
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.byteLength
      hash.update(chunk)
      done(null, chunk)
    },
  })
  try {
    await pipeline(createReadStream(source, { highWaterMark: 256 * 1024 }), tap, createWriteStream(temp, { flags: "wx", mode: FILE_MODE }))
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
  return commitFile(temp, target, { bytes, sha256: hash.digest("hex") }, "LEDGER_FAILED", beforeRename)
}

/** Removes a file or folder; a missing one is fine. */
export const remove = (path: string) => rm(path, { recursive: true, force: true })

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (errnoOf(error) === "ENOENT" || errnoOf(error) === "ENOTDIR") return false
    throw error
  }
}
