// Bundles each entry the host loads into one self-contained file: src/index.ts to dist/index.js (the server part) and
// src/tui.ts to dist/tui.js (the terminal UI part). Shared code, such as the status model and the RPC contract, is
// inlined into both. No chunks and no relative imports, because OpenCode reloads a plugin in place and reuses the
// module records it already holds for unchanged paths: a new entry must never import an older sibling module.
// Only the modules the host provides stay external. The build fails if an output imports anything else.
import { build } from "esbuild"
import { readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const HOST = ["@opencode/plugin", "@opencode/plugin/*", "@opentui/*", "solid-js", "solid-js/*"]
const provided = (path) => path.startsWith("node:") || HOST.some((name) => (name.endsWith("/*") ? path.startsWith(name.slice(0, -1)) : path === name))

/** The plugin's version, from package.json, as one string: the bundles carry nothing else of package.json. */
const version = {
  name: "version",
  setup(editor) {
    editor.onLoad({ filter: /[\\/]src[\\/]version\.ts$/ }, () => {
      const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
      return { contents: `export const VERSION = ${JSON.stringify(version)}`, loader: "ts" }
    })
  },
}

rmSync(join(root, "dist"), { recursive: true, force: true })
const result = await build({
  absWorkingDir: root,
  entryPoints: { index: "src/index.ts", tui: "src/tui.ts" },
  outdir: "dist",
  bundle: true,
  splitting: false,
  format: "esm",
  platform: "node",
  target: "es2023",
  external: HOST,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
  plugins: [version],
})

const problems = Object.entries(result.metafile.outputs).flatMap(([file, output]) =>
  output.imports.filter((entry) => !entry.external || !provided(entry.path)).map((entry) => `${file} imports ${entry.path}`),
)
const files = readdirSync(join(root, "dist")).sort()
if (JSON.stringify(files) !== JSON.stringify(["index.js", "tui.js"])) problems.push(`dist/ must hold exactly index.js and tui.js, found ${files.join(", ")}`)
if (problems.length) {
  console.error(`build: the bundles are not self-contained:\n  ${problems.join("\n  ")}`)
  process.exit(1)
}
console.log("build: dist/index.js and dist/tui.js are self-contained.")
