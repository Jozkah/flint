// Model sampling defaults and the context window a chat request plans
// against, read from a model's settings. Used by CustomChatTransport.

import { cappedContextWindow } from '@/lib/contextEstimate'
import { usableContextValue } from '@/lib/modelCapabilities'

// Per-model sidebar keys forwarded into each chat-completion request body as
// defaults. These *are* also written into the model's own preset section, so
// this is not the only path -- it exists so a sidebar change applies without
// regenerating the preset and reloading the engine. Assistant `parameters`
// override these in the merge.
export const MODEL_SAMPLING_SETTING_KEYS = [
  'temperature',
  'top_k',
  'top_p',
  'min_p',
  'repeat_last_n',
  'repeat_penalty',
  'presence_penalty',
  'frequency_penalty',
  'seed',
] as const

/** Keys whose upstream handler throws on a negative value. */
export const NON_NEGATIVE_SAMPLING_KEYS = new Set<string>([
  // A negative seed is "random", the same as not sending one.
  'seed',
  'repeat_last_n',
  'dry_penalty_last_n',
])

/**
 * llama.cpp's own defaults for the sampling keys that set the
 * suppress-the-GGUF-recommendation bit. Keys absent here set no bit and are
 * always forwarded.
 */
export const UPSTREAM_SAMPLING_DEFAULTS: Record<string, number> = {
  temperature: 0.8,
  top_k: 40,
  top_p: 0.95,
  min_p: 0.05,
  repeat_last_n: 64,
  repeat_penalty: 1.0,
}

export function extractModelSamplingDefaults(
  model: Model | null | undefined
): Record<string, unknown> {
  if (!model?.settings) return {}
  const out: Record<string, unknown> = {}
  for (const key of MODEL_SAMPLING_SETTING_KEYS) {
    const raw = model.settings[key]?.controller_props?.value
    if (raw === undefined || raw === null || raw === '') continue
    // Sidebar inputs are string-typed even when controller_props.type is
    // 'number'; coerce so the request body matches the OpenAI schema.
    let value: unknown = raw
    if (typeof raw === 'string') {
      const n = Number(raw)
      if (!Number.isFinite(n)) continue
      value = n
    }
    // The server rejects a negative window outright rather than clamping, so a
    // value left over from the old "-1 = full context" UI would 400 every
    // request. Dropping it lets the server's own default apply.
    if (
      NON_NEGATIVE_SAMPLING_KEYS.has(key) &&
      typeof value === 'number' &&
      value < 0
    ) {
      continue
    }
    // Forwarding a value equal to llama.cpp's default is not a no-op: it sets a
    // bit that suppresses the GGUF's own recommended sampling, so an
    // untouched-looking default would silently override what the model asked
    // for. Same rule preset.ts applies.
    if (UPSTREAM_SAMPLING_DEFAULTS[key] === value) continue
    out[key] = value
  }
  // Per-model stop strings (one per line) ride the same request-body path; the
  // model factory turns the text into the wire array. An assistant's own
  // `stop` replaces them (see the merge in the transport).
  const stop = model.settings.stop_strings?.controller_props?.value
  if (typeof stop === 'string' && stop.trim().length > 0) out.stop = stop
  return out
}

/**
 * Per-model chat-template kwargs the user set in the model settings sidebar,
 * stored as an object under `settings.chat_template_kwargs`. Only primitive
 * values are forwarded; `enable_thinking` is owned by the reasoning control
 * and is dropped here.
 */
export function extractModelTemplateKwargs(
  model: Model | null | undefined
): Record<string, boolean | number | string> {
  const raw: unknown =
    model?.settings?.chat_template_kwargs?.controller_props?.value
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, boolean | number | string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'enable_thinking') continue
    const t = typeof value
    if (t === 'boolean' || t === 'number' || t === 'string') {
      out[key] = value as boolean | number | string
    }
  }
  return out
}

/**
 * Whether llama.cpp shifts this model's context when it fills. The model's own
 * setting (`on` / `off`; `auto` or absent means "use global") wins over the
 * engine-wide Context Shift checkbox.
 */
export function resolveContextShift(
  modelSetting: unknown,
  globalSetting: unknown
): boolean {
  if (modelSetting === 'on' || modelSetting === true) return true
  if (modelSetting === 'off' || modelSetting === false) return false
  return globalSetting === true
}

export function effectiveContextWindow(
  configuredContextTokens: number,
  liveContextTokens: number | undefined,
  contextShiftEnabled: boolean
): number {
  const configured = usableContextValue(configuredContextTokens)
  const live = contextShiftEnabled ? usableContextValue(liveContextTokens) : null
  // A runtime window constrains the user's cap; it never enlarges it.
  return cappedContextWindow(configured, live) ?? 0
}
