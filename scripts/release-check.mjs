import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const heading = new RegExp(`^#{1,3}\\s+\\[?v?${escapeRegExp(version)}\\]?(?=\\s|$)`, "m")
if (heading.test(readFileSync(join(root, "CHANGELOG.md"), "utf8"))) {
  console.log(`release-check: OK, CHANGELOG.md has a section for ${version}`)
} else {
  console.error(`release-check: CHANGELOG.md has no section for ${version}.`)
  process.exitCode = 1
}
