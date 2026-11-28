/**
 * A repository's warm image (feature #58): the snapshot a work with that repository starts from, so its checkout,
 * toolchain and dependencies are already on the machine. This is the one definition of its name. The builder (#73)
 * uses the same name and imports this definition once it lands; a repository whose URL is written with or without
 * `.git` has one name, because `repositoryHash` and `repositorySlug` normalise it first.
 *
 * The name is `<goldenPrefix>-<repository slug>-<8 hex of the URL's hash>-<opencode version>-<size>`, cut to boxd's 64
 * characters, so a snapshot listing alone says which repository, version and size an image serves.
 */
import { boxdError } from "../errors.js"
import { assertSnapshot, repositoryHash, repositorySlug } from "../names.js"
import { SIZES, type Size } from "../ports.js"

/** boxd's longest snapshot name. */
const NAME_MAX = 64

/**
 * The warm image for the repository at `url`, this OpenCode version and size. A long repository name is cut so the hash,
 * version and size stay whole, and `parseWarmImageName` reads it back.
 */
export function warmImageName(prefix: string, url: string, version: string | null, size: Size): string {
  if (version === null) throw boxdError("GOLDEN_MISSING", "The OpenCode here reports no version, so no warm image can be named for it.")
  const suffix = `-${repositoryHash(url)}-${version}-${size}`
  const room = NAME_MAX - prefix.length - 1 - suffix.length
  if (room < 1) throw boxdError("NAME_INVALID", `A warm image name for ${url} does not fit boxd's 64 characters; shorten the option "goldenPrefix".`)
  return assertSnapshot(`${prefix}-${repositorySlug(url).slice(0, room)}${suffix}`)
}

export interface WarmImageName {
  /** The repository's slug as the name carries it, cut when the whole name reached 64 characters, and its URL's key. */
  readonly repo: { readonly name: string; readonly hash: string }
  readonly opencode: string
  readonly size: Size
}

/** What a warm image's name says, or undefined for any other snapshot name (a golden image included). */
export function parseWarmImageName(prefix: string, name: string): WarmImageName | undefined {
  if (!name.startsWith(`${prefix}-`)) return undefined
  const match = /^(.+)-([0-9a-f]{8})-(\d+\.\d+\.\d+)-(\d+x\d+)$/.exec(name.slice(prefix.length + 1))
  if (!match || !(SIZES as readonly string[]).includes(match[4]!)) return undefined
  return { repo: { name: match[1]!, hash: match[2]! }, opencode: match[3]!, size: match[4] as Size }
}

/** True for a repository's warm image, whatever the repository: a golden image is never one. */
export function isWarmImage(prefix: string, name: string): boolean {
  return parseWarmImageName(prefix, name) !== undefined
}
