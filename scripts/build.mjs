// Bundles the server entry the host loads into one self-contained file: src/index.ts to dist/index.js. Shared code is
// inlined; there are no chunks and no relative imports, because OpenCode reloads a plugin in place and reuses the module
// records it already holds for unchanged paths. Only the modules the host provides stay external. The build fails if an
// output imports anything else. The bundle's whitespace and syntax are minified, never its names, so a stack trace still
// names each function.
import { build } from "esbuild"
import { readdirSync, rmSync } from "node:fs"
import { isBuiltin } from "node:module"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const HOST = ["@opencode/plugin", "@opencode/plugin/*", "@opentui/*", "solid-js", "solid-js/*"]
const provided = (path) => path.startsWith("node:") || isBuiltin(path) || HOST.some((name) => (name.endsWith("/*") ? path.startsWith(name.slice(0, -1)) : path === name))

/** The yaml parser's ISC notice, carried in the bundle banner and in NOTICE. */
const YAML_LICENSE = `Copyright Eemeli Aro <eemeli@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.`

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
  // The YAML parser is CommonJS and reads `process` with require(); the bundle is ESM, so give it a real require.
  // The ISC notice travels in the banner because `legalComments: "none"` strips the parser's own comments.
  banner: {
    js: `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n/*\n${YAML_LICENSE}\n*/`,
  },
})

const problems = Object.entries(result.metafile.outputs).flatMap(([file, output]) =>
  output.imports.filter((entry) => !entry.external || !provided(entry.path)).map((entry) => `${file} imports ${entry.path}`),
)
const files = readdirSync(join(root, "dist")).sort()
if (JSON.stringify(files) !== JSON.stringify(["index.js"])) problems.push(`dist/ must hold exactly index.js, found ${files.join(", ")}`)
if (problems.length) {
  console.error(`bundle: the bundle is not self-contained:\n  ${problems.join("\n  ")}`)
  process.exit(1)
}
console.log("bundle: dist/index.js is self-contained.")
