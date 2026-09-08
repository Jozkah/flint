/**
 * What a model can actually do, resolved once and in one place. AH-195.
 *
 * The context window was permanently "not known" for most local endpoints,
 * because only one field was ever read (`ctx_len`, from Jan's own settings) and
 * an OpenAI-compatible server reports it under any of half a dozen names. The
 * answer was on the wire the whole time.
 *
 * Nothing here reaches the network. Discovery walks sources the app already
 * has, in the order of how much they are worth trusting:
 *
 *   1. what the user set, which is a decision and outranks any discovery;
 *   2. what the provider said about this model;
 *   3. what the local runtime reports for the loaded model;
 *   4. the provider's own default;
 *   5. bundled offline metadata, which ships with the app.
 *
 * An unknown window stays unknown. A guessed number would be worse than none:
 * it is used to decide what fits, and a wrong one silently truncates.
 */

export type CapabilitySource =
  | 'user-override'
  | 'provider-metadata'
  | 'local-runtime'
  | 'provider-default'
  | 'bundled'
  | 'unknown'

export type ModelCapabilities = {
  /**
   * The window in force -- what a request must fit inside.
   *
   * For llama.cpp this is the runtime `n_ctx`, which `--fit` may set far below
   * what the model was trained for. The smaller number is the real limit.
   */
  contextTokens: number | null
  /**
   * What the model was trained to handle, when that is known separately.
   *
   * Kept apart from `contextTokens` so a server running a 32k model in an 8k
   * window can say so, rather than the two being averaged into a fiction.
   */
  trainingMaxTokens: number | null
  source: CapabilitySource
}

export const UNKNOWN_CAPABILITIES: ModelCapabilities = {
  contextTokens: null,
  trainingMaxTokens: null,
  source: 'unknown',
}

/**
 * Every name a server or runtime uses for "the window in force".
 *
 * Order matters only for a payload that carries more than one; the earlier
 * name wins. `max_tokens` is deliberately absent -- it caps the *reply*, and
 * reading it as the window would report an 8k model as a 4k one.
 */
export const CONTEXT_FIELDS = [
  'ctx_len',
  'ctx_size',
  'n_ctx',
  'context_length',
  'max_context_length',
  'max_model_len',
  'context_window',
  'contextLength',
  'contextWindow',
  'nCtx',
] as const

/** Names for what the model was trained with, which is a different fact. */
export const TRAINING_FIELDS = [
  'n_ctx_train',
  'max_position_embeddings',
  'trainingContextLength',
  'nCtxTrain',
] as const

/** A positive integer, however the source spelled it. */
function positiveInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null
  }
  return null
}

/**
 * Read one of `fields` out of a metadata object.
 *
 * Jan's own model settings nest the value under
 * `settings.<key>.controller_props.value`, and a provider's `/models` entry
 * puts it at the top level or one level down under `meta`/`metadata`. Both
 * shapes are searched, because both are things this app is handed.
 */
export function readCapabilityField(
  source: unknown,
  fields: readonly string[]
): number | null {
  if (!source || typeof source !== 'object') return null
  const record = source as Record<string, unknown>

  for (const field of fields) {
    const direct = positiveInteger(record[field])
    if (direct != null) return direct
  }

  const settings = record.settings
  if (settings && typeof settings === 'object') {
    for (const field of fields) {
      const entry = (settings as Record<string, unknown>)[field]
      if (entry && typeof entry === 'object') {
        const props = (entry as Record<string, unknown>).controller_props
        if (props && typeof props === 'object') {
          const value = positiveInteger(
            (props as Record<string, unknown>).value
          )
          if (value != null) return value
        }
      }
      const plain = positiveInteger((settings as Record<string, unknown>)[field])
      if (plain != null) return plain
    }
  }

  for (const nested of ['meta', 'metadata', 'model_info', 'props']) {
    const child = record[nested]
    if (child && typeof child === 'object') {
      const found = readCapabilityField(child, fields)
      if (found != null) return found
    }
  }

  return null
}

/**
 * Offline metadata for families whose window is a published property of the
 * model rather than a choice made by whoever is serving it.
 *
 * Bundled with the app and matched on the model id. This is the last source
 * consulted and the first thing a real answer overrides; it exists so a known
 * model does not read as "not known" before it has been loaded once, not to
 * put a number where there is no evidence.
 */
export const BUNDLED_CONTEXT: readonly { match: RegExp; tokens: number }[] = [
  { match: /qwen ?3|qwen ?2\.5/i, tokens: 32768 },
  { match: /llama ?3\.[123]|llama-3\.[123]/i, tokens: 131072 },
  { match: /llama ?3\b|llama-3\b/i, tokens: 8192 },
  { match: /mistral|mixtral/i, tokens: 32768 },
  { match: /gemma ?[23]/i, tokens: 8192 },
  { match: /phi-?[34]/i, tokens: 16384 },
  { match: /deepseek/i, tokens: 65536 },
]

export function bundledContextFor(modelId: string | null | undefined): number | null {
  if (!modelId) return null
  const entry = BUNDLED_CONTEXT.find((one) => one.match.test(modelId))
  return entry ? entry.tokens : null
}

export type CapabilityInputs = {
  modelId?: string | null
  /** What the user set for this model in Jan. A decision, not a discovery. */
  override?: unknown
  /** The provider's own description of this model. */
  providerMetadata?: unknown
  /** What the loaded local runtime reports. llama.cpp's effective `n_ctx`. */
  localRuntime?: unknown
  /** The provider's default for models it serves. */
  providerDefault?: unknown
  /** Set while a source is still being read, so the UI can say "checking". */
  checking?: boolean
}

/**
 * Resolve one model's capabilities from whatever is known.
 *
 * The effective window and the training maximum are resolved independently:
 * a runtime that reports both is the normal case for llama.cpp, and a provider
 * that reports only the training size should not have it treated as the window
 * in force.
 */
export function resolveModelCapabilities(
  inputs: CapabilityInputs
): ModelCapabilities {
  const ordered: [CapabilitySource, unknown][] = [
    ['user-override', inputs.override],
    ['provider-metadata', inputs.providerMetadata],
    ['local-runtime', inputs.localRuntime],
    ['provider-default', inputs.providerDefault],
  ]

  let contextTokens: number | null = null
  let source: CapabilitySource = 'unknown'
  for (const [name, value] of ordered) {
    const found = readCapabilityField(value, CONTEXT_FIELDS)
    if (found != null) {
      contextTokens = found
      source = name
      break
    }
  }

  if (contextTokens == null) {
    const bundled = bundledContextFor(inputs.modelId)
    if (bundled != null) {
      contextTokens = bundled
      source = 'bundled'
    }
  }

  let trainingMaxTokens: number | null = null
  for (const [, value] of ordered) {
    const found = readCapabilityField(value, TRAINING_FIELDS)
    if (found != null) {
      trainingMaxTokens = found
      break
    }
  }

  return { contextTokens, trainingMaxTokens, source }
}

/** `3,367 / 32,768 tokens`, or null when the window is not known. */
export function formatContextUsage(
  used: number,
  total: number | null | undefined
): string | null {
  if (total == null || total <= 0) return null
  return `${used.toLocaleString()} / ${total.toLocaleString()} tokens`
}

/**
 * `Running in a 8,192 token window; the model supports 32,768.`
 *
 * Only when the two actually differ. A server started with `--fit` on a small
 * machine is the common case, and a user wondering why long files stop fitting
 * deserves to be told which of the two numbers is biting.
 */
export function contextWindowNote(caps: ModelCapabilities): string | null {
  const { contextTokens, trainingMaxTokens } = caps
  if (contextTokens == null || trainingMaxTokens == null) return null
  if (trainingMaxTokens <= contextTokens) return null
  return `Running in a ${contextTokens.toLocaleString()} token window; the model supports ${trainingMaxTokens.toLocaleString()}.`
}
