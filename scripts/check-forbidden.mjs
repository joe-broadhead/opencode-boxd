import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const SELF = "scripts/check-forbidden.mjs"
const SCANNED = ["src", "test", "scripts", "guest"]

const RULES = [
  { name: "V1 plugin package", pattern: /@opencode-ai\//, sample: 'import { tool } from "@opencode-ai/plugin"' },
  { name: "ctx.generate (deprecated)", pattern: /ctx\.generate\./, sample: "await ctx.generate.text(input)" },
  { name: "private OpenCode source import", pattern: /packages\/(core|plugin|schema|sdk|server|tui)\/src/, sample: 'import x from "packages/core/src/index.ts"' },
  { name: "machine-local path", pattern: new RegExp(["", "Users", ""].join("/")), sample: ["const home = \"", "Users", "someone\""].join("/") },
  { name: "relative import in built output", scope: "dist", pattern: /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)["']\.{1,2}\//, sample: 'import { x } from "./rpc.js"' },
  { name: "opencode run on a guest", pattern: /opencode run\b/, sample: "opencode run --auto" },
]

function inScope(rule, file) {
  if (rule.scope === "dist") return file.startsWith("dist/") && file.endsWith(".js")
  return !file.startsWith("dist/")
}

function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path)
    return [path]
  })
}

function files(base) {
  try {
    return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...SCANNED], {
      cwd: base,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split("\0").filter(Boolean)
  } catch {
    return SCANNED.flatMap((dir) => walk(join(base, dir)).map((path) => relative(base, path).split(sep).join("/")))
  }
}

function scan(base) {
  const hits = []
  const list = [...new Set([...files(base), ...walk(join(base, "dist")).map((path) => relative(base, path).split(sep).join("/"))])]
  for (const file of list) {
    if (file === SELF || !existsSync(join(base, file))) continue
    readFileSync(join(base, file), "utf8").split("\n").forEach((line, index) => {
      for (const rule of RULES) {
        if (inScope(rule, file) && rule.pattern.test(line)) hits.push({ file, line: index + 1, rule: rule.name })
      }
    })
  }
  return hits
}

function write(base, file, text) {
  mkdirSync(dirname(join(base, file)), { recursive: true })
  writeFileSync(join(base, file), `${text}\n`)
}

if (process.argv.includes("--self-test")) {
  const base = mkdtempSync(join(tmpdir(), "boxd-forbidden-"))
  try {
    const bad = join(base, "bad")
    RULES.forEach((rule, index) => write(bad, rule.scope === "dist" ? `dist/bad-${index}.js` : `src/bad-${index}.ts`, rule.sample))
    const missed = RULES.filter((rule) => !scan(bad).some((hit) => hit.rule === rule.name))
    if (missed.length) {
      console.error("check-forbidden self-test failed", missed.map((rule) => rule.name))
      process.exitCode = 1
    } else console.log("check-forbidden self-test: OK")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
} else {
  const hits = scan(root)
  if (hits.length) {
    for (const hit of hits) console.error(`${hit.file}:${hit.line} ${hit.rule}`)
    process.exitCode = 1
  } else console.log("check-forbidden: OK")
}
