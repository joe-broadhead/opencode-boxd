/**
 * How a failed boxd CLI call is read (design §5): one table, an exact pattern per case, each pinned by a fixture in
 * `test/unit/boxd-errors.test.ts`. Only an exact not-found answer for the name and the region that were asked makes
 * `missing`; a not-found answer with the CLI's hint that the name exists in another region is `elsewhere`; anything
 * the table does not know is `unknown`, which is `BOXD_FAILED` and never `missing` (F4). Even `missing` is a fact about
 * one region at one moment: the decision "gone" belongs to drop's two-check rule (§3.9).
 */
import { boxdError, type BoxdError, type Code } from "../../errors.js"
import { REGIONS, type BoxdFailureKind, type Region } from "../../ports.js"
import { shortReason } from "../../redact.js"

/** What a call asked about: the machine name or id, and the region it passed. */
export interface Asked {
  readonly machine?: string
  readonly region?: Region
}

export interface Classified {
  readonly kind: BoxdFailureKind
  /** For `elsewhere`: the region the CLI's hint names. */
  readonly region?: Region
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const REGION = `(${REGIONS.join("|")})`

/**
 * The patterns, in the order they are tried. Each one is the CLI's own words; a pattern that needs the machine or the
 * region is built for the call.
 */
const FIXED: ReadonlyArray<{ readonly kind: Exclude<BoxdFailureKind, "missing" | "elsewhere" | "unknown">; readonly pattern: RegExp }> = [
  // The laptop CLI starts a browser sign-in and waits when no one is signed in; that wait is cut by the timeout.
  { kind: "auth", pattern: /^Not logged in\b|\bnot signed in\b|\brun `?boxd auth login`?|^error: (?:unauthori[sz]ed|authentication required)\b|\bAPI key (?:is )?(?:invalid|expired|revoked)\b/im },
  // #14 §6: a machine whose VM agent never came back after a resize.
  { kind: "agent-silent", pattern: /\bcannot connect to VM agent\b/i },
  // --vcpu or --memory with --from-snapshot: a restore keeps its snapshot's size (F11). The CLI 0.3.5 binary's own
  // words; provisional until live check L2 captures the whole answer.
  { kind: "size-on-restore", pattern: /--vcpu\/--memory only apply to fresh machines|snapshot restores keep their source's size/i },
  // The org's quota does not allow the size asked for.
  { kind: "quota", pattern: /\b(?:exceeds|above|over) (?:your |the )?org(?:anization|anisation)?'?s? (?:size |machine size )?quota\b|\bsize (?:is )?not allowed by (?:your |the )?org/i },
  // No room for another machine (live check L5 pins the exact words).
  {
    kind: "limit",
    pattern: /\breached (?:its|your|the) (?:org(?:anization|anisation)?'?s? )?machine limit\b|\bmachine limit (?:of \d+ )?(?:reached|exceeded)\b|\bmachine-limit request --max-vms\b/i,
  },
]

/** Reads one failed call's stderr (and stdout, which the sign-in prompt uses) for the machine and region it asked. */
export function classify(output: string, asked: Asked = {}): Classified {
  for (const { kind, pattern } of FIXED) if (pattern.test(output)) return { kind }
  if (asked.machine) {
    const name = escape(asked.machine)
    // 0.3: `error: no machine "<name>" in <region>`, optionally followed by the hint for a name in another region.
    const notFound = new RegExp(`^error: no machine "${name}" in ${REGION}\\b`, "m").exec(output)
    if (notFound) {
      const hint = new RegExp(`\\bThere is a machine[^\\n]*\\bin ${REGION}\\b`, "i").exec(output)
      if (hint && hint[1] !== notFound[1]) return { kind: "elsewhere", region: hint[1] as Region }
      // An answer about another region than the one asked is not a fact about the asked region.
      if (asked.region && notFound[1] !== asked.region) return { kind: "unknown" }
      return { kind: "missing" }
    }
    // 0.2: `error: VM '<name>' not found`, which named no region.
    if (new RegExp(`^error: VM '${name}' not found\\s*$`, "m").test(output)) return { kind: "missing" }
  }
  return { kind: "unknown" }
}

/** The code each kind is answered with. `missing` and `elsewhere` are facts for the caller, so they stay `BOXD_FAILED`. */
const CODE: Readonly<Record<BoxdFailureKind, Code>> = {
  missing: "BOXD_FAILED",
  elsewhere: "BOXD_FAILED",
  limit: "MACHINE_LIMIT",
  "agent-silent": "AGENT_UNREACHABLE",
  quota: "SIZE_UNAVAILABLE",
  auth: "BOXD_MISSING",
  "size-on-restore": "BOXD_FAILED",
  unknown: "BOXD_FAILED",
}

/**
 * The coded error for a failed call, with `details.kind` (and `details.region` for `elsewhere`) for the caller. The
 * CLI's words reach the message only as one redacted line.
 */
export function failure(command: string, output: string, asked: Asked = {}): BoxdError {
  const classified = classify(output, asked)
  const words = shortReason(lastError(output)) ?? "no output"
  const subject = asked.machine ? `${asked.machine}${asked.region ? ` in ${asked.region}` : ""}` : undefined
  const message =
    classified.kind === "missing"
      ? `boxd found no machine ${subject} (${words}).`
      : classified.kind === "elsewhere"
        ? `boxd found no machine ${subject}, and says one by that name is in ${classified.region} (${words}).`
        : `${command} failed (${words}).`
  return boxdError(CODE[classified.kind], message, {
    kind: classified.kind,
    ...(classified.region ? { region: classified.region } : {}),
  })
}

/** The CLI's error line: the first `error:` line, or the last line it printed. */
function lastError(output: string): string {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean)
  return lines.find((line) => /^error:/i.test(line)) ?? lines.at(-1) ?? ""
}
