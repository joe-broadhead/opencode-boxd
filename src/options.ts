import { boxdError } from "./errors.js"
import { assertRef, assertSnapshot, normaliseRepo } from "./names.js"
import { REGIONS, SIZES, type Region, type Size } from "./ports.js"

export type Access = "all" | "ask-changes" | "read-only"
export const ACCESS_VALUES: readonly Access[] = ["all", "ask-changes", "read-only"]

/** Where a new work goes: the region with the most free machines after `keepFree`, or one region. */
export type RegionChoice = "auto" | Region
export type BuildGolden = "auto" | "never"
export type Notices = "wake" | "queue" | "off"
/** `auto`: on at `access: "all"`, off otherwise; `on`: the person's standing consent at every level; `off`: never. */
export type Automation = "auto" | "on" | "off"
export interface Budget {
  /** Machine cost per day, in the organisation's billing currency, when set. */
  readonly daily?: number
  /** Machine-hours this ledger's works may run in one local day, when set. */
  readonly machineHours?: number
  readonly action: "warn" | "refuse"
}

/** A repository whose checkout, toolchain and dependencies a warm image carries. */
export interface WarmRepository {
  /** An https://github.com/owner/repo URL, stored and matched without `.git`. */
  readonly repo: string
  /** The branch or tag to warm; the remote's default branch when unset. */
  readonly ref?: string
  /** An absolute path here to a script that installs the repository's toolchain and dependencies inside its checkout. */
  readonly setup?: string
}

/** The plugin options (design §9.2). Every option is optional; each default is below. */
export interface Options {
  /** What the plugin's own tools may do without asking: everything, ask for changes, or reads only. */
  readonly access: Access
  /** Laptop roots a work may name or write besides the project: paths outside both are refused. */
  readonly allowedRoots: readonly string[]
  /** Run on an OpenCode version outside the supported range, with a warning in status. */
  readonly allowUntestedHost: boolean
  /** The regions a new work, or a golden image, may be placed in; every region by default. */
  readonly regions: readonly Region[]
  /** Where a new work goes within `regions`: `auto` (the most free), or one region. */
  readonly region: RegionChoice
  /** Machines `auto` leaves free in each region, for the organisation's CI pool. */
  readonly keepFree: Readonly<Record<Region, number>>
  /** Label selectors (`key=value`, or a bare key) for machines owned elsewhere: a match is kept, never an orphan. */
  readonly keep: readonly string[]
  /** A new work's size. */
  readonly size: Size
  /** The most open works one shared machine may hold. */
  readonly slotsPerMachine: number
  /** The guest's git identity for every new work; none by default. */
  readonly git?: { readonly name: string; readonly email: string }
  /** Golden image names are `<goldenPrefix>-<opencode version>-<size>`. */
  readonly goldenPrefix: string
  /** What a golden build starts from: stock, or a snapshot in the region it lives in. */
  readonly goldenBase: "stock" | string
  /** A laptop script, inside the project or an allowed root, run on every golden builder before the scrub. */
  readonly goldenSetup?: string
  /** The repositories a warm image carries; `golden` with a `repo` builds one. */
  readonly warm: readonly WarmRepository[]
  readonly buildGolden: BuildGolden
  readonly notices: Notices
  /** The platform's idle bound set at creation (design §C.2), 30 to 1440; auto-suspend is always off. */
  readonly autoHibernateMinutes: number
  /** Whether the plugin harvests and then sleeps finished and orphaned works by itself (§C.3). */
  readonly automation: Automation
  /** Idle minutes before automation harvests and sleeps a finished work; 0 turns that step off. Not consent. */
  readonly autoSleepMinutes: number
  /** A running, not-busy work no plugin call touched for this long is harvested and slept. */
  readonly orphanHours: number
  /** A delete-after lease renewed on activity, in days; 0 is off, because boxd deletes unsaved work too (§C.2). */
  readonly leaseDays: number
  /** Machine cost per day, warned about or refused at (§C.5); none by default. */
  readonly budget?: Budget
}

export const DEFAULT_OPTIONS: Options = {
  access: "all",
  allowedRoots: [],
  allowUntestedHost: false,
  regions: [...REGIONS],
  region: "auto",
  keepFree: { fra: 0, nyc: 0 },
  keep: [],
  size: "2x8",
  slotsPerMachine: 4,
  goldenPrefix: "oc-golden",
  goldenBase: "stock",
  warm: [],
  buildGolden: "auto",
  notices: "wake",
  autoHibernateMinutes: 120,
  automation: "auto",
  autoSleepMinutes: 10,
  orphanHours: 12,
  leaseDays: 0,
}

const REGION_CHOICES: readonly RegionChoice[] = ["auto", ...REGIONS]
const BUILD_GOLDEN: readonly BuildGolden[] = ["auto", "never"]
const NOTICES: readonly Notices[] = ["wake", "queue", "off"]
const AUTOMATION: readonly Automation[] = ["auto", "on", "off"]
const BUDGET_ACTIONS: readonly Budget["action"][] = ["warn", "refuse"]
/** The longest prefix that still leaves room for `-<version>-<size>` in a 64-character snapshot name. */
const PREFIX = /^[a-z][a-z0-9-]{0,31}$/
const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/
/** A `keep` selector: a boxd label key, with an optional `=value`. */
const SELECTOR = /^[a-z0-9._/-]{1,63}(?:=[A-Za-z0-9._/@:-]{0,63})?$/

const quoted = (values: readonly string[]) => values.map((value) => `"${value}"`).join(", ")

const ACCEPTED = {
  access: '"all" (the default), "ask-changes" or "read-only"',
  allowedRoots: "an array of absolute folders here that work files may use besides the project (empty by default)",
  allowUntestedHost: "true or false (the default)",
  regions: `a non-empty array of unique regions from ${quoted(REGIONS)}, where new works and golden images may be placed (${quoted(REGIONS)} by default)`,
  region: `${quoted(REGION_CHOICES)} ("auto" by default); a named region must be one of "regions"`,
  keepFree: `an object with a whole number of machines, 0 or more, for each of ${quoted(REGIONS)} (0 by default)`,
  keep: 'an array of label selectors, each "key=value" or a bare key (empty by default)',
  size: `${quoted(SIZES)} ("2x8" by default)`,
  slotsPerMachine: "a whole number of works from 1 (4 by default) that one shared machine may hold",
  git: "an object with a non-empty name and an email address",
  goldenPrefix: 'a lowercase name of up to 32 letters, digits or hyphens, starting with a letter ("oc-golden" by default)',
  goldenBase: '"stock" (the default) or a lowercase boxd snapshot name',
  goldenSetup: "an absolute path here to a script",
  warm: "an array of objects like { repo, ref, setup }: repo is an https://github.com/owner/repo URL, ref is a branch or tag, and setup is an absolute path here to a script (empty by default)",
  buildGolden: '"auto" (the default) or "never"',
  notices: '"wake" (the default), "queue" or "off"',
  autoHibernateMinutes: "a whole number of minutes from 30 to 1440 (120 by default)",
  automation: '"auto" (the default: on at access "all", off otherwise), "on" or "off"',
  autoSleepMinutes: "a whole number of minutes, 0 or more (10 by default; 0 turns auto-sleep off)",
  orphanHours: "a whole number of hours, 1 or more (12 by default)",
  leaseDays: "a whole number of days, 0 or more (0, off, by default)",
  budget: 'an object with "action" ("warn" or "refuse") and at least one positive cap: "daily" in the organisation\'s billing currency, or "machineHours" in this ledger\'s running hours per local day',
} as const satisfies Record<keyof Options, string>

const EXAMPLE = `"plugins": [{ "package": "github:we-the-rebel-alliance/boxd-plugin#v<version>", "options": { "region": "auto", "size": "2x8" } }]`

const invalid = (problem: string) => boxdError("OPTIONS_INVALID", `${problem}. Fix the plugin options, for example ${EXAMPLE}`)

const describe = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "an array" : typeof value === "string" ? JSON.stringify(value) : typeof value === "object" ? "an object" : String(value)

const wrong = (key: keyof typeof ACCEPTED, value: unknown) => invalid(`The option "${key}" must be ${ACCEPTED[key]}, found ${describe(value)}`)

function oneOf<T extends string>(key: keyof typeof ACCEPTED, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw wrong(key, value)
  return value as T
}

function wholeNumber(key: keyof typeof ACCEPTED, value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) throw wrong(key, value)
  return value
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Validates the plugin options from opencode.json. Every option is optional. */
export function parseOptions(raw: unknown): Options {
  if (raw === undefined || raw === null) return DEFAULT_OPTIONS
  if (!isObject(raw)) throw invalid(`The plugin options must be an object, found ${describe(raw)}`)
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(ACCEPTED, key)) throw invalid(`Unknown option "${key}". Accepted options: ${quoted(Object.keys(ACCEPTED))}`)
  }
  const input = { ...DEFAULT_OPTIONS, ...raw } as Record<keyof Options, unknown>

  if (typeof input.allowUntestedHost !== "boolean") throw wrong("allowUntestedHost", input.allowUntestedHost)
  const access = oneOf("access", input.access, ACCESS_VALUES)
  const { allowedRoots } = input
  if (!Array.isArray(allowedRoots) || allowedRoots.some((root) => typeof root !== "string" || !root.startsWith("/"))) throw wrong("allowedRoots", allowedRoots)
  const { regions: listed } = input
  if (!Array.isArray(listed)) throw wrong("regions", listed)
  if (listed.length === 0) throw invalid(`The option "regions" must list at least one region, from ${quoted(REGIONS)}`)
  const chosen: Region[] = []
  for (const value of listed) {
    if (typeof value !== "string" || !(REGIONS as readonly string[]).includes(value)) throw invalid(`The option "regions" lists ${describe(value)}, which is not a region; list ${quoted(REGIONS)}`)
    if (chosen.includes(value as Region)) throw invalid(`The option "regions" lists "${value}" twice; name each region once`)
    chosen.push(value as Region)
  }
  // The one order every pick, message and status row uses: boxd's own region order, not the order the option wrote them.
  const regions = REGIONS.filter((region) => chosen.includes(region))
  const region = oneOf("region", input.region, REGION_CHOICES)
  if (region !== "auto" && !regions.includes(region)) {
    throw invalid(`The option "region" is "${region}", which the option "regions" does not list (${quoted(regions)}); add "${region}" to "regions" or set "region" to one it lists`)
  }
  const size = oneOf("size", input.size, SIZES)

  const { keepFree } = input
  if (!isObject(keepFree) || Object.keys(keepFree).some((key) => !(REGIONS as readonly string[]).includes(key))) throw wrong("keepFree", keepFree)
  const free = { ...DEFAULT_OPTIONS.keepFree, ...keepFree } as Record<string, unknown>
  for (const value of Object.values(free)) if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw wrong("keepFree", keepFree)

  const { keep } = input
  if (!Array.isArray(keep) || keep.some((selector) => typeof selector !== "string" || !SELECTOR.test(selector))) throw wrong("keep", keep)

  const { git } = input
  if (git !== undefined) {
    if (!isObject(git) || Object.keys(git).sort().join() !== "email,name") throw wrong("git", git)
    if (typeof git.name !== "string" || !git.name.trim() || typeof git.email !== "string" || !EMAIL.test(git.email)) throw wrong("git", git)
  }

  const { goldenPrefix, goldenBase, goldenSetup } = input
  if (typeof goldenPrefix !== "string" || !PREFIX.test(goldenPrefix)) throw wrong("goldenPrefix", goldenPrefix)
  if (typeof goldenBase !== "string") throw wrong("goldenBase", goldenBase)
  if (goldenBase !== "stock") {
    try {
      assertSnapshot(goldenBase)
    } catch {
      throw wrong("goldenBase", goldenBase)
    }
  }
  if (goldenSetup !== undefined && (typeof goldenSetup !== "string" || !goldenSetup.startsWith("/"))) throw wrong("goldenSetup", goldenSetup)

  const { warm } = input
  if (!Array.isArray(warm)) throw wrong("warm", warm)
  const repositories: WarmRepository[] = []
  const seen = new Set<string>()
  warm.forEach((raw, index) => {
    if (!isObject(raw) || Object.keys(raw).some((key) => !["repo", "ref", "setup"].includes(key))) throw wrong("warm", warm)
    const { repo, ref, setup } = raw
    if (typeof repo !== "string") throw invalid(`The option "warm" item ${index + 1} must name its repository in "repo", as an https://github.com/owner/repo URL`)
    let url: string
    try {
      url = normaliseRepo(repo)
    } catch {
      throw invalid(`The option "warm" item ${index + 1} "repo" must be an https://github.com/owner/repo URL, found ${describe(repo)}`)
    }
    if (seen.has(url)) throw invalid(`The option "warm" lists ${url} twice; name each repository once`)
    seen.add(url)
    if (ref !== undefined) {
      if (typeof ref !== "string") throw invalid(`The option "warm" item ${index + 1} "ref" must be a branch or tag name`)
      try {
        assertRef(ref)
      } catch {
        throw invalid(`The option "warm" item ${index + 1} "ref" is not a branch or tag name: up to 120 letters, digits, dots, underscores, slashes or hyphens`)
      }
    }
    if (setup !== undefined && (typeof setup !== "string" || !setup.startsWith("/"))) throw invalid(`The option "warm" item ${index + 1} "setup" must be an absolute path here to a script`)
    repositories.push({ repo: url, ...(ref !== undefined ? { ref } : {}), ...(setup !== undefined ? { setup } : {}) })
  })

  let budget: Budget | undefined
  if (input.budget !== undefined) {
    const raw = input.budget
    if (!isObject(raw)) throw wrong("budget", raw)
    const keys = Object.keys(raw).sort().join()
    if (keys !== "action,daily" && keys !== "action,machineHours" && keys !== "action,daily,machineHours") throw wrong("budget", raw)
    if (raw.daily !== undefined && (typeof raw.daily !== "number" || !Number.isFinite(raw.daily) || raw.daily <= 0)) throw wrong("budget", raw)
    if (raw.machineHours !== undefined && (typeof raw.machineHours !== "number" || !Number.isFinite(raw.machineHours) || raw.machineHours <= 0)) throw wrong("budget", raw)
    if (raw.daily === undefined && raw.machineHours === undefined) throw invalid('The option "budget" must set at least one of "daily", in the organisation\'s billing currency, or "machineHours", this ledger\'s running hours per local day')
    if (typeof raw.action !== "string" || !(BUDGET_ACTIONS as readonly string[]).includes(raw.action)) throw wrong("budget", raw)
    budget = {
      ...(raw.daily !== undefined ? { daily: raw.daily as number } : {}),
      ...(raw.machineHours !== undefined ? { machineHours: raw.machineHours as number } : {}),
      action: raw.action as Budget["action"],
    }
  }

  return {
    access,
    allowedRoots: allowedRoots as readonly string[],
    allowUntestedHost: input.allowUntestedHost as boolean,
    regions,
    region,
    keepFree: free as Record<Region, number>,
    keep: [...new Set(keep as string[])],
    size,
    slotsPerMachine: wholeNumber("slotsPerMachine", input.slotsPerMachine, 1),
    ...(git !== undefined ? { git: { name: (git as { name: string }).name, email: (git as { email: string }).email } } : {}),
    goldenPrefix,
    goldenBase,
    ...(goldenSetup !== undefined ? { goldenSetup: goldenSetup as string } : {}),
    warm: repositories,
    buildGolden: oneOf("buildGolden", input.buildGolden, BUILD_GOLDEN),
    notices: oneOf("notices", input.notices, NOTICES),
    autoHibernateMinutes: wholeNumber("autoHibernateMinutes", input.autoHibernateMinutes, 30, 1440),
    automation: oneOf("automation", input.automation, AUTOMATION),
    autoSleepMinutes: wholeNumber("autoSleepMinutes", input.autoSleepMinutes, 0),
    orphanHours: wholeNumber("orphanHours", input.orphanHours, 1),
    leaseDays: wholeNumber("leaseDays", input.leaseDays, 0),
    ...(budget ? { budget } : {}),
  }
}
