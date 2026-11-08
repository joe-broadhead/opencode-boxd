// Fails when a forbidden API, legacy surface, private host reference or machine-local path appears
// in src/, test/, scripts/ or dist/. The list is the "Forbidden in this repository" list in AGENTS.md. APIs that the
// public @opencode/plugin 2.2.3 types already reject fail the typecheck instead.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { extname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const self = fileURLToPath(import.meta.url)
const ROOTS = ["src", "test", "scripts", "dist"]
const MEMBER = String.raw`\s*(?:\?\.|\.)\s*`
const PERMISSION_HOOK = new RegExp(String.raw`\bpermission${MEMBER}hook\b`)
/** The copy of the module shared by several plugins, and the bundle that inlines it. */
const TOOLS_RPC = ["src/host/tools-rpc.ts", "dist/index.js"]
/** The guest's own absolute paths, inside the machine: the only absolute paths this plugin may write down. */
const GUEST_PATH = /\/(?:home\/boxd|tmp\/opencode-boxd)(?:\/|(?=["'`\s)\],]))/g

const RULES = [
  { id: "fork-marker", pattern: /dispatch[-_ ]?lease|catalog[-_ ]?ownership|text[-_ ]?only[-_ ]?respons/i, why: "dispatch-lease, ownership and text-only markers are fork-only" },
  { id: "tool-options-mcp", pattern: new RegExp(String.raw`\boptions${MEMBER}mcp\b|\boptions\s*:\s*\{\s*mcp\s*:|\boptions\b[^\n;,]{0,80}\)${MEMBER}mcp\b`), why: "tool options.mcp delegation is fork-only" },
  { id: "plugin-image", pattern: new RegExp(String.raw`\bPlugin${MEMBER}image\b|\bPROFILE_IMAGE\b|profile[-_]?image|profile\.png`, "i"), why: "Plugin.image and profile images were dropped" },
  { id: "imported-oauth", pattern: /\bimported[-_]?(?:gh[-_]?)?oauth\b|\bimportedOAuth\b/i, why: "imported OAuth grants are not allowed" },
  { id: "v1-plugin-api", pattern: /@opencode-ai\//, why: "@opencode-ai/* is the V1 plugin API" },
  { id: "v1-hook", pattern: /["'`](?:tool\.execute\.(?:before|after)|chat\.(?:message|params)|permission\.ask)["'`]/, why: "V1 plugin hooks are not allowed" },
  { id: "generate-text", pattern: new RegExp(String.raw`\bgenerate${MEMBER}text\b`), why: "ctx.generate.text is deprecated" },
  { id: "experimental-policies", pattern: new RegExp(String.raw`\bexperimental${MEMBER}policies\b`), why: "experimental.policies is deprecated" },
  { id: "opencode-ai-import", pattern: /["'`]@opencode\/ai(?:\/[^"'`]*)?["'`]/, why: "@opencode/ai breaks between patch releases; import only @opencode/plugin" },
  // The tools RPC's evaluate hook only turns an ask on one of its own script calls in flight into a deny, because no one
  // can answer it. It is allowed there, and in the bundle that inlines it, exactly once (counted below).
  { id: "permission-hook", pattern: PERMISSION_HOOK, why: "no escalating permission hook; default rules go through ctx.agent.transform", except: TOOLS_RPC },
  { id: "host-source", pattern: /packages\/(?:core|plugin|schema)\/src\b|opencode-[\w-]*-host\b|\bconsumer-host\b/, why: "never reference or import private host source or host checkouts" },
  // R9: a shipped doc or comment states behaviour, not who decided it. Lane names always contain "lane".
  { id: "internal-wording", pattern: /owner'?s? (?:decision|ruling)|\bthe lead'?s?\b|hey-jelly #|\blanes?\b/i, why: "internal wording (an owner decision, a lead, a lane) does not belong in a shipped doc or comment" },
  { id: "absolute-path", pattern: /\/Users\/[^/\s"'`]+\/|\/home\/[^/\s"'`]+\/|\/(?:private\/)?var\/folders\/|(?<![\w.:/-])\/tmp\/|[A-Za-z]:\\\\?Users\\/, why: "machine-local home and temp paths do not belong in the repository; make temp folders with mkdtemp under realpathSync(\"/tmp\"), or use a relative path" },
]

const findings = []
for (const top of ROOTS) {
  const dir = join(root, top)
  if (!existsSync(dir)) continue
  for (const file of walk(dir)) {
    if (file === self) continue
    const path = relative(root, file).split(sep).join("/")
    if (top === "dist" && [".tsx", ".jsx"].includes(extname(file))) findings.push({ path, line: 0, id: "dist-jsx-source", why: "no .tsx or .jsx ships; the TUI is prebuilt" })
    const buffer = readFileSync(file)
    if (buffer.includes(0)) continue
    const lines = buffer.toString("utf8").split(/\r?\n/)
    if (TOOLS_RPC.includes(path)) {
      const hooks = lines.filter((text) => PERMISSION_HOOK.test(text)).length
      if (hooks !== 1) findings.push({ path, line: 0, id: "permission-hook", why: `the tools RPC must have exactly one permission hook, found ${hooks}` })
    }
    for (const rule of RULES) {
      if (rule.except?.includes(path)) continue
      lines.forEach((text, index) => {
        // A guest path is absolute by design: it names a path inside the boxd machine, not on this laptop.
        const subject = rule.id === "absolute-path" ? text.replace(GUEST_PATH, "/guest/") : text
        if (rule.pattern.test(subject)) findings.push({ path, line: index + 1, id: rule.id, why: rule.why, text })
      })
    }
  }
}

for (const { path, line, id, why, text } of findings) {
  console.error(`${path}${line ? `:${line}` : ""}: [${id}] ${why}${text ? `\n    ${text.trim().slice(0, 160)}` : ""}`)
}
if (findings.length) {
  console.error(`\n${findings.length} forbidden reference(s) found. Remove them; see the forbidden list in AGENTS.md.`)
  process.exit(1)
}
console.log(`No forbidden references in ${ROOTS.filter((top) => existsSync(join(root, top))).join(", ")}.`)

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile()) yield path
  }
}
