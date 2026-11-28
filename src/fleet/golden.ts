/**
 * Golden images (design §2.3, §3.11), owned by package C1: `<prefix>-<opencode version>-<size>` in each region the
 * option `regions` allows, built by the plugin from a fixed recipe on a short-lived builder machine, never saved from a
 * work's machine. `boxd_golden` never builds in a region outside the allowlist, and a build request there is refused; a
 * prune deletes images, so it is not pinned and covers every region. A resume of a work that landed in another region
 * may rebuild that work's image there as part of recovery (see `resume.ts`), not as new placement.
 *
 * A repository's warm image is `<prefix>-<repository>-<hash>-<opencode version>-<size>`, where the hash is the first 8
 * hex of the repository URL's SHA-256. Its recipe starts from the version's image in the region, builds that first when
 * it is missing, runs the helper's `warm` to clone the repository into its own folder, runs the repository's `setup`
 * script inside that checkout when one is set, then the scrub, the snapshot and the builder's removal.
 *
 * The version recipe, one build per region and size at a time (a flight every caller joins):
 *
 * 1. `machine new oc-gb-<region>-<size>-<rand>` with `--delete-after 2h` and `role=golden-builder`, from stock at the
 *    size, or from a base snapshot in that region, resized after the restore when its size differs.
 * 2. The helper's `upgrade` to this laptop's OpenCode (a change: it installs the v1 helper first), then the user's
 *    `goldenSetup` script, when one is set, copied up and run once.
 * 3. The helper's `scrub`: it refuses a base with work slots (`GOLDEN_HAS_SLOT`), `auth.json`
 *    (`GOLDEN_HAS_CREDENTIAL`) or an OpenCode session
 *    (`GOLDEN_BUILD_FAILED`), then stops the server and removes the env file, the password, the exports and the work
 *    folders, keeping warm checkouts.
 * 4. `snapshots save` under the image's name, then the builder is removed (its timer removes it if the laptop goes).
 *
 * A build runs apart from the calls that wait for it: a call that reaches its bound `B` stops waiting and the build
 * goes on for the next call to join. A Stop detaches its own call, and stops the build only when no other call waits.
 */
import { randomBytes } from "node:crypto"
import { BoxdError, boxdError } from "../errors.js"
import { assertSnapshot, normaliseRepo } from "../names.js"
import { resolveLaptopPath, rootsOf } from "../paths.js"
import type { WarmRepository } from "../options.js"
import { shortReason } from "../redact.js"
import {
  REGIONS,
  SIZES,
  TIMEOUTS,
  type ChangeTarget,
  type MachineId,
  type MachineName,
  type OpContext,
  type Region,
  type SecretInfo,
  type Size,
  type SnapshotRow,
} from "../ports.js"
import type { GoldenImage, GoldenResult } from "../results.js"
import type { FleetServices } from "../services.js"
import type { CallContext } from "../call.js"
import { runOne, type ItemContext } from "./list.js"
import { regionsText } from "./regions.js"
import { parseWarmImageName, warmImageName } from "./warm.js"

/** Where `goldenSetup` lands on the builder, in boxd's home; it is removed by the same exec that runs it. */
const SETUP_FILE = ".boxd-plugin-golden-setup.sh"
const SETUP_PATH = `/home/boxd/${SETUP_FILE}`
/** Where a warm image's repository setup lands; it is run inside the warm checkout, then removed. */
const WARM_SETUP_FILE = ".boxd-plugin-warm-setup.sh"
const WARM_SETUP_PATH = `/home/boxd/${WARM_SETUP_FILE}`
/** The builder's safety net, whatever happens to the laptop. */
const BUILDER_LEASE = "2h"

/**
 * The environment names OpenCode reads as a model provider's key. A sealed secret with one of these names is the
 * recommended way to give works a key (design §2.3); a build without any warns `NO_MODEL_CREDENTIAL`.
 */
const PROVIDER_KEY = /^[A-Z][A-Z0-9_]*_API_KEY$|^AWS_(?:ACCESS_KEY_ID|BEARER_TOKEN_BEDROCK)$|^GOOGLE_APPLICATION_CREDENTIALS$|^GITHUB_COPILOT_TOKEN$/

export const hasProviderKey = (secrets: readonly SecretInfo[]) => secrets.some((secret) => PROVIDER_KEY.test(secret.name))

/** The one image a work of this size in any region is made from, for this laptop's OpenCode. */
export function imageName(prefix: string, version: string | null, size: Size): string {
  if (version === null) throw boxdError("GOLDEN_MISSING", "The OpenCode here reports no version, so no golden image can be named for it.")
  return assertSnapshot(`${prefix}-${version}-${size}`)
}

/** What an image's name carries: its OpenCode version and size, and for a warm image its repository. */
export interface ParsedImageName {
  readonly opencode: string
  readonly size: Size
  /** A repository's warm image: the repository's slug, and the first 8 hex of its URL's SHA-256. */
  readonly repo?: { readonly name: string; readonly hash: string }
}

/** The version and size a golden image's name carries, and the repository of a warm image, or undefined for another snapshot. */
export function parseImageName(prefix: string, name: string): ParsedImageName | undefined {
  const warm = parseWarmImageName(prefix, name)
  if (warm) return warm
  if (!name.startsWith(`${prefix}-`)) return undefined
  const match = /^(\d+\.\d+\.\d+)-(\d+x\d+)$/.exec(name.slice(prefix.length + 1))
  if (!match || !(SIZES as readonly string[]).includes(match[2]!)) return undefined
  return { opencode: match[1]!, size: match[2] as Size }
}

/** A build that is still running when its caller's bound came. */
export const STILL_BUILDING = Symbol("still building")

interface Flight {
  readonly promise: Promise<GoldenImage>
  readonly controller: AbortController
  joiners: number
}

export interface Golden {
  /** The golden images for one region, from the snapshots listing (cached 5 minutes). */
  images(context: OpContext): Promise<readonly SnapshotRow[]>
  /**
   * Builds `name` in `region` at `size`, or joins the build already running. Answers the image, or `STILL_BUILDING`
   * once `until` passes; a Stop throws `CANCELLED` and stops the build when no other call waits for it.
   */
  build(input: BuildInput, wait: { readonly signal: AbortSignal; readonly until: number }): Promise<GoldenImage | typeof STILL_BUILDING>
  /** `boxd_golden`. */
  run(input: Record<string, unknown>, call: CallContext): Promise<GoldenResult>
}

export interface BuildInput {
  readonly region: Region
  readonly size: Size
  /** `stock`, a base snapshot, or the version image a warm build starts from. */
  readonly base: string
  readonly name: string
  /** Set for a repository's warm image: the checkout and setup the builder runs before the scrub. */
  readonly warm?: WarmRepository
}

export function createGolden(services: FleetServices, settings: { readonly bound?: () => number; readonly now?: () => number } = {}): Golden {
  const { boxd, guest, runner, options } = services
  const now = settings.now ?? Date.now
  const flights = new Map<string, Flight>()

  const images = (context: OpContext) => boxd.snapshots(context)

  /** Runs `step`; once, when boxd's VM agent does not answer on a machine the build made or resized, reboots and retries. */
  async function withAgent<T>(target: ChangeTarget, context: OpContext, step: () => Promise<T>): Promise<T> {
    try {
      return await step()
    } catch (error) {
      if (!(error instanceof BoxdError) || error.code !== "AGENT_UNREACHABLE") throw error
      await boxd.reboot(target, context)
      return step()
    }
  }

  /** A failure of one step, as the build's own refusal, unless it already says what to do. */
  function stepFailed(step: string, error: unknown): unknown {
    if (!(error instanceof BoxdError)) return error
    if (["CANCELLED", "GOLDEN_HAS_CREDENTIAL", "GOLDEN_HAS_SLOT", "GOLDEN_BUILD_FAILED", "GOLDEN_MISSING", "MACHINE_LIMIT", "SIZE_UNAVAILABLE", "BOXD_MISSING", "PATH_REFUSED", "NAME_INVALID"].includes(error.code)) return error
    return boxdError("GOLDEN_BUILD_FAILED", `The golden build failed at "${step}": ${error.what}`, { step })
  }

  async function recipe(region: Region, size: Size, base: string, name: string, context: OpContext, warm?: WarmRepository): Promise<GoldenImage> {
    const started = now()
    const version = services.hostVersion
    if (version === null) throw boxdError("GOLDEN_MISSING", "The OpenCode here reports no version, so no golden image can be built for it.")
    let step = "check the base"
    try {
      if (base !== "stock" && !(await images(context)).some((row) => row.region === region && row.name === base)) {
        throw boxdError("GOLDEN_BUILD_FAILED", `The base snapshot "${base}" is not in ${region}; snapshots do not cross regions. Build ${region} from "stock" with goldenSetup instead.`, { step })
      }
      const setupPath = warm?.setup ?? (warm ? undefined : options.goldenSetup)
      const script = setupPath ? await resolveLaptopPath(setupPath, rootsOf(services.projectDirectory, options.allowedRoots)) : undefined
      step = "create the builder"
      const builder = `oc-gb-${region}-${size}-${randomBytes(3).toString("hex")}` as const
      const created = await runner.withMachineLock({ create: { region, name: builder as MachineName } }, context, () =>
        boxd.create({ kind: "builder", region, name: builder, size, base: base === "stock" ? "stock" : { snapshot: base }, deleteAfter: BUILDER_LEASE }, context),
      )
      try {
        await runner.withMachineLock({ id: created.id }, context, async () => {
          // The builder's target is the id its own create answered.
          const target = created.owned.target
          if (base !== "stock") {
            step = "read the builder's size"
            const info = await boxd.get(region, created.id, context)
            if (info.size !== size) {
              step = "resize the builder"
              await boxd.resize(target, size, context)
            }
          }
          if (warm) {
            step = "warm the checkout"
            const checkout = await withAgent(target, context, () =>
              guest.warm(target, { repo: { url: warm.repo, ...(warm.ref ? { ref: warm.ref } : {}) } }, context),
            )
            if (script) {
              step = "run the repository's setup"
              await boxd.copyTo(target, script, WARM_SETUP_PATH, context)
              // The remote shell runs as boxd, whose $HOME is /home/boxd: the script runs inside the checkout, then is removed.
              // $HOME names the same checkout on a machine and on the test's disk, where the helper reports a guest path.
              const relative = checkout.path.slice("/home/boxd".length)
              const ran = await boxd.exec(target, `cd "$HOME${relative}" && sh "$HOME/${WARM_SETUP_FILE}"; code=$?; rm -f "$HOME/${WARM_SETUP_FILE}"; exit $code`, { timeoutSeconds: Math.floor((TIMEOUTS.goldenStep - TIMEOUTS.killGraceMs) / 1000), json: false }, context)
              if (ran.code !== 0) {
                const said = shortReason(ran.stderr.split("\n").filter((line) => line.trim()).at(-1) ?? "")
                throw boxdError("GOLDEN_BUILD_FAILED", `The setup for ${warm.repo} exited with ${ran.code}${said ? ` (${said})` : ""}.`, { step })
              }
            }
          } else {
            step = "upgrade OpenCode"
            await withAgent(target, context, () => guest.upgrade(target, { version }, context))
            if (script) {
              step = "run goldenSetup"
              await boxd.copyTo(target, script, SETUP_PATH, context)
              // The remote shell runs as boxd, whose $HOME is /home/boxd: the script is run once, then removed.
              const ran = await boxd.exec(target, `sh "$HOME/${SETUP_FILE}"; code=$?; rm -f "$HOME/${SETUP_FILE}"; exit $code`, { timeoutSeconds: Math.floor((TIMEOUTS.goldenStep - TIMEOUTS.killGraceMs) / 1000), json: false }, context)
              if (ran.code !== 0) {
                const said = shortReason(ran.stderr.split("\n").filter((line) => line.trim()).at(-1) ?? "")
                throw boxdError("GOLDEN_BUILD_FAILED", `goldenSetup exited with ${ran.code}${said ? ` (${said})` : ""}.`, { step })
              }
            }
          }
          step = "scrub"
          const scrub = await guest.scrub(target, context)
          if (scrub.refused === "has-credential") throw boxdError("GOLDEN_HAS_CREDENTIAL", `The base "${base}" holds ~/.local/share/opencode/auth.json: model credentials are never baked into an image.`)
          if (scrub.refused === "has-slot") throw boxdError("GOLDEN_HAS_SLOT", `The base "${base}" holds work slots under ~/.boxd-plugin/slots: a slot belongs to one work, so an image must not carry it.`)
          if (scrub.refused === "has-session") {
            throw boxdError("GOLDEN_BUILD_FAILED", `The base "${base}" has an OpenCode session in its database: it is a used machine, not an image. Build from "stock", or from a clean base.`, { step })
          }
          step = "save the image"
          await boxd.saveSnapshot(target, name, context)
        })
      } finally {
        await removeBuilder(region, builder as MachineName, created.id, context.call)
      }
      return { region, name, opencode: version, size, ...(warm ? { repo: warm.repo } : {}), seconds: Math.round((now() - started) / 1000) }
    } catch (error) {
      throw stepFailed(step, error)
    }
  }

  /** Best effort, with no signal: a stopped build still removes its builder; its own timer is the net. */
  async function removeBuilder(region: Region, name: MachineName, id: MachineId, call: OpContext["call"]): Promise<void> {
    const context: OpContext = { call }
    try {
      await runner.withMachineLock({ id }, context, async () => boxd.remove((await boxd.checkOwned(region, name, id, context)).target, context))
    } catch (error) {
      services.report("golden", `The golden builder ${name} in ${region} was not removed (${error instanceof Error ? error.message : String(error)}); its ${BUILDER_LEASE} timer removes it.`)
    }
  }

  function build(input: BuildInput, wait: { readonly signal: AbortSignal; readonly until: number }): Promise<GoldenImage | typeof STILL_BUILDING> {
    if (wait.signal.aborted) return Promise.reject(boxdError("CANCELLED", "The call was stopped before the golden build started.", { uncertain: false }))
    const key = `${input.region}:${input.name}`
    let flight = flights.get(key)
    if (!flight) {
      const controller = new AbortController()
      const context: OpContext = { call: { callId: `golden-${input.region}-${input.size}-${randomBytes(4).toString("hex")}`, source: "boxd_golden" }, signal: controller.signal }
      const created: Flight = { controller, joiners: 0, promise: recipe(input.region, input.size, input.base, input.name, context, input.warm) }
      created.promise.then(
        () => flights.get(key) === created && flights.delete(key),
        () => flights.get(key) === created && flights.delete(key),
      )
      flights.set(key, created)
      flight = created
    }
    const current = flight
    current.joiners += 1
    return new Promise((resolve, reject) => {
      let left = false
      const leave = () => {
        if (left) return false
        left = true
        current.joiners -= 1
        wait.signal.removeEventListener("abort", onAbort)
        clearTimeout(timer)
        return true
      }
      const onAbort = () => {
        if (!leave()) return
        // The last call to stop takes the build with it; a call that only ran out of time leaves it running.
        if (current.joiners === 0) current.controller.abort()
        reject(boxdError("CANCELLED", "The call was stopped while it waited for the golden build.", { uncertain: false }))
      }
      const timer = setTimeout(() => leave() && resolve(STILL_BUILDING), Math.max(0, wait.until - now()))
      timer.unref?.()
      wait.signal.addEventListener("abort", onAbort, { once: true })
      current.promise.then(
        (image) => leave() && resolve(image),
        (error: unknown) => leave() && reject(error),
      )
    })
  }

  async function prune(regions: readonly Region[], context: OpContext): Promise<GoldenResult> {
    const open = await services.ledger.list({}, context)
    const inUse = new Set(open.map((record) => `${record.region}:${record.image.name}`))
    const all = (await images(context)).flatMap((row) => {
      const parsed = parseImageName(options.goldenPrefix, row.name)
      return parsed && regions.includes(row.region) ? [{ region: row.region, name: row.name, opencode: parsed.opencode, size: parsed.size }] : []
    })
    const removed: GoldenImage[] = []
    const kept: GoldenImage[] = []
    for (const image of all) {
      // Never an image an open work records (boxd_resume rebuilds from it), and never the current version's.
      const used = inUse.has(`${image.region}:${image.name}`) || open.some((record) => record.region === null && record.image.name === image.name)
      if (used || image.opencode === services.hostVersion) kept.push(image)
      else {
        await boxd.removeSnapshot(image.region, image.name, context)
        removed.push(image)
      }
    }
    return { state: "pruned", images: kept, removed }
  }

  async function run(input: Record<string, unknown>, call: CallContext): Promise<GoldenResult> {
    const region = input.region ?? "all"
    if (region !== "all" && !(REGIONS as readonly unknown[]).includes(region)) throw boxdError("NAME_INVALID", `region must be one of ${REGIONS.join(", ")} or all.`, { field: "region" })
    const allowed = options.regions
    // A prune deletes images: that is not placement, so it covers any region, including one outside the option `regions`.
    const pruning = input.prune === true
    if (!pruning && region !== "all" && !allowed.includes(region as Region)) {
      throw boxdError("REGION_NOT_ALLOWED", `boxd_golden was asked to build in region "${region}", and the plugin option "regions" allows only ${regionsText(allowed)}; nothing was built.`, {
        field: "region",
        region,
        allowed,
      })
    }
    const size = input.size ?? options.size
    if (!(SIZES as readonly unknown[]).includes(size)) throw boxdError("NAME_INVALID", `size must be one of ${SIZES.join(", ")}.`, { field: "size" })
    const from = input.from ?? options.goldenBase
    if (typeof from !== "string" || (from !== "stock" && !safeSnapshot(from))) throw boxdError("NAME_INVALID", 'from must be "stock" or a boxd snapshot name.', { field: "from" })
    for (const flag of ["rebuild", "prune"] as const) if (input[flag] !== undefined && typeof input[flag] !== "boolean") throw boxdError("NAME_INVALID", `${flag} must be true or false.`, { field: flag })
    let warm: WarmRepository | undefined
    if (input.repo !== undefined) {
      if (typeof input.repo !== "string") throw boxdError("NAME_INVALID", "repo must be an https://github.com/owner/repo URL listed in the plugin option \"warm\".", { field: "repo" })
      let url: string
      try {
        url = normaliseRepo(input.repo)
      } catch {
        throw boxdError("NAME_INVALID", `repo "${input.repo}" is not an https://github.com/owner/repo URL.`, { field: "repo" })
      }
      warm = options.warm.find((entry) => entry.repo === url)
      if (!warm) {
        const listed = options.warm.length ? ` It lists ${options.warm.map((entry) => entry.repo).join(", ")}.` : ' It lists no repository.'
        throw boxdError("NAME_INVALID", `repo "${url}" is not in the plugin option "warm".${listed} Add it to "warm" with its setup script, then restart OpenCode.`, { field: "repo" })
      }
      if (pruning) throw boxdError("NAME_INVALID", 'prune removes golden images by name; it cannot be combined with "repo".', { field: "repo" })
      if (input.from !== undefined) throw boxdError("NAME_INVALID", 'a warm image starts from its OpenCode version\'s golden image, so "from" cannot be combined with "repo".', { field: "repo" })
    }
    const regions = region === "all" ? (pruning ? [...REGIONS] : [...allowed]) : [region as Region]
    const context: OpContext = { call: { callId: call.id, source: "boxd_golden" }, signal: call.signal }
    if (input.prune === true) return prune(regions, context)

    return runOne({ signal: call.signal, ...(settings.bound ? { boundMs: settings.bound() } : {}), now }, async (item: ItemContext) => {
      const versionName = imageName(options.goldenPrefix, services.hostVersion, size as Size)
      const name = warm ? warmImageName(options.goldenPrefix, warm.repo, services.hostVersion, size as Size) : versionName
      const present = await images(context)
      const wanted = regions.map((where) => ({ region: where, exists: present.some((row) => row.region === where && row.name === name) }))
      const toBuild = wanted.filter((entry) => input.rebuild === true || !entry.exists)
      const settled = await Promise.allSettled(
        toBuild.map(async (entry) => {
          if (warm && !present.some((row) => row.region === entry.region && row.name === versionName)) {
            const base = await build({ region: entry.region, size: size as Size, base: from, name: versionName }, { signal: call.signal, until: item.deadline })
            if (base === STILL_BUILDING) {
              throw boxdError("TIMEOUT", `The golden image ${versionName} that ${name} starts from is still building after this call's bound; it goes on, and the same boxd_golden call joins it.`, { step: "golden build" })
            }
          }
          return build({ region: entry.region, size: size as Size, base: warm ? versionName : from, name, ...(warm ? { warm } : {}) }, { signal: call.signal, until: item.deadline })
        }),
      )
      const failure = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected")
      if (failure) throw failure.reason
      const built = settled.map((entry) => (entry as PromiseFulfilledResult<GoldenImage | typeof STILL_BUILDING>).value)
      if (built.includes(STILL_BUILDING)) {
        throw boxdError("TIMEOUT", `The golden build of ${name} is still running after this call's bound; it goes on, and the same boxd_golden call joins it.`, { step: "golden build" })
      }
      const result = wanted.map(
        (entry) =>
          (built as GoldenImage[]).find((image) => image.region === entry.region) ?? {
            region: entry.region,
            name,
            opencode: services.hostVersion!,
            size: size as Size,
            ...(warm ? { repo: warm.repo } : {}),
          },
      )
      const warning = built.length > 0 && !(await secretsKnown(context)) ? ("NO_MODEL_CREDENTIAL" as const) : undefined
      return {
        state: built.length > 0 ? "built" : "present",
        images: result,
        ...(warning ? { warning, next: "Give works a model key: a sealed, host-bound boxd env secret, a separately named secret per provider, or opencode auth login on one work's own machine." } : {}),
      }
    })
  }

  /** Whether the account has a provider key among its sealed variables; an unreadable list warns nothing. */
  async function secretsKnown(context: OpContext): Promise<boolean> {
    try {
      return hasProviderKey(await boxd.secrets(context))
    } catch {
      return true
    }
  }

  return { images, build, run }
}

function safeSnapshot(name: string): boolean {
  try {
    assertSnapshot(name)
    return true
  } catch {
    return false
  }
}
