import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const NAME = "@joe-broadhead/opencode-boxd"
const MAX_BYTES = 200_000
const ALLOWED = /^(package\.json|README\.md|LICENSE|NOTICE|CHANGELOG\.md|dist\/index\.js|guest\/guest\.py|skills\/boxd\/SKILL\.md)$/
const REQUIRED = ["dist/index.js", "guest/guest.py", "skills/boxd/SKILL.md"]

const arg = process.argv.indexOf("--tarball")
const given = arg === -1 ? undefined : process.argv[arg + 1]
const tarball = given ?? pack()
const files = list(tarball)
const unexpected = files.filter((file) => !ALLOWED.test(file))
const missing = REQUIRED.filter((file) => !files.includes(file))
if (unexpected.length || missing.length) {
  console.error("pack-smoke: file list", { unexpected, missing })
  process.exit(1)
}
const bytes = Number(execFileSync("wc", ["-c", tarball], { encoding: "utf8" }).trim().split(/\s+/)[0])
if (bytes > MAX_BYTES) {
  console.error(`pack-smoke: ${bytes} bytes exceeds ${MAX_BYTES}`)
  process.exit(1)
}
const built = readFileSync(join(root, "dist/index.js"), "utf8")
if (/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\(\s*)["']\.{1,2}\//.test(built)) {
  console.error("pack-smoke: dist/index.js has a relative import")
  process.exit(1)
}
const dir = mkdtempSync(join(tmpdir(), "boxd-pack-"))
try {
  execFileSync("npm", ["init", "-y"], { cwd: dir, stdio: "ignore" })
  execFileSync("npm", ["install", "--ignore-scripts", "--no-save", tarball, "@opencode/plugin@2.2.6"], { cwd: dir, stdio: "inherit" })
  const loaded = await import(pathToFileURL(join(dir, "node_modules", NAME, "dist", "index.js")).href)
  if (loaded.default?.id !== "boxd") {
    console.error(`pack-smoke: plugin id is ${loaded.default?.id}`)
    process.exit(1)
  }
  console.log(`pack-smoke: OK ${files.length} files, ${bytes} bytes`)
} finally {
  rmSync(dir, { recursive: true, force: true })
  if (!given) unlinkSync(tarball)
}

function pack() {
  const out = execFileSync("npm", ["pack", "--ignore-scripts", "--json"], { cwd: root, encoding: "utf8" })
  return join(root, JSON.parse(out).at(-1).filename)
}

function list(file) {
  return execFileSync("tar", ["-tzf", file], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^[^/]+\//, ""))
    .filter((line) => !line.endsWith("/"))
}
