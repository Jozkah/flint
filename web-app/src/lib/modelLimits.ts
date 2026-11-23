/**
 * Per-model token limits: the context window and the most a model may write in
 * one reply. Both are facts about the model, so they are stored on the model
 * entry (`Model.contextWindow` / `Model.maxOutputTokens`, edited in Edit Model)
 * and read from whichever model a request is about. Switching models in a
 * conversation therefore switches the limits with it.
 *
 * An assistant's own `max_context_tokens` / `max_output_tokens` still work, but
 * only as the fallback for a model that has no value of its own.
 */
import { usableContextValue } from '@/lib/modelCapabilities'

/** Where a stored limit came from, so the UI can say so. Unset = the user typed it. */
export type ModelLimitsSource = 'models.dev'

type ModelLike = object | null | undefined

const field = (model: ModelLike, key: string): unknown =>
  model ? (model as Record<string, unknown>)[key] : undefined

/**
 * The model's context window. Models saved before the field existed kept it in
 * their `max_context_tokens` setting; that is still honoured.
 */
export function modelContextWindow(model: ModelLike): number | null {
  const direct = usableContextValue(field(model, 'contextWindow'))
  if (direct != null) return direct
  const settings = field(model, 'settings') as
    | Record<string, { controller_props?: { value?: unknown } } | undefined>
    | undefined
  const entry = settings?.max_context_tokens
  return usableContextValue(entry?.controller_props?.value)
}

/** The model's own reply cap, or null when none was set. */
export function modelMaxOutputTokens(model: ModelLike): number | null {
  return usableContextValue(field(model, 'maxOutputTokens'))
}

/**
 * Assistant parameters with the model's limits laid over them: a limit the
 * model has wins, one it lacks falls back to the assistant's own value.
 */
export function withModelLimits(
  params: Record<string, unknown>,
  model: ModelLike
): Record<string, unknown> {
  const context = modelContextWindow(model)
  const output = modelMaxOutputTokens(model)
  if (context == null && output == null) return params
  return {
    ...params,
    ...(context != null ? { max_context_tokens: context } : {}),
    ...(output != null ? { max_output_tokens: output } : {}),
  }
}

/**
 * What a model's own entry contributes as the user's decision when its
 * capabilities are resolved: its settings block and its stored window.
 */
export function modelOverride(model: ModelLike): Record<string, unknown> | null {
  const settings = field(model, 'settings')
  const contextWindow = usableContextValue(field(model, 'contextWindow'))
  if (!settings && contextWindow == null) return null
  return {
    ...(settings ? { settings } : {}),
    ...(contextWindow != null ? { contextWindow } : {}),
  }
}

/** A model entry less its settings block: what the provider said about it. */
export function modelMetadata<T extends object>(model: T): Omit<T, 'settings'> {
  const copy = { ...model } as Record<string, unknown>
  delete copy.settings
  return copy as Omit<T, 'settings'>
}
