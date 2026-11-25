// Helpers for the ledger tests: a direct spawn for the prover, and a folder read back for byte-for-byte comparisons.
import { spawn as spawnChild } from "node:child_process"
import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import type { SpawnRequest, SpawnResult } from "../../src/ports.js"

export { tempRoot, removeRoot } from "./temp.js"

/** A direct spawn for the prover: one child, its timeout, no pool. The runner does this in the plugin. */
export function directSpawn(request: SpawnRequest): Promise<SpawnResult> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawnChild(request.bin, [...request.args], { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGKILL"), request.timeoutMs)
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", reject)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr, ms: Date.now() - started })
    })
    child.stdin.end(request.stdin ?? "")
  })
}

export interface TreeEntry {
  readonly path: string
  readonly kind: "file" | "dir"
  readonly sha256?: string
  readonly mode: number
  readonly ino: number
}

/** Every file and folder under `root`, with its digest, mode and inode, sorted by path. */
export function readTree(root: string, skip: (path: string) => boolean = () => false): TreeEntry[] {
  const out: TreeEntry[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const rel = relative(root, path)
      if (skip(rel)) continue
      const info = lstatSync(path)
      if (info.isDirectory()) {
        out.push({ path: rel, kind: "dir", mode: info.mode & 0o777, ino: info.ino })
        walk(path)
      } else {
        out.push({ path: rel, kind: "file", sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), mode: info.mode & 0o777, ino: info.ino })
      }
    }
  }
  walk(root)
  return out
}

/** A tree's content only: paths, kinds and digests, without inodes or modes. */
export const contentOf = (tree: readonly TreeEntry[]) => tree.map(({ path, kind, sha256 }) => ({ path, kind, sha256 }))

/** The published ledger's files with the index left out, whose mtime cache is not content. */
export function publishedContent(root: string) {
  return contentOf(readTree(join(root, "v1"), (path) => path === "index.json"))
}
