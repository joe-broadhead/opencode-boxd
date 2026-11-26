// The release tarball ships NOTICE next to a bundle that inlines third-party code. This test builds the server entry
// with the same externals as scripts/build.mjs, collects the packages that actually end up in the bundle (including
// packages inlined by a bundled dist, such as zod inside plugin-contract), and requires a NOTICE section for each:
// a `## <name> <version> (<SPDX licence>)` heading and the package's own LICENSE text verbatim.
import { describe, expect, test } from "bun:test"
import { build } from "esbuild"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
// The same externals as scripts/build.mjs: the host provides these, so they are not redistributed.
const HOST = ["@opencode/plugin", "@opencode/plugin/*", "@opentui/*", "solid-js", "solid-js/*"]
const PLUGIN = "@we-the-rebel-alliance/boxd-plugin"

/** A package name from an esbuild input path, or undefined for the plugin's own sources. */
function packageOf(path: string): string | undefined {
  const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path)
  return match?.[1]
}

function keep(name: string | undefined): name is string {
  return name !== undefined && name !== PLUGIN && !name.startsWith("@opencode/") && !name.startsWith(".")
}

interface Bundled {
  readonly name: string
  readonly version: string
  readonly license: string
  readonly text: string
}

function metaOf(name: string): Bundled {
  const dir = join(root, "node_modules", name)
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string; license: string }
  const text = readFileSync(join(dir, "LICENSE"), "utf8").trim()
  return { name, version: pkg.version, license: pkg.license, text }
}

/** Every package esbuild actually inlines into the server bundle, with its version, SPDX licence and licence text. */
async function bundledPackages(): Promise<Bundled[]> {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/index.ts"],
    bundle: true,
    splitting: false,
    write: false,
    format: "esm",
    platform: "node",
    target: "es2023",
    external: HOST,
    legalComments: "none",
    metafile: true,
    logLevel: "silent",
  })
  // plugin-contract is inlined by every plugin, whatever the metafile lists: the bundle imports its runtime modules.
  const found = new Set<string>(["@we-the-rebel-alliance/plugin-contract"])
  const inputs = Object.keys(result.metafile.inputs)
  for (const path of inputs) {
    const name = packageOf(path)
    if (keep(name)) found.add(name)
  }
  // plugin-contract's dist carries zod pre-bundled, so zod has no node_modules input of its own. Detect its code in
  // the bundle (`$ZodType`/`ZodError` definitions), never a metafile name, and require its notice when present.
  const output = result.outputFiles?.map((file) => file.text).join("\n") ?? ""
  if (/\$ZodType|ZodError/.test(output)) found.add("zod")
  return [...found].sort().map(metaOf)
}

/** The packages a NOTICE does not carry correctly: heading, version, SPDX licence or verbatim licence text. */
export function missingNotices(notice: string, packages: readonly Bundled[]): string[] {
  return packages
    .filter((pkg) => {
      const heading = `## ${pkg.name} ${pkg.version} (${pkg.license})`
      return !notice.split("\n").includes(heading) || !notice.includes(pkg.text)
    })
    .map((pkg) => pkg.name)
}

describe("the bundled third-party notices", () => {
  test("every bundled package has its heading and verbatim licence in NOTICE", async () => {
    const packages = await bundledPackages()
    expect(packages.map((pkg) => pkg.name)).toEqual(["@we-the-rebel-alliance/plugin-contract", "yaml", "zod"])
    expect(packages.map((pkg) => `${pkg.version} ${pkg.license}`)).toEqual(["0.0.0 MIT", "2.9.1 ISC", "4.6.7 MIT"])
    const notice = readFileSync(join(root, "NOTICE"), "utf8")
    expect(missingNotices(notice, packages)).toEqual([])
  })

  test("a missing heading or licence text is reported", async () => {
    const packages = await bundledPackages()
    const notice = readFileSync(join(root, "NOTICE"), "utf8")
    const withoutYaml = notice.replace(/^## yaml[\s\S]*?(?=^## |\s*$)/m, "")
    expect(missingNotices(withoutYaml, packages)).toContain("yaml")
    const withoutZodText = notice.replace(packages.find((pkg) => pkg.name === "zod")!.text, "")
    expect(missingNotices(withoutZodText, packages)).toContain("zod")
  })
})
