/**
 * "Reasoning for new chats": the global starting point for the thinking
 * toggle (janhq/jan#8417).
 *
 * Precedence, highest first:
 * 1. the chat's own override (the composer toggle, flipped for this chat);
 * 2. the model's own setting, when it is explicitly On or Off;
 * 3. this global default, when it is On or Off;
 * 4. the model's default behaviour ('model', the shipped default).
 *
 * Applied only to models whose reasoning Flint can actually switch, so a
 * model that cannot turn thinking off is never sent a parameter it rejects.
 *
 * Pure and store-free.
 */
import { effortProfile } from '@/lib/modelEffort'
import { isOverridden, type ModelOverrides } from '@/lib/modelOverrides'

export type ReasoningDefault = 'model' | 'on' | 'off'

export const REASONING_DEFAULTS: readonly ReasoningDefault[] = [
  'model',
  'on',
  'off',
]

export function isReasoningDefault(v: unknown): v is ReasoningDefault {
  return v === 'model' || v === 'on' || v === 'off'
}

/** Providers whose request builders wire the Auto/On/Off `reasoning` setting. */
const REASONING_MODE_PROVIDERS = new Set([
  'llamacpp',
  'google',
  'gemini',
  'anthropic',
  'openai',
])

/**
 * Can Flint switch this model's reasoning on and off? Mirrors the composer's
 * own gating: a first-party provider (minus a local model that does not
 * reason), or any model whose effort profile can disable thinking.
 */
export function canSwitchReasoning(
  providerId: string | null | undefined,
  model: Model | null | undefined
): boolean {
  if (!providerId || !model) return false
  const { levels, canDisable } = effortProfile(providerId, model)
  if (canDisable) return true
  if (!REASONING_MODE_PROVIDERS.has(providerId)) return false
  // A llama.cpp model with no effort bar does not reason (C052).
  return !(providerId === 'llamacpp' && levels.length === 0)
}

/**
 * The chat's overrides with the global default layered underneath, so
 * `resolveModel` sees it. Returns the overrides untouched whenever a higher
 * layer already decides, or the model cannot switch reasoning.
 */
export function withReasoningDefault(
  overrides: ModelOverrides | undefined,
  providerId: string | null | undefined,
  model: Model | null | undefined,
  mode: ReasoningDefault | undefined
): ModelOverrides | undefined {
  if (mode !== 'on' && mode !== 'off') return overrides
  if (isOverridden(overrides, 'reasoning')) return overrides
  const own = model?.settings?.reasoning?.controller_props?.value
  if (own === 'on' || own === 'off') return overrides
  if (!canSwitchReasoning(providerId, model)) return overrides
  return { ...(overrides ?? {}), reasoning: mode }
}
