/**
 * The spawn-count harness's interface (design §4.4, §7.1): a fake boxd CLI, and a fake laptop `opencode`, that log
 * every spawn with the call it belongs to, so a test can count one tool call's children by verb and check them against
 * that call's budget. Package A builds the harness (`startSpawnCounter`, beside `test/host/fake-boxd.mjs`); every tool's
 * owner asserts its own row of `SPAWN_BUDGETS` with it.
 *
 * How a spawn is tied to a call: the runner sets `CALL_TAG_ENV` (`src/ports.ts`) on every child it starts, to the
 * call's id, and the fake binaries log it beside their argv. A spawn without the tag is a spawn that bypassed the
 * runner, which `untagged()` reports and every budget test expects to be empty.
 */
import { CALL_TAG_ENV } from "../../src/ports.js"

export { CALL_TAG_ENV }

/** The verbs a budget counts. `other` is anything else, which no budget allows. */
export type Verb =
  | "machine list"
  | "machine get"
  | "machine new"
  | "machine exec"
  | "machine cp"
  | "machine wake"
  | "machine hibernate"
  | "machine remove"
  | "machine resize"
  | "machine reboot"
  | "machine rename"
  | "machine label"
  | "machine config"
  | "manage machine-limit"
  | "manage usage"
  | "snapshots list"
  | "snapshots save"
  | "snapshots rm"
  | "env list"
  | "help"
  | "opencode session delete"
  | "opencode session import"
  | "other"

/** One child as a fake binary logged it. */
export interface SpawnRecord {
  /** The `CALL_TAG_ENV` value, or null for a spawn that bypassed the runner. */
  readonly call: string | null
  readonly bin: "boxd" | "opencode"
  readonly argv: readonly string[]
  readonly verb: Verb
  readonly startedAt: number
  readonly endedAt: number
}

export interface SpawnCounterOptions {
  /** Each fake call's latency, picked uniformly in this range: the stall test uses 1 to 3 s. */
  readonly latencyMs?: readonly [number, number]
}

export interface SpawnCounter {
  /** The fake boxd CLI: pass it as the plugin's `boxdBin`. */
  readonly boxdBin: string
  /** The fake laptop `opencode`, for the import pool. */
  readonly opencodeBin: string
  /** Every spawn, in start order; only one call's when `call` is given. */
  spawns(call?: string): readonly SpawnRecord[]
  /** One call's spawns, counted by verb. */
  count(call: string): Readonly<Partial<Record<Verb, number>>>
  /** Spawns that carried no call tag: they bypassed the runner. */
  untagged(): readonly SpawnRecord[]
  /** The most children alive at once, over every call, since the last reset. */
  peak(): number
  reset(): void
  dispose(): Promise<void>
}

/** Package A's implementation has this signature. */
export type StartSpawnCounter = (options?: SpawnCounterOptions) => Promise<SpawnCounter>

/** Which verb a child's argv is, for the fake binaries' log. */
export function verbOf(bin: "boxd" | "opencode", argv: readonly string[]): Verb {
  const words = argv.filter((arg) => !arg.startsWith("-"))
  if (bin === "opencode") {
    if (words[0] === "session" && words[1] === "delete") return "opencode session delete"
    if (words[0] === "session" && words[1] === "import") return "opencode session import"
    return "other"
  }
  if (argv.length === 1 && argv[0] === "--help") return "help"
  const pair = `${words[0] ?? ""} ${words[1] ?? ""}`
  const known: readonly Verb[] = [
    "machine list",
    "machine get",
    "machine new",
    "machine exec",
    "machine cp",
    "machine wake",
    "machine hibernate",
    "machine remove",
    "machine resize",
    "machine reboot",
    "machine rename",
    "machine label",
    "machine config",
    "manage machine-limit",
    "manage usage",
    "snapshots list",
    "snapshots save",
    "snapshots rm",
    "env list",
  ]
  return known.find((verb) => verb === pair) ?? "other"
}

/** One row of the spawn budget: a call in a named steady-state scenario, and the most children it may start. */
export interface BudgetRow {
  readonly call: string
  readonly scenario: string
  readonly owner: "C1" | "C2" | "D"
  /** The most spawns of each verb; a verb not listed is allowed none. */
  readonly max: Readonly<Partial<Record<Verb, number>>>
  /** The most spawns in total. */
  readonly total: number
}

/**
 * Design §4.4, as acceptance criteria. Every change that acts on an existing work's machine includes the one
 * `machine get` of the by-id check (§4.1), and a new work's `ensure` the one all-region listing of §3.4 step 2; `help`
 * is the CLI flavour check, once per binary per process, and is counted apart.
 */
export const SPAWN_BUDGETS: readonly BudgetRow[] = [
  {
    call: "boxd_status",
    scenario: "170 open works, none busy, machine limit cached",
    owner: "D",
    max: { "machine list": 1, "manage machine-limit": 1 },
    total: 2,
  },
  {
    call: "boxd_ensure",
    scenario: "a new work from an existing golden image, wait ready, limit and snapshot caches warm",
    owner: "C1",
    max: { "machine list": 1, "machine new": 1, "machine exec": 3 },
    total: 5,
  },
  {
    call: "boxd_ensure",
    scenario: "adopting an existing labelled oc-<id>, wait ready",
    owner: "C1",
    max: { "machine list": 1, "machine get": 1, "machine exec": 3 },
    total: 5,
  },
  {
    call: "boxd_submit",
    scenario: "a running work, no files",
    owner: "C2",
    max: { "machine list": 1, "machine get": 1, "machine exec": 1 },
    total: 3,
  },
  {
    call: "boxd_job",
    scenario: "one running work",
    owner: "D",
    max: { "machine list": 1, "machine exec": 1 },
    total: 2,
  },
  {
    call: "boxd_harvest",
    scenario: "an idle work with one session and a dirty tree",
    owner: "C2",
    max: { "machine get": 1, "machine exec": 2, "machine cp": 2, "opencode session delete": 1, "opencode session import": 1 },
    total: 7,
  },
  {
    call: "boxd_sleep",
    scenario: "one running work",
    owner: "C2",
    max: { "machine get": 1, "machine hibernate": 1 },
    total: 2,
  },
  {
    call: "boxd_drop",
    scenario: "a saved work with a clean tree",
    owner: "C2",
    max: { "machine exec": 1, "machine get": 1, "machine remove": 1 },
    total: 3,
  },
  {
    call: "boxd_drop",
    scenario: "a work whose machine is gone in both regions",
    owner: "C2",
    max: { "machine list": 1, "machine get": 2 },
    total: 3,
  },
]

/** What a call's counts break in its row: one sentence per verb over its maximum, and the total. */
export function budgetProblems(row: BudgetRow, counts: Readonly<Partial<Record<Verb, number>>>): string[] {
  const problems: string[] = []
  let total = 0
  for (const [verb, count] of Object.entries(counts) as Array<[Verb, number]>) {
    if (verb === "help") continue
    total += count
    const max = row.max[verb] ?? 0
    if (count > max) problems.push(`${row.call} (${row.scenario}) ran ${verb} ${count} times; its budget is ${max}`)
  }
  if (total > row.total) problems.push(`${row.call} (${row.scenario}) started ${total} children; its budget is ${row.total}`)
  return problems
}
