/**
 * Jelly's rules for the settings a plugin declares in `jelly.contributes.settings`, restated without a schema library
 * so that a test, under Node or Bun, reads this plugin's declaration the way Jelly does. It restates, from
 * we-the-rebel-alliance/app at master 6af624591 (which includes app#1301, 34274b8c7):
 *   - protocol/contracts/src/plugin-setting.light.ts:5-39: `PLUGIN_SETTING_MAX_LENGTH`, `settingChoices` and
 *     `settingValueIssue`, the check the host runs on every value a person saves, copied as they are;
 *   - protocol/contracts/src/plugin-setting.ts:14-89: `PluginSettingSchema`, a strict object with its refinements,
 *     as `settingProblems` (the refinements' messages are Jelly's own);
 *   - protocol/contracts/src/plugin-contract.ts:98 and 282-316: what `PluginDeclarationSchema` adds for the list, at
 *     most 32 settings, unique keys, and a `visibleWhen` that names a non-secret setting of the same type with no
 *     cycle, as `settingsProblems`.
 * Every object Jelly knows is strict, so a Jelly before app#1301, which does not know `enum`, `choices`, `min`, `max`,
 * `step` or `integer`, refuses the whole declaration. Each function returns sentences, so a test asserts `toEqual([])`.
 *
 * This is a shared copy: every plugin of the family carries this file byte for byte, pinned by its sha256 in that
 * plugin's `scripts/check-copies.mjs`. To change it, change Jelly's source first, then this file to match, run the
 * differential check against Jelly's zod schema (it is kept outside the plugin repositories), and land the same bytes
 * with the new hash in every plugin at once (`node scripts/check-copies.mjs --print` prints it). Keep the rules
 * Jelly's; never loosen them here. `ACCESS_CHOICES` is Jelly's wording for the shared `access` option, word for word.
 */

/** The longest value a setting may carry, a secret included. */
export const PLUGIN_SETTING_MAX_LENGTH = 8192

/** One value of a closed set, with the words a person reads for it. */
export interface PluginSettingChoice {
  readonly value: string
  readonly label?: string
  readonly description?: string
}

/** A setting a plugin declares, as Jelly's schema types it. */
export interface PluginSetting {
  readonly key: string
  readonly label: string
  readonly type: "string" | "boolean" | "number" | "secret"
  readonly description: string
  readonly enum?: readonly string[]
  readonly choices?: readonly PluginSettingChoice[]
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly integer?: boolean
  readonly visibleWhen?: { readonly setting: string; readonly equals: string | boolean | number }
  readonly default?: string | boolean | number
}

type Bounds = Pick<PluginSetting, "enum" | "choices" | "min" | "max" | "step" | "integer">

/** The closed set a string setting declares, as choices; undefined for free values. */
export function settingChoices(setting: Pick<PluginSetting, "enum" | "choices">): readonly PluginSettingChoice[] | undefined {
  return setting.choices ?? (setting.enum === undefined ? undefined : setting.enum.map((value) => ({ value })))
}

/**
 * Why a value does not fit the setting's declared set or bounds, or null when it does. The type itself is checked by
 * the caller. The host refuses with this; a form uses it to hold a Save back.
 */
export function settingValueIssue(setting: Bounds, value: string | number | boolean): string | null {
  const closed = settingChoices(setting)
  if (closed !== undefined && typeof value === "string" && !closed.some((c) => c.value === value)) return "not one of the declared values"
  if (typeof value !== "number") return null
  if (setting.integer === true && !Number.isInteger(value)) return "not a whole number"
  if (setting.min !== undefined && value < setting.min) return "below the minimum"
  if (setting.max !== undefined && value > setting.max) return "above the maximum"
  if (setting.step !== undefined) {
    const from = setting.min ?? 0
    const steps = (value - from) / setting.step
    if (Math.abs(steps - Math.round(steps)) > 1e-9) return "not on a step"
  }
  return null
}

const ID = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/
const SETTING_KEYS = ["key", "label", "type", "description", "enum", "choices", "min", "max", "step", "integer", "visibleWhen", "default"]
const CHOICE_KEYS = ["value", "label", "description"]
const TYPES = ["string", "boolean", "number", "secret"]
const MAX_SETTINGS = 32

type Fields = { readonly [key: string]: unknown }
const isObject = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown, min: number, max: number): boolean => typeof value === "string" && value.length >= min && value.length <= max
const id = (value: unknown): boolean => typeof value === "string" && ID.test(value)
// zod 4's `z.number()` refuses NaN and both infinities, so every number Jelly reads is finite.
const finite = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value)
const settingValue = (value: unknown): boolean => text(value, 0, PLUGIN_SETTING_MAX_LENGTH) || typeof value === "boolean" || finite(value)
const choice = (value: unknown): boolean =>
  isObject(value) &&
  Object.keys(value).every((key) => CHOICE_KEYS.includes(key)) &&
  text(value["value"], 1, 200) &&
  (value["label"] === undefined || text(value["label"], 1, 200)) &&
  (value["description"] === undefined || text(value["description"], 0, 300))
const list = (value: unknown, each: (item: unknown) => boolean): boolean =>
  Array.isArray(value) && value.length >= 2 && value.length <= 64 && value.every(each)

/** What Jelly's `PluginSettingSchema` refuses in one setting, as `setting <key>: <problem>`; empty when it reads it. */
export function settingProblems(raw: unknown): string[] {
  if (!isObject(raw)) return ["a setting must be an object"]
  const at = typeof raw["key"] === "string" ? `setting ${raw["key"]}` : "a setting"
  const problems: string[] = []
  const say = (problem: string): void => {
    problems.push(`${at}: ${problem}`)
  }
  for (const key of Object.keys(raw)) if (!SETTING_KEYS.includes(key)) say(`unknown field ${key}`)
  if (!id(raw["key"])) say("key must be an identifier")
  if (!text(raw["label"], 1, 200)) say("label must be 1 to 200 characters")
  if (!TYPES.includes(raw["type"] as string)) say("type must be string, boolean, number or secret")
  if (!text(raw["description"], 0, 1000)) say("description must be at most 1000 characters")
  if (raw["enum"] !== undefined && !list(raw["enum"], (value) => text(value, 1, 200))) say("enum must be 2 to 64 values of 1 to 200 characters")
  if (raw["choices"] !== undefined && !list(raw["choices"], choice))
    say("choices must be 2 to 64 entries of value (1 to 200 characters), label (1 to 200) and description (at most 300) only")
  for (const key of ["min", "max", "step"]) if (raw[key] !== undefined && !finite(raw[key])) say(`${key} must be a finite number`)
  if (finite(raw["step"]) && !((raw["step"] as number) > 0)) say("step must be positive")
  if (raw["integer"] !== undefined && typeof raw["integer"] !== "boolean") say("integer must be true or false")
  const when = raw["visibleWhen"]
  if (when !== undefined && !(isObject(when) && Object.keys(when).every((key) => key === "setting" || key === "equals") && id(when["setting"]) && settingValue(when["equals"])))
    say("visibleWhen must be { setting, equals } only, naming a setting and a value")
  if (raw["default"] !== undefined && !settingValue(raw["default"])) say("default must be a string of at most 8192 characters, a boolean or a finite number")
  if (problems.length > 0) return problems

  // Jelly's refinements (plugin-setting.ts:61-89), on a setting whose fields have the right shapes.
  const setting = raw as unknown as PluginSetting
  if (setting.default !== undefined) {
    if (setting.type === "secret" || typeof setting.default !== setting.type) say("A default must match the setting type; secrets never declare a default")
  }
  const closed = settingChoices(setting)
  if (setting.enum !== undefined && setting.choices !== undefined) say("Declare a closed set as enum or as choices, not both")
  if (closed !== undefined) {
    if (setting.type !== "string") say("Only a string setting has a closed set")
    if (new Set(closed.map((c) => c.value)).size !== closed.length) say("The values of a closed set must be unique")
    if (typeof setting.default === "string" && !closed.some((c) => c.value === setting.default)) say("A default must be one of the closed set's values")
  }
  const bounded = setting.min !== undefined || setting.max !== undefined || setting.step !== undefined || setting.integer !== undefined
  if (bounded && setting.type !== "number") say("Only a number setting has min, max, step or integer")
  if (setting.min !== undefined && setting.max !== undefined && setting.min > setting.max) say("min may not be above max")
  if (typeof setting.default === "number" && settingValueIssue(setting, setting.default) !== null) say("A default must satisfy the setting's own bounds")
  return problems
}

/** What Jelly refuses in `contributes.settings`: each setting's problems, then the list's own rules; empty when it reads them. */
export function settingsProblems(settings: unknown): string[] {
  if (!Array.isArray(settings)) return ["contributes.settings must be an array"]
  const problems = settings.flatMap(settingProblems)
  if (settings.length > MAX_SETTINGS) problems.push(`at most ${MAX_SETTINGS} settings`)
  if (problems.length > 0) return problems

  // plugin-contract.ts:282-316, on settings that each passed `PluginSettingSchema`.
  const all = settings as PluginSetting[]
  if (new Set(all.map((setting) => setting.key)).size !== all.length) problems.push("Contribution ids must be unique within a package")
  for (const setting of all) {
    const condition = setting.visibleWhen
    if (condition === undefined) continue
    const target = all.find((field) => field.key === condition.setting)
    let invalid = target === undefined || target.type === "secret" || typeof condition.equals !== target.type
    const seen = new Set([setting.key])
    let next = target
    while (next !== undefined) {
      if (seen.has(next.key)) {
        invalid = true
        break
      }
      seen.add(next.key)
      const key = next.visibleWhen?.setting
      next = key === undefined ? undefined : all.find((field) => field.key === key)
    }
    if (invalid) problems.push(`setting ${setting.key}: Setting visibility needs a non-secret setting of the same type and no dependency cycle`)
  }
  return problems
}

/** Jelly's own words for the three `access` values, the same in every plugin of the family (app#172). */
export const ACCESS_CHOICES: readonly PluginSettingChoice[] = [
  { value: "all", label: "Allowed", description: "Every tool runs without asking, reads and changes alike." },
  { value: "ask-changes", label: "Ask before changes", description: "Reads run without asking. Each change asks you first." },
  { value: "read-only", label: "Read only", description: "Reads run. Changes never run." },
]
