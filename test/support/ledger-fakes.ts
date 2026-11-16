// Narrow fakes for the ledger and import tests: a boxd port that answers the import's listing and `get`, a direct spawn
// for the prover, and helpers that read a folder tree back for byte-for-byte comparisons.
import { spawn as spawnChild } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { boxdError } from "../../src/errors.js"
import type { ImportBoxd } from "../../src/import-v0.js"
import type { Listing, MachineId, MachineInfo, MachineRow, Region, SpawnRequest, SpawnResult } from "../../src/ports.js"

export const FIXTURE = join(import.meta.dir, "..", "fixtures", "v0-ledger")

/** A private temp root under the system's temp folder (TMPDIR when set). */
export function tempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)))
}

/** A temp root holding a copy of the v0 fixture ledger at `works/`. */
export function v0Root(prefix = "boxd-import-"): string {
  const root = tempRoot(prefix)
  cpSync(FIXTURE, root, { recursive: true, preserveTimestamps: true })
  return root
}

export const removeRoot = (root: string) => rmSync(root, { recursive: true, force: true })

export const row = (name: string, region: Region, over: Partial<MachineRow> = {}): MachineRow => ({
  name,
  region,
  id: null,
  status: "running",
  size: null,
  labels: { role: "session", work: name.slice(3) },
  sharing: "private",
  isolated: null,
  ...over,
})

/** The machines the fixture's works have: most in fra, one in nyc, one hibernated, none for the pending create. */
export const FIXTURE_ROWS: readonly MachineRow[] = [
  row("oc-proven-fresh", "fra", { size: "4x16" }),
  row("oc-proven-stale", "nyc", { size: "2x8" }),
  row("oc-never-prompted", "fra", { size: "1x4" }),
  row("oc-slept-work", "fra", { status: "hibernated", size: "8x32" }),
  row("oc-empty-proof", "fra"),
  row("oc-old-shape", "fra", { size: "2x8" }),
  // A machine of the same name in the other region that is not this work's: the labelled one wins.
  row("oc-old-shape", "nyc", { labels: { role: "session", work: "someone-else" } }),
  row("oc-laptop-id", "fra"),
  row("oc-missing-export", "fra"),
]

export const idOf = (name: string, region: Region) => `vm_${region}_${name.slice(3)}` as MachineId

export interface FakeImportBoxd extends ImportBoxd {
  lists: number
  gets: string[]
  failList: string | null
  failGet: Set<string>
  rows: MachineRow[]
}

export function fakeImportBoxd(rows: readonly MachineRow[] = FIXTURE_ROWS): FakeImportBoxd {
  const fake: FakeImportBoxd = {
    lists: 0,
    gets: [],
    failList: null,
    failGet: new Set(["oc-laptop-id"]),
    rows: [...rows],
    async list(options) {
      fake.lists += 1
      if (fake.failList) throw boxdError("BOXD_FAILED", fake.failList)
      const listing: Listing = { takenAt: Date.now(), fresh: options.maxAgeMs === 0, machines: fake.rows }
      return listing
    },
    async get(region, name) {
      fake.gets.push(`${region}:${name}`)
      if (fake.failGet.has(name)) throw boxdError("BOXD_FAILED", "get failed")
      const found = fake.rows.find((item) => item.name === name && item.region === region)
      if (!found) throw boxdError("BOXD_FAILED", "not found")
      const info: MachineInfo = { ...found, id: idOf(name, region), isolated: false }
      return info
    },
  }
  return fake
}

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

/** The published ledger's files, with each run's own time stamps taken out of the marker and the report. */
export function publishedContent(root: string) {
  return contentOf(readTree(join(root, "v1"), (path) => path === "index.json")).map((entry) => {
    if (entry.path !== "complete" && entry.path !== "import-v0.json") return entry
    const body = JSON.parse(readFileSync(join(root, "v1", entry.path), "utf8")) as Record<string, unknown>
    delete body.at
    return { ...entry, sha256: JSON.stringify(body) }
  })
}
