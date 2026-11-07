import { rmSync } from "node:fs"
import { build } from "esbuild"

rmSync("dist", { recursive: true, force: true })

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  target: "node22",
})
