// Text from OpenCode, boxd or the network, made safe to show in status, the dialog, the status RPC and the session.
// No imports: status.ts, which the terminal UI bundle inlines, uses it too.

/**
 * Token shapes: bearer and basic values,
 * `key=value` secrets, JWTs, vendor-prefixed keys, and any long run of key characters; then email addresses and the
 * owner's name in a home folder (macOS, Linux or Windows), which becomes `~`.
 */
const SECRETS: readonly [RegExp, string][] = [
  [/\b(bearer|basic|token)\s+[\w.~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b([\w-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|signature|credential)["']?\s*[:=]\s*)["']?[^\s"'&,;]+["']?/gi, "$1[redacted]"],
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g, "[redacted]"],
  [/\b(?:tvly|sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abposr]|lin_api|lin_oauth)[-_][\w-]{8,}/gi, "[redacted]"],
  [/[\w+=-]{40,}/g, "[redacted]"],
  // An email address names a person, and a home folder names its owner: neither belongs on a status surface.
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[email]"],
  [/(?:\/(?:Users|home)\/|[A-Za-z]:\\Users\\)[^\s/\\"'`]+/g, "~"],
]

const REASON_LIMIT = 160

/** C0 and C1 controls and DEL: a line break or escape sequence must not reach a terminal or the session. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]+/g
/** Bidi marks, embeddings, overrides and isolates: a name must not reorder the row it is shown in. */
const BIDI = /[‎‏‪-‮⁦-⁩]/g

/** A URL in text keeps its scheme, host and path: its `user:password@`, query and fragment go. */
const withoutUrlSecrets = (text: string) =>
  text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => url.replace(/^(https?:\/\/)[^/?#@]*@/i, "$1").replace(/[?#].*$/s, ""))

/** One line with no controls or bidi characters, whitespace collapsed. */
export const oneLine = (text: string) => text.replace(BIDI, "").replace(CONTROLS, " ").replace(/\s+/g, " ").trim()

/** At most `limit` characters, cut between whole characters (never inside a surrogate pair), ending in `…` when cut. */
export function cut(text: string, limit: number) {
  const characters = Array.from(text)
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : text
}

/**
 * Host or network text as a short reason: one line, URLs without credentials, query or fragment, token shapes
 * redacted, and at most 160 characters, cut between whole characters. Undefined when nothing is left.
 */
export function shortReason(text: string): string | undefined {
  const reason = redactedLine(text).replace(/[.\s]+$/, "")
  if (reason === "") return undefined
  return cut(reason, REASON_LIMIT)
}

/**
 * Text a guest session wrote, such as its last message, made safe in the same way and cut to `limit` characters. Its
 * closing punctuation stays. Undefined when nothing is left.
 */
export function excerpt(text: string, limit: number): string | undefined {
  const line = redactedLine(text)
  return line === "" ? undefined : cut(line, limit)
}

/** Controls but line breaks and tabs, for text that keeps its lines. */
const BLOCK_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g

/**
 * Many lines of guest output, such as a command's stdout, made safe the same way as `shortReason`, line by line: token
 * shapes redacted, URLs without credentials, no controls or bidi characters. Its lines stay; nothing is cut.
 */
export const redactBlock = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => SECRETS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), withoutUrlSecrets(line)).replace(BIDI, "").replace(BLOCK_CONTROLS, ""))
    .join("\n")

/**
 * Text a guest session wrote, kept line by line: token shapes redacted, URLs without credentials, no controls, and cut
 * to `limit` characters between whole characters. Its line breaks stay, so a report's tables and lists do; undefined
 * when nothing is left.
 */
export function excerptBlock(text: string, limit: number): string | undefined {
  const block = redactBlock(text)
  return block === "" ? undefined : cut(block, limit)
}

const redactedLine = (text: string) => oneLine(SECRETS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), withoutUrlSecrets(text)))

/** An error's message, or the value itself, as a short reason; `fallback` when nothing is left. */
export const reasonOf = (error: unknown, fallback = "no reason given") =>
  shortReason(error instanceof Error ? error.message : String(error)) ?? fallback
