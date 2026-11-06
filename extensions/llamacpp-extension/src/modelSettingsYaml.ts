import { logger } from '@janhq/core'
import { getBackendSetting } from './backend-settings'

export type YamlSettingValue = string | number | boolean | null

type PersistedProviderSetting = {
  controller_props?: {
    value?: unknown
  }
}

type PersistedModelState = {
  id?: unknown
  settings?: Record<string, PersistedProviderSetting>
}

const MODEL_PROVIDER_STORE_KEY = 'model-provider'

/**
 * fetch with a deadline for the response headers. A deadline hit rejects with
 * `Request timed out`; an abort from `external` keeps its own reason.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms: number,
  external?: AbortSignal
): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('Request timed out'))
  }, ms)
  const onExternal = () => controller.abort(external?.reason)
  if (external) {
    if (external.aborted) controller.abort(external.reason)
    else external.addEventListener('abort', onExternal, { once: true })
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (e) {
    if (timedOut) throw new Error('Request timed out')
    throw e
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onExternal)
  }
}

// Sampling defaults are floats/ints where 0 is a meaningful value (e.g.
// temperature=0), so unlike ctx_len these coercions keep 0 and only reject
// blank/non-finite input.
const coerceFloatSetting = (v: unknown): YamlSettingValue => {
  if (v === '' || v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
const coerceIntSetting = (v: unknown): YamlSettingValue => {
  if (v === '' || v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.floor(n) : null
}

const KV_CACHE_TYPE_SETTINGS = new Set([
  'f32',
  'f16',
  'bf16',
  'q8_0',
  'q4_0',
  'q4_1',
  'iq4_nl',
  'q5_0',
  'q5_1',
])
const coerceKvCacheTypeSetting = (v: unknown): YamlSettingValue =>
  typeof v === 'string' && KV_CACHE_TYPE_SETTINGS.has(v.trim().toLowerCase())
    ? v.trim().toLowerCase()
    : null

export const MODEL_SETTINGS_YAML_MAPPING: Record<
  string,
  {
    yamlKey: string
    coerce: (v: unknown) => YamlSettingValue
  }
> = {
  // Sampling defaults: persisted to model.yml and emitted into the router
  // preset so they apply server-side to every request (chat and external API),
  // overridable per-request. Keys mirror MODEL_SAMPLING_SETTING_KEYS in the
  // web-app transport.
  temperature: { yamlKey: 'temperature', coerce: coerceFloatSetting },
  top_k: { yamlKey: 'top_k', coerce: coerceIntSetting },
  top_p: { yamlKey: 'top_p', coerce: coerceFloatSetting },
  min_p: { yamlKey: 'min_p', coerce: coerceFloatSetting },
  // Not coerceIntSetting: upstream throws on a negative window on both the
  // preset path and the per-request path, so a legacy -1 from the old
  // "-1 = full context" UI has to be dropped, not passed through. Omitting the
  // key lets upstream's own default (64) apply.
  repeat_last_n: {
    yamlKey: 'repeat_last_n',
    coerce: (v) => {
      if (v === '' || v == null) return null
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
    },
  },
  repeat_penalty: { yamlKey: 'repeat_penalty', coerce: coerceFloatSetting },
  presence_penalty: { yamlKey: 'presence_penalty', coerce: coerceFloatSetting },
  frequency_penalty: {
    yamlKey: 'frequency_penalty',
    coerce: coerceFloatSetting,
  },
  // Fixed seed. A negative value means "random" upstream, so it is dropped.
  seed: {
    yamlKey: 'seed',
    coerce: (v) => {
      if (v === '' || v == null) return null
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isInteger(n) && n >= 0 ? n : null
    },
  },
  ctx_len: {
    yamlKey: 'ctx_size',
    coerce: (v) => {
      if (v === '' || v == null) return null
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
    },
  },
  ngl: {
    yamlKey: 'n_gpu_layers',
    coerce: (v) => {
      if (v === '' || v == null) return null
      const n = typeof v === 'number' ? v : Number(v)
      // -1 is auto (VRAM-aware) and -2 or below means all layers, so the floor
      // is -2 rather than 0.
      return Number.isFinite(n) && n >= -2 ? Math.floor(n) : null
    },
  },
  chat_template: {
    yamlKey: 'chat_template',
    coerce: (v) =>
      typeof v === 'string' && v.trim().length > 0 ? v : null,
  },
  grammar: {
    yamlKey: 'grammar',
    coerce: (v) =>
      typeof v === 'string' && v.trim().length > 0 ? v : null,
  },
  batch_size: {
    yamlKey: 'batch_size',
    coerce: (v) => {
      if (v === '' || v == null) return null
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
    },
  },
  ubatch_size: {
    yamlKey: 'ubatch_size',
    coerce: (v) => {
      if (v === '' || v == null) return null
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
    },
  },
  cpu_moe: {
    yamlKey: 'cpu_moe',
    coerce: (v) => (v === true ? true : null),
  },
  n_cpu_moe: {
    yamlKey: 'n_cpu_moe',
    coerce: (v) => {
      if (v === '' || v == null) return null
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
    },
  },
  n_cpu_ffn: {
    yamlKey: 'n_cpu_ffn',
    coerce: (v) => {
      if (v === '' || v == null) return null
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
    },
  },
  no_kv_offload: {
    yamlKey: 'no_kv_offload',
    coerce: (v) => (v === true ? true : null),
  },
  // Per-model overrides of the global setting. `auto` / empty means "inherit the
  // global one", so it is dropped rather than written as a value that would pin
  // the model to the auto default.
  ctx_shift: {
    yamlKey: 'ctx_shift',
    coerce: (v) =>
      v === 'on' || v === true ? true : v === 'off' || v === false ? false : null,
  },
  cache_type_k: {
    yamlKey: 'cache_type_k',
    coerce: coerceKvCacheTypeSetting,
  },
  cache_type_v: {
    yamlKey: 'cache_type_v',
    coerce: coerceKvCacheTypeSetting,
  },
  override_tensor_buffer_t: {
    yamlKey: 'override_tensor',
    coerce: (v) =>
      typeof v === 'string' && v.trim().length > 0 ? v.trim() : null,
  },
  offload_mmproj: {
    yamlKey: 'mmproj_offload',
    coerce: (v) => (v === false ? false : null),
  },
  // Server-side default for the reasoning toggle (llama-server `--reasoning`),
  // so API clients get the same behavior as the chat UI. `auto` leaves it unset.
  server_reasoning: {
    yamlKey: 'reasoning',
    coerce: (v) => (v === 'on' || v === 'off' ? v : null),
  },
  // Free-form llama-server options for this model only (e.g. --cache-type-k
  // turbo3). Written after every other option in the preset.
  model_extra_args: {
    yamlKey: 'extra_args',
    coerce: (v) =>
      typeof v === 'string' && v.trim().length > 0 ? v.trim() : null,
  },
}

export async function readPersistedLlamacppModels(): Promise<PersistedModelState[]> {
  try {
    const raw = await getBackendSetting(MODEL_PROVIDER_STORE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    const providers = parsed?.state?.providers
    if (!Array.isArray(providers)) return []
    const llamacpp = providers.find(
      (provider: { provider?: unknown }) => provider?.provider === 'llamacpp'
    )
    return Array.isArray(llamacpp?.models) ? llamacpp.models : []
  } catch (error) {
    logger.warn('Failed to read persisted llamacpp model settings:', error)
    return []
  }
}
