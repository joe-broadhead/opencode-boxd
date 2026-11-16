import { boxdError } from "./errors.js"
import { assertSnapshot } from "./names.js"
import { ACCESS_VALUES, type Access } from "./permissions.js"
import { REGIONS, SIZES, type Region, type Size } from "./ports.js"

/** Where a new work goes: the region with the most free machines after `keepFree`, or one region. */
export type RegionChoice = "auto" | Region
export type BuildGolden = "auto" | "never"
export type Notices = "wake" | "queue" | "off"
/** `auto`: on at `access: "all"`, off otherwise; `on`: the person's standing consent at every level; `off`: never. */
export type Automation = "auto" | "on" | "off"
export interface Budget {
  /** Machine cost per day, in the organisation's billing currency. */
  readonly daily: number
  readonly action: "warn" | "refuse"
}

/** The plugin options (design §9.2). Every option is optional; each default is below. */
export interface Options {
  /** What the plugin's own tools may do without asking: everything, ask for changes, or reads only. */
  readonly access: Access
  /** Laptop roots a work may name or write besides the project: paths outside both are refused. */
  readonly allowedRoots: readonly string[]
  /** Run on an OpenCode version outside the supported range, with a warning in status. */
  readonly allowUntestedHost: boolean
  readonly region: RegionChoice
  /** Machines `auto` leaves free in each region, for the organisation's CI pool. */
  readonly keepFree: Readonly<Record<Region, number>>
  /** A new work's size. */
  readonly size: Size
  /** The guest's git identity for every new work; none by default. */
  readonly git?: { readonly name: string; readonly email: string }
  /** Golden image names are `<goldenPrefix>-<opencode version>-<size>`. */
  readonly goldenPrefix: string
  /** What a golden build starts from: stock, or a snapshot in the region it lives in. */
  readonly goldenBase: "stock" | string
  /** A laptop script, inside the project or an allowed root, run on every golden builder before the scrub. */
  readonly goldenSetup?: string
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
  /** The context line and the compaction part (§C.4). */
  readonly costContext: boolean
  /** The end-of-turn idle check (§C.4). */
  readonly idleCheck: boolean
}

export const DEFAULT_OPTIONS: Options = {
  access: "all",
  allowedRoots: [],
  allowUntestedHost: false,
  region: "auto",
  keepFree: { fra: 0, nyc: 0 },
  size: "2x8",
  goldenPrefix: "oc-golden",
  goldenBase: "stock",
  buildGolden: "auto",
  notices: "wake",
  autoHibernateMinutes: 120,
  automation: "auto",
  autoSleepMinutes: 10,
  orphanHours: 12,
  leaseDays: 0,
  costContext: true,
  idleCheck: true,
}

const REGION_CHOICES: readonly RegionChoice[] = ["auto", ...REGIONS]
const BUILD_GOLDEN: readonly BuildGolden[] = ["auto", "never"]
const NOTICES: readonly Notices[] = ["wake", "queue", "off"]
const AUTOMATION: readonly Automation[] = ["auto", "on", "off"]
const BUDGET_ACTIONS: readonly Budget["action"][] = ["warn", "refuse"]
/** The longest prefix that still leaves room for `-<version>-<size>` in a 64-character snapshot name. */
const PREFIX = /^[a-z][a-z0-9-]{0,31}$/
const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/

const quoted = (values: readonly string[]) => values.map((value) => `"${value}"`).join(", ")

const ACCEPTED = {
  access: '"all" (the default), "ask-changes" or "read-only"',
  allowedRoots: "an array of absolute laptop folders that work files may use besides the project (empty by default)",
  allowUntestedHost: "true or false (the default)",
  region: `${quoted(REGION_CHOICES)} ("auto" by default)`,
  keepFree: `an object with a whole number of machines, 0 or more, for each of ${quoted(REGIONS)} (0 by default)`,
  size: `${quoted(SIZES)} ("2x8" by default)`,
  git: "an object with a non-empty name and an email address",
  goldenPrefix: 'a lowercase name of up to 32 letters, digits or hyphens, starting with a letter ("oc-golden" by default)',
  goldenBase: '"stock" (the default) or a lowercase boxd snapshot name',
  goldenSetup: "an absolute laptop path to a script",
  buildGolden: '"auto" (the default) or "never"',
  notices: '"wake" (the default), "queue" or "off"',
  autoHibernateMinutes: "a whole number of minutes from 30 to 1440 (120 by default)",
  automation: '"auto" (the default: on at access "all", off otherwise), "on" or "off"',
  autoSleepMinutes: "a whole number of minutes, 0 or more (10 by default; 0 turns auto-sleep off)",
  orphanHours: "a whole number of hours, 1 or more (12 by default)",
  leaseDays: "a whole number of days, 0 or more (0, off, by default)",
  budget: 'an object with a positive daily amount in the organisation\'s billing currency and an action, "warn" or "refuse"',
  costContext: "true (the default) or false",
  idleCheck: "true (the default) or false",
} as const satisfies Record<keyof Options, string>

/** Options that a release removed, with what replaced them. */
const REMOVED: Readonly<Record<string, string>> = {
  snapshot: 'The option "snapshot" is removed: golden images are now built from stock. Remove it; set "goldenBase" only to build on a hand-made base without model credentials',
}

const EXAMPLE = `"plugins": [{ "package": "github:joe-broadhead/opencode-boxd#<tag>", "options": { "region": "auto", "size": "2x8" } }]`

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
    if (Object.hasOwn(REMOVED, key)) throw invalid(REMOVED[key]!)
    if (!Object.hasOwn(ACCEPTED, key)) throw invalid(`Unknown option "${key}". Accepted options: ${quoted(Object.keys(ACCEPTED))}`)
  }
  const input = { ...DEFAULT_OPTIONS, ...raw } as Record<keyof Options, unknown>

  for (const key of ["allowUntestedHost", "costContext", "idleCheck"] as const) if (typeof input[key] !== "boolean") throw wrong(key, input[key])
  const access = oneOf("access", input.access, ACCESS_VALUES)
  const { allowedRoots } = input
  if (!Array.isArray(allowedRoots) || allowedRoots.some((root) => typeof root !== "string" || !root.startsWith("/"))) throw wrong("allowedRoots", allowedRoots)
  const region = oneOf("region", input.region, REGION_CHOICES)
  const size = oneOf("size", input.size, SIZES)

  const { keepFree } = input
  if (!isObject(keepFree) || Object.keys(keepFree).some((key) => !(REGIONS as readonly string[]).includes(key))) throw wrong("keepFree", keepFree)
  const free = { ...DEFAULT_OPTIONS.keepFree, ...keepFree } as Record<string, unknown>
  for (const value of Object.values(free)) if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw wrong("keepFree", keepFree)

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

  let budget: Budget | undefined
  if (input.budget !== undefined) {
    const raw = input.budget
    if (!isObject(raw) || Object.keys(raw).sort().join() !== "action,daily") throw wrong("budget", raw)
    if (typeof raw.daily !== "number" || !Number.isFinite(raw.daily) || raw.daily <= 0) throw wrong("budget", raw)
    if (typeof raw.action !== "string" || !(BUDGET_ACTIONS as readonly string[]).includes(raw.action)) throw wrong("budget", raw)
    budget = { daily: raw.daily, action: raw.action as Budget["action"] }
  }

  return {
    access,
    allowedRoots: allowedRoots as readonly string[],
    allowUntestedHost: input.allowUntestedHost as boolean,
    region,
    keepFree: free as Record<Region, number>,
    size,
    ...(git !== undefined ? { git: { name: (git as { name: string }).name, email: (git as { email: string }).email } } : {}),
    goldenPrefix,
    goldenBase,
    ...(goldenSetup !== undefined ? { goldenSetup: goldenSetup as string } : {}),
    buildGolden: oneOf("buildGolden", input.buildGolden, BUILD_GOLDEN),
    notices: oneOf("notices", input.notices, NOTICES),
    autoHibernateMinutes: wholeNumber("autoHibernateMinutes", input.autoHibernateMinutes, 30, 1440),
    automation: oneOf("automation", input.automation, AUTOMATION),
    autoSleepMinutes: wholeNumber("autoSleepMinutes", input.autoSleepMinutes, 0),
    orphanHours: wholeNumber("orphanHours", input.orphanHours, 1),
    leaseDays: wholeNumber("leaseDays", input.leaseDays, 0),
    ...(budget ? { budget } : {}),
    costContext: input.costContext as boolean,
    idleCheck: input.idleCheck as boolean,
  }
}
