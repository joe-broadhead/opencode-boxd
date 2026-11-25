// Bundles the server entry the host loads into one self-contained file: src/index.ts to dist/index.js. Shared code is
// inlined; there are no chunks and no relative imports, because OpenCode reloads a plugin in place and reuses the module
// records it already holds for unchanged paths. Only the modules the host provides stay external. The build fails if an
// output imports anything else. The bundle's whitespace and syntax are minified, never its names, so a stack trace still
// names each function.
import { build } from "esbuild"
import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const HOST = ["@opencode/plugin", "@opencode/plugin/*", "@opentui/*", "solid-js", "solid-js/*"]
const provided = (path) => path.startsWith("node:") || HOST.some((name) => (name.endsWith("/*") ? path.startsWith(name.slice(0, -1)) : path === name))

rmSync(join(root, "dist"), { recursive: true, force: true })
const result = await build({
  absWorkingDir: root,
  outdir: "dist",
  entryPoints: { index: "src/index.ts" },
  bundle: true,
  splitting: false,
  format: "esm",
  platform: "node",
  target: "es2023",
  external: HOST,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
  minifyWhitespace: true,
  minifySyntax: true,
})

const problems = Object.entries(result.metafile.outputs).flatMap(([file, output]) =>
  output.imports.filter((entry) => !entry.external || !provided(entry.path)).map((entry) => `${file} imports ${entry.path}`),
)
const files = readdirSync(join(root, "dist")).sort()
if (JSON.stringify(files) !== JSON.stringify(["index.js"])) problems.push(`dist/ must hold exactly index.js, found ${files.join(", ")}`)
if (problems.length) {
  console.error(`build: the bundle is not self-contained:\n  ${problems.join("\n  ")}`)
  process.exit(1)
}
console.log("build: dist/index.js is self-contained.")
