/**
 * Find out how big the selected model's context window is, so the Max Context
 * Tokens field can be filled with a real number instead of a guess.
 *
 * Sources, in the order they are asked. Everything the app already holds comes
 * first because it costs nothing, then the endpoint itself, and the bundled
 * family table last because it is a statement about a model family, not about
 * the server in front of you:
 *
 *   1. what a server said when it refused a request for being too long;
 *   2. the loaded llama.cpp / MLX runtime's `n_ctx` (`/props`);
 *   3. the context size set for the model in Flint;
 *   4. what the provider's model entry already in the app says;
 *   5. the provider's live `/models` entry (OpenAI-compatible remotes);
 *   6. a local custom server's `/props` or vLLM `max_model_len`;
 *   7. the bundled table.
 *
 * Nothing is invented. When no source answers the result says so and why.
 */
import {
  CONTEXT_FIELDS,
  bundledContextFor,
  readCapabilityField,
  usableContextValue,
} from '@/lib/modelCapabilities'
import { serverReportedLimit } from '@/lib/contextLimitRecovery'
import { parseServerWindow } from '@/lib/serverWindow'

export type ContextSource =
  | 'server-response'
  | 'local-runtime'
  | 'model-settings'
  | 'provider-metadata'
  | 'provider-list'
  | 'local-server'
  | 'bundled'

export type DetectResult =
  | { tokens: number; source: ContextSource }
  | { unknown: true; reason: string }

/** Names a provider's model entry uses for the input window. */
export const ENTRY_CONTEXT_FIELDS = [
  ...CONTEXT_FIELDS,
  'max_input_tokens',
  'input_token_limit',
  'inputTokenLimit',
  'max_input_length',
] as const

/**
 * The window out of one provider model entry, or null.
 *
 * Reads the usual top-level names, the same names under `meta`/`metadata`/
 * `model_info`, and OpenRouter's `top_provider.context_length`. `max_tokens`
 * and `max_output_tokens` are never read: they cap the reply, not the window.
 */
export function contextFromModelEntry(entry: unknown): number | null {
  if (!entry || typeof entry !== 'object') return null
  const direct = readCapabilityField(entry, ENTRY_CONTEXT_FIELDS)
  if (direct != null) return direct
  const top = (entry as Record<string, unknown>).top_provider
  if (top && typeof top === 'object') {
    return usableContextValue((top as Record<string, unknown>).context_length)
  }
  return null
}

/**
 * The entry for `modelId` in a `/models` payload (`{ data: [...] }`,
 * `{ models: [...] }` or a bare array). When the list holds a single entry and
 * nothing matches by name, that entry is used; with several entries and no
 * match the answer is null rather than another model's entry.
 */
export function findModelEntry(
  payload: unknown,
  modelId: string | null | undefined
): Record<string, unknown> | null {
  if (!payload) return null
  const record = payload as Record<string, unknown>
  const lists = Array.isArray(payload)
    ? [payload as unknown[]]
    : ([record.data, record.models].filter(Array.isArray) as unknown[][])
  const entries: Record<string, unknown>[] = []
  for (const list of lists) {
    for (const item of list) {
      if (item && typeof item === 'object') {
        entries.push(item as Record<string, unknown>)
      }
    }
  }
  const named = (e: Record<string, unknown>) =>
    [e.id, e.model, e.name].some((v) => typeof v === 'string' && v === modelId)
  const hit = modelId ? entries.find(named) : undefined
  if (hit) return hit
  return entries.length === 1 ? entries[0] : null
}

/**
 * The window out of a llama.cpp / MLX props answer, in either spelling: the
 * extension's `{ nCtx }` or the server's raw `/props` body.
 */
export function contextFromProps(props: unknown): number | null {
  if (!props || typeof props !== 'object') return null
  const body = props as Record<string, unknown>
  return usableContextValue(body.nCtx) ?? parseServerWindow(body)
}

export type DetectInputs = {
  providerId: string
  modelId: string
  /** The model as the app holds it (settings block plus provider metadata). */
  model?: ({ id?: string | null } & Record<string, unknown>) | null
  /** The provider as the app holds it. */
  provider?: ({ provider?: string; base_url?: string } & Record<string, unknown>) | null
  /** Props of a loaded local runtime, when the provider has one. */
  getRuntimeProps?: (providerId: string, modelId: string) => Promise<unknown>
  /** The live `/models` entry for the model, for remote providers. */
  fetchModelEntry?: (modelId: string) => Promise<unknown>
  /** A local custom server's window (`/props`, vLLM `/models`). */
  fetchLocalServerWindow?: (
    baseUrl: string | null | undefined,
    modelId: string
  ) => Promise<number | null>
}

const LOCAL_RUNTIME_PROVIDERS = new Set(['llamacpp', 'mlx'])

async function attempt<T>(run: (() => Promise<T>) | undefined): Promise<T | null> {
  if (!run) return null
  try {
    return await run()
  } catch {
    // A source that cannot answer is the same as one that has no answer.
    return null
  }
}

export async function detectContextWindow(
  inputs: DetectInputs
): Promise<DetectResult> {
  const { providerId, modelId, model, provider } = inputs
  if (!modelId) {
    return { unknown: true, reason: 'No model is selected.' }
  }
  const baseUrl = provider?.base_url ?? ''
  const found = (tokens: number | null, source: ContextSource): DetectResult | null =>
    tokens != null ? { tokens, source } : null

  // 1. A refusal from this very endpoint.
  const learned = serverReportedLimit({
    provider: providerId,
    baseUrl,
    model: modelId,
  })
  const fromRefusal = found(
    learned ? usableContextValue(learned.contextTokens) : null,
    'server-response'
  )
  if (fromRefusal) return fromRefusal

  // 2. The runtime that has the model loaded.
  if (LOCAL_RUNTIME_PROVIDERS.has(providerId)) {
    const props = await attempt(
      inputs.getRuntimeProps && (() => inputs.getRuntimeProps!(providerId, modelId))
    )
    const fromRuntime = found(contextFromProps(props), 'local-runtime')
    if (fromRuntime) return fromRuntime
  }

  // 3. The size set for the model in Flint, then 4. what the provider said.
  const { settings, ...metadata } = (model ?? {}) as Record<string, unknown>
  const fromSettings = found(
    settings ? readCapabilityField({ settings }, CONTEXT_FIELDS) : null,
    'model-settings'
  )
  if (fromSettings) return fromSettings
  const fromMetadata = found(contextFromModelEntry(metadata), 'provider-metadata')
  if (fromMetadata) return fromMetadata

  // 5. The provider's live model list. Local runtimes answer above.
  if (!LOCAL_RUNTIME_PROVIDERS.has(providerId) && baseUrl) {
    const entry = await attempt(
      inputs.fetchModelEntry && (() => inputs.fetchModelEntry!(modelId))
    )
    const fromList = found(contextFromModelEntry(entry), 'provider-list')
    if (fromList) return fromList

    // 6. A server on this machine or network that has its own props route.
    const fromServer = found(
      await attempt(
        inputs.fetchLocalServerWindow &&
          (() => inputs.fetchLocalServerWindow!(baseUrl, modelId))
      ),
      'local-server'
    )
    if (fromServer) return fromServer
  }

  // 7. The bundled family table.
  const fromTable = found(bundledContextFor(modelId), 'bundled')
  if (fromTable) return fromTable

  return {
    unknown: true,
    reason: LOCAL_RUNTIME_PROVIDERS.has(providerId)
      ? 'The model is not loaded and no context size is set for it.'
      : 'The provider does not report a context window for this model.',
  }
}
