// The tools RPC module is shared by several plugins: identical outside its PLUGIN-SPECIFIC block. This fails when this
// repository's copy drifted from the pin every plugin carries, so a one-plugin edit cannot break the hand-over.
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

/** The v2 shared-part hash, as hey-jelly computes it. */
const PIN = "15d82caa53aaae7ad9efb88dddb97056d3895c4dbf49b8efbb85b743871b2a6d"
const START = "// >>> PLUGIN-SPECIFIC >>>"
const END = "// <<< PLUGIN-SPECIFIC <<<"

/** The module minus its plugin block: what every plugin shares, byte for byte. */
export function sharedPart(text) {
  const start = text.indexOf(START)
  const end = text.indexOf(END)
  if (start === -1 || end === -1) throw new Error("the tools RPC module has no PLUGIN-SPECIFIC block")
  return `${text.slice(0, start)}${text.slice(end + END.length)}`
}

const files = process.argv.slice(2)
if (files.length === 0) files.push(fileURLToPath(new URL("../src/host/tools-rpc.ts", import.meta.url)))
let failed = false
for (const file of files) {
  const hash = createHash("sha256").update(sharedPart(readFileSync(file, "utf8"))).digest("hex")
  if (hash === PIN) {
    console.log(`same: ${file}`)
  } else {
    console.error(`different: ${file} has shared-part hash ${hash}, the pin is ${PIN}`)
    failed = true
  }
}
process.exit(failed ? 1 : 0)
