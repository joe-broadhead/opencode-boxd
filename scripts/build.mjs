// Bundles each entry the host loads into one self-contained file: src/index.ts to dist/index.js (the server part) and
// src/tui.ts to dist/tui.js (the terminal UI part). Shared code, such as the status model and the RPC contract, is
// inlined into both. No chunks and no relative imports, because OpenCode reloads a plugin in place and reuses the
// module records it already holds for unchanged paths: a new entry must never import an older sibling module.
// Only the modules the host provides stay external. The build fails if an output imports anything else. The server
// part, dist/index.js, is minified (whitespace and syntax, not names): with the source contract's modules bundled into
// it the package stays within its size budget, and a stack trace still names each function. The TUI part, dist/tui.js,
// is not: OpenCode rewrites a TUI plugin's host imports (`from "solid-js"`) by a pattern that needs the space a minified
// bundle drops, so the build fails if dist/tui.js is minified.
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

// A minified bundle writes its imports without spaces (`import{a}from"x"`, `import*as b from"y"`). The TUI part must keep
// them plain. The family's guard is /\bfrom"|\bimport[{*]/; its bare `from"` also matches the string "from" (an input
// field of boxd_exec's schema), so here it is anchored on the `}` a minified import list closes with.
const MINIFIED_IMPORT = /\}from"|\bimport[{*]/

rmSync(join(root, "dist"), { recursive: true, force: true })
const common = {
  absWorkingDir: root,
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
}
const server = await build({ ...common, entryPoints: { index: "src/index.ts" }, minifyWhitespace: true, minifySyntax: true })
const tui = await build({ ...common, entryPoints: { tui: "src/tui.ts" } })
const outputs = { ...server.metafile.outputs, ...tui.metafile.outputs }

const problems = Object.entries(outputs).flatMap(([file, output]) =>
  output.imports.filter((entry) => !entry.external || !provided(entry.path)).map((entry) => `${file} imports ${entry.path}`),
)
const files = readdirSync(join(root, "dist")).sort()
if (JSON.stringify(files) !== JSON.stringify(["index.js", "tui.js"])) problems.push(`dist/ must hold exactly index.js and tui.js, found ${files.join(", ")}`)
else if (MINIFIED_IMPORT.test(readFileSync(join(root, "dist", "tui.js"), "utf8"))) problems.push("dist/tui.js is minified: OpenCode cannot rewrite its host imports, so bundle the TUI part unminified")
if (problems.length) {
  console.error(`build: the bundles are not self-contained:\n  ${problems.join("\n  ")}`)
  process.exit(1)
}
console.log("build: dist/index.js and dist/tui.js are self-contained.")
