/**
 * Per-chat model settings, layered over the global model configuration.
 *
 * A chat stores only what it actually changed — one entry per overridden
 * setting, holding the *value* and nothing else. It never stores a copy of the
 * global configuration, so a chat opened today and used again next month still
 * inherits whatever the global defaults have become, for every setting it did
 * not deliberately change. Copying the resolved settings into each chat would
 * freeze that month-old default in place and quietly diverge from Settings.
 *
 * Pure and store-free: the precedence rules are testable without React.
 */


/**
 * A model setting's value, as its controller carries it.
 *
 * Derived from the controller type rather than restated, so a change there is
 * a compile error here instead of a silent mismatch.
 */
export type ModelSettingValue = NonNullable<
  Model['settings']
>[string]['controller_props']['value']

/**
 * One chat's overrides: setting key to the value that chat chose.
 *
 * Sparse by construction. A key that is absent is not "unset" — it means this
 * chat has no opinion, and the global value applies.
 */
export type ModelOverrides = Record<string, ModelSettingValue>

export const NO_OVERRIDES: ModelOverrides = Object.freeze({})

/** Has this chat overridden anything at all? */
export function hasOverrides(overrides: ModelOverrides | undefined): boolean {
  return !!overrides && Object.keys(overrides).length > 0
}

export function isOverridden(
  overrides: ModelOverrides | undefined,
  key: string
): boolean {
  return !!overrides && Object.prototype.hasOwnProperty.call(overrides, key)
}

/** The keys this chat has an opinion about, for a "what did I change" view. */
export function overriddenKeys(overrides: ModelOverrides | undefined): string[] {
  return overrides ? Object.keys(overrides).sort() : []
}

/**
 * Record an override.
 *
 * Setting a key to the value the global configuration already has still counts
 * as an override: the user asked this chat for that value, and it should hold
 * even if the global default later moves.
 */
export function setOverride(
  overrides: ModelOverrides | undefined,
  key: string,
  value: ModelSettingValue
): ModelOverrides {
  return { ...(overrides ?? {}), [key]: value }
}

/** Give one setting back to the global default. */
export function clearOverride(
  overrides: ModelOverrides | undefined,
  key: string
): ModelOverrides {
  if (!isOverridden(overrides, key)) return overrides ?? NO_OVERRIDES
  const next = { ...overrides }
  delete next[key]
  return next
}

/** Give every setting back to the global defaults. */
export function clearAllOverrides(): ModelOverrides {
  return {}
}

/**
 * What this chat will actually use for one setting.
 *
 * The chat's value when it has one, the global value otherwise.
 */
export function effectiveValue(
  model: Model | null | undefined,
  overrides: ModelOverrides | undefined,
  key: string
): ModelSettingValue {
  if (isOverridden(overrides, key)) return overrides![key]
  return model?.settings?.[key]?.controller_props?.value
}

/**
 * The model as this chat sees it: global configuration with the chat's
 * overrides applied.
 *
 * Returns the same model reference when the chat has overridden nothing, so
 * the common case allocates nothing and callers can compare by identity.
 *
 * Only the `value` inside each setting is replaced. Everything else about a
 * setting — its title, its controller type, its bounds — belongs to the model's
 * own definition, and a chat has no business carrying a stale copy of it. An
 * override naming a setting this model does not define is ignored rather than
 * invented: the model changed, and a control that no longer exists cannot be
 * set.
 */
export function resolveModel<T extends Model>(
  model: T,
  overrides: ModelOverrides | undefined
): T
export function resolveModel<T extends Model>(
  model: T | null | undefined,
  overrides: ModelOverrides | undefined
): T | null | undefined
export function resolveModel<T extends Model>(
  model: T | null | undefined,
  overrides: ModelOverrides | undefined
): T | null | undefined {
  if (!model || !hasOverrides(overrides)) return model

  const settings = model.settings
  if (!settings) return model

  let next: typeof settings | null = null
  for (const [key, value] of Object.entries(overrides!)) {
    const existing = settings[key]
    // The model no longer defines this setting; there is nothing to override.
    if (!existing) continue
    if (existing.controller_props?.value === value) continue
    if (!next) next = { ...settings }
    next[key] = {
      ...existing,
      controller_props: { ...(existing.controller_props ?? {}), value },
    }
  }
  return next ? ({ ...model, settings: next } as T) : model
}

/**
 * Drop overrides the model no longer defines.
 *
 * Called when a chat's model changes: an override for a setting the new model
 * does not have would sit in the record forever, invisible and inert, and
 * would spring back to life if the old model ever returned.
 */
export function pruneOverrides(
  model: Model | null | undefined,
  overrides: ModelOverrides | undefined
): ModelOverrides {
  if (!hasOverrides(overrides)) return overrides ?? NO_OVERRIDES
  const settings = model?.settings
  if (!settings) return overrides!
  const kept = Object.fromEntries(
    Object.entries(overrides!).filter(([key]) => key in settings)
  )
  return Object.keys(kept).length === Object.keys(overrides!).length
    ? overrides!
    : kept
}
