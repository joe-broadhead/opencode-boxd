// The one local entry point: `npm run check` runs every stage in order and stops at the first failure.
// `node scripts/check.mjs <stage>...` runs only the named stages, in the order given.
import { spawnSync } from "node:child_process"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const env = { ...process.env, PATH: `${join(root, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}` }

const stages = {
  typecheck: () => run("tsc", ["--noEmit", "-p", "tsconfig.json"]),
  bundle: () => run("npm", ["run", "bundle"]),
  unit: () => run("bun", ["test", "./test/unit"]),
  // The contract's whole gate: T0, the declaration, the recordings, T1 on the real 2.4.1 host, docs drift, forbidden
  // patterns and the bundled-kit check.
  conformance: () => run("bun", ["test", "./test/conformance"]),
  host: () => run("bun", ["test", "./test/host"]),
  pack: () => run("bun", ["test", "./test/pack"]),
  actionlint: () => {
    const probe = spawnSync("actionlint", ["-version"], { encoding: "utf8" })
    if (probe.error?.code === "ENOENT") {
      console.log("[check] actionlint: not installed; skipped (install it to lint the workflows)")
      return 0
    }
    return run("actionlint", [".github/workflows/ci.yml", ".github/workflows/release.yml"])
  },
  // Last, so a red gate still runs every other stage and the report shows what passed.
  kit: () => run("plugin-kit", ["check"]),
}

const selected = process.argv.slice(2)
const unknown = selected.filter((name) => !Object.hasOwn(stages, name))
if (unknown.length) {
  console.error(`check: unknown stage ${unknown.map((name) => `"${name}"`).join(", ")}. Stages: ${Object.keys(stages).join(", ")}.`)
  process.exit(2)
}
const order = selected.length ? selected : Object.keys(stages)
for (const name of order) {
  console.log(`\n[check] ${name}`)
  const code = stages[name]()
  if (code !== 0) {
    console.error(`\n[check] FAILED at stage "${name}". Fix it, then rerun: node scripts/check.mjs ${name}`)
    process.exit(code || 1)
  }
}
console.log(`\n[check] passed: ${order.join(", ")}`)

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" })
  if (result.error?.code === "ENOENT") {
    console.error(`${command} was not found. Run npm ci first; install Bun from https://bun.sh if bun is missing.`)
    return 127
  }
  if (result.error) throw result.error
  return result.status ?? 1
}
