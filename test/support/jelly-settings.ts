/**
 * Jelly's rules for the settings a plugin declares in `jelly.contributes.settings` (its `PluginSettingSchema` and
 * `settingValueIssue`), restated without a schema library so that a test can read this plugin's declaration the way
 * Jelly does. A Jelly that knows `enum`, `choices` and number bounds refuses the whole declaration when one setting
 * breaks a rule here, so each rule returns a sentence and a test asserts `toEqual([])`.
 */

export type SettingChoice = { value: string; label?: string; description?: string }
export type Setting = {
  key: string
  label: string
  type: "string" | "boolean" | "number" | "secret"
  description: string
  enum?: string[]
  choices?: SettingChoice[]
  min?: number
  max?: number
  step?: number
  integer?: boolean
  visibleWhen?: { setting: string; equals: string | boolean | number }
  default?: string | boolean | number
}

const ID = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/
const SETTING_KEYS = ["key", "label", "type", "description", "enum", "choices", "min", "max", "step", "integer", "visibleWhen", "default"]
const CHOICE_KEYS = ["value", "label", "description"]
const TYPES = ["string", "boolean", "number", "secret"]
const MAX_VALUE_LENGTH = 8192

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const isText = (value: unknown, min: number, max: number) =>
  typeof value === "string" && value.length >= min && value.length <= max
const isFinite = (value: unknown) => typeof value === "number" && Number.isFinite(value)
const isValue = (value: unknown) =>
  (typeof value === "string" && value.length <= MAX_VALUE_LENGTH) || typeof value === "boolean" || typeof value === "number"

/** The closed set a string setting declares, as choices; undefined for a free value. */
export function closedSet(setting: Pick<Setting, "enum" | "choices">): SettingChoice[] | undefined {
  return setting.choices ?? setting.enum?.map((value) => ({ value }))
}

/** Why Jelly refuses a value saved for this setting, or null when it takes it. The type is checked apart. */
export function settingValueIssue(setting: Setting, value: string | number | boolean): string | null {
  const closed = closedSet(setting)
  if (closed !== undefined && typeof value === "string" && !closed.some((choice) => choice.value === value)) return "not one of the declared values"
  if (typeof value !== "number") return null
  if (setting.integer === true && !Number.isInteger(value)) return "not a whole number"
  if (setting.min !== undefined && value < setting.min) return "below the minimum"
  if (setting.max !== undefined && value > setting.max) return "above the maximum"
  if (setting.step !== undefined) {
    const steps = (value - (setting.min ?? 0)) / setting.step
    if (Math.abs(steps - Math.round(steps)) > 1e-9) return "not on a step"
  }
  return null
}

/** Every rule Jelly applies to `jelly.contributes.settings`, as sentences; empty when Jelly takes the list. */
export function settingsProblems(settings: unknown): string[] {
  if (!Array.isArray(settings)) return ["settings is not a list"]
  const problems = settings.length > 32 ? ["more than 32 settings"] : []
  for (const [index, raw] of settings.entries()) {
    const at = (problem: string) => problems.push(`setting ${index}: ${problem}`)
    if (!isObject(raw)) {
      at("is not an object")
      continue
    }
    for (const key of Object.keys(raw)) if (!SETTING_KEYS.includes(key)) at(`unknown key ${key}`)
    const setting = raw as Setting
    if (typeof setting.key !== "string" || !ID.test(setting.key)) at("key is not an id")
    if (!isText(setting.label, 1, 200)) at("label is not 1 to 200 characters")
    if (!TYPES.includes(setting.type)) at("type is not string, boolean, number or secret")
    if (!isText(setting.description, 0, 1000)) at("description is not up to 1000 characters")
    if (setting.enum !== undefined) {
      if (!Array.isArray(setting.enum) || setting.enum.length < 2 || setting.enum.length > 64) at("enum does not have 2 to 64 values")
      else if (!setting.enum.every((value) => isText(value, 1, 200))) at("an enum value is not 1 to 200 characters")
    }
    if (setting.choices !== undefined) {
      if (!Array.isArray(setting.choices) || setting.choices.length < 2 || setting.choices.length > 64) at("choices does not have 2 to 64 entries")
      else
        for (const choice of setting.choices) {
          if (!isObject(choice)) {
            at("a choice is not an object")
            continue
          }
          for (const key of Object.keys(choice)) if (!CHOICE_KEYS.includes(key)) at(`a choice has the unknown key ${key}`)
          if (!isText(choice.value, 1, 200)) at("a choice value is not 1 to 200 characters")
          if (choice.label !== undefined && !isText(choice.label, 1, 200)) at("a choice label is not 1 to 200 characters")
          if (choice.description !== undefined && !isText(choice.description, 0, 300)) at("a choice description is over 300 characters")
        }
    }
    for (const key of ["min", "max", "step"] as const)
      if (setting[key] !== undefined && !isFinite(setting[key])) at(`${key} is not a finite number`)
    if (setting.step !== undefined && !(setting.step > 0)) at("step is not positive")
    if (setting.integer !== undefined && typeof setting.integer !== "boolean") at("integer is not true or false")
    if (setting.visibleWhen !== undefined) {
      const when = setting.visibleWhen as unknown
      if (!isObject(when) || Object.keys(when).some((key) => key !== "setting" && key !== "equals") || typeof when.setting !== "string" || !ID.test(when.setting) || !isValue(when.equals))
        at("visibleWhen is not { setting, equals }")
    }
    if (setting.default !== undefined) {
      if (!isValue(setting.default)) at("default is not a string, boolean or number")
      if (setting.type === "secret" || typeof setting.default !== setting.type) at("default does not match the type")
    }
    if (setting.enum !== undefined && setting.choices !== undefined) at("declares both enum and choices")
    const closed = Array.isArray(setting.enum) || Array.isArray(setting.choices) ? closedSet(setting) : undefined
    if (closed !== undefined) {
      if (setting.type !== "string") at("a closed set on a type other than string")
      if (new Set(closed.map((choice) => choice.value)).size !== closed.length) at("the closed set repeats a value")
      if (typeof setting.default === "string" && !closed.some((choice) => choice.value === setting.default)) at("default is not in the closed set")
    }
    const bounded = setting.min !== undefined || setting.max !== undefined || setting.step !== undefined || setting.integer !== undefined
    if (bounded && setting.type !== "number") at("min, max, step or integer on a type other than number")
    if (setting.min !== undefined && setting.max !== undefined && setting.min > setting.max) at("min is above max")
    if (typeof setting.default === "number" && settingValueIssue(setting, setting.default) !== null) at("default breaks the bounds")
  }
  return problems
}

/** Jelly's own words for the three `access` values, which every plugin of this family declares verbatim. */
export const ACCESS_CHOICES: SettingChoice[] = [
  { value: "all", label: "Allowed", description: "Every tool runs without asking, reads and changes alike." },
  { value: "ask-changes", label: "Ask before changes", description: "Reads run without asking. Each change asks you first." },
  { value: "read-only", label: "Read only", description: "Reads run. Changes never run." },
]
