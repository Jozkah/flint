/**
 * Model Factory
 *
 * This factory provides a unified interface for creating language models from various providers.
 * It handles the complexity of initializing different AI SDK providers with their specific
 * configurations and returns a standard LanguageModel interface.
 *
 * Supported Providers:
 * - llamacpp: Local models via llama.cpp (requires running session)
 * - mlx: Local models via MLX-Swift on Apple Silicon (requires running session)
 * - anthropic: Claude models via Anthropic API (@ai-sdk/anthropic v2.0)
 * - google/gemini: Gemini models via Google Generative AI API (@ai-sdk/google v2.0)
 * - openai: OpenAI models via OpenAI API (@ai-sdk/openai)
 * - OpenAI-compatible: Azure, Groq, Together, Fireworks, DeepSeek, Mistral, Cohere, etc.
 *
 * Usage:
 * ```typescript
 * const model = await ModelFactory.createModel(modelId, provider, parameters)
 * ```
 *
 * The factory automatically:
 * - Handles provider-specific authentication and headers
 * - Manages llamacpp session discovery and connection
 * - Configures custom headers for each provider
 * - Returns a unified LanguageModel interface compatible with Vercel AI SDK
 */

/**
 * Inference parameters for customizing model behavior
 */
export interface ModelParameters {
  temperature?: number
  top_k?: number
  top_p?: number
  repeat_penalty?: number
  max_output_tokens?: number
  max_context_tokens?: number
  auto_compact?: boolean
  presence_penalty?: number
  frequency_penalty?: number
  stop_sequences?: string[]
}

import { withOpenRouterReasoningDetails } from '@/lib/openrouterReasoningDetails'
import { withOpenRouterOptions } from '@/lib/openrouterRequestOptions'
import {
  ImageTap,
  imageOutputMiddleware,
  withImageTap,
} from '@/lib/openrouterImages'
import {
  extractReasoningMiddleware,
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import {
  createOpenAICompatible,
  MetadataExtractor,
  OpenAICompatibleChatLanguageModel,
  OpenAICompatibleCompletionLanguageModel,
} from '@ai-sdk/openai-compatible'
import { ModelCapabilities } from '@/types/models'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createXai } from '@ai-sdk/xai'
import { createMistral } from '@ai-sdk/mistral'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock'
import {
  DEFAULT_BEDROCK_BASE_URL,
  bedrockRegion,
  createBedrockSigningFetch,
} from '@/lib/bedrock'
import { invokeCommand as invoke } from '@/lib/backend'
import { findSessionByModel } from '@janhq/tauri-plugin-llamacpp-api'
import { SessionInfo } from '@janhq/core'
import { providerFetch } from '@/lib/providerFetch'
import { isServerTransport } from '@/lib/serverTransportFlag'
import { textToolCallMiddleware } from '@/lib/textToolCallMiddleware'

// These three call sites predate the canonical transport and named the raw
// Tauri fetch; they are the same transport now, under the name they used.
const httpFetch = providerFetch
import { isPlatformTauri } from '@/lib/platform/utils'
import { providerRemoteApiKeyChain } from '@/lib/provider-api-keys'
import { paramsSettings } from '@/lib/predefinedParams'
import {
  resolveProviderCaps,
  isModelLevelRejected,
  getMutualExclusionDrops,
  getProviderApiType,
} from '@/lib/providerCaps'
import { engineFailure } from '@/lib/engineError'
import { withMlxCrashReport } from '@/lib/mlxCrash'
import { i18n } from '@/i18n/react-i18next-compat'
import { useAppState } from '@/hooks/useAppState'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { ensureAnthropicHeaders } from '@/lib/anthropicHeaders'
import { emptyTextMiddleware } from '@/lib/emptyTextMiddleware'
import { applyCustomHeaders } from '@/lib/customHeaders'
import { createCustomFetch } from '@/lib/model/customFetch'
import { createApiKeyRotatingFetch } from '@/lib/model/keyRotation'
import {
  DISPATCH_PARAM_KEY,
  dispatchOnly,
  filterParameters,
  stripAssistantReasoningInBody,
} from '@/lib/model/requestBody'
export { createCustomFetch } from '@/lib/model/customFetch'
export { createApiKeyRotatingFetch } from '@/lib/model/keyRotation'
export {
  DISPATCH_HEADERS,
  DISPATCH_PARAM_KEY,
  type DispatchIdentity,
  decodeAudioSentinelsInBody,
  decodeToolImageSentinelsInBody,
  decodeVideoSentinelsInBody,
  reconcileConstraintParams,
  stripAssistantReasoningInBody,
} from '@/lib/model/requestBody'
export {
  cleanUpstreamErrorMessage,
  describeTransportError,
  isSamplingParamRejection,
} from '@/lib/model/transportErrors'

/**
 * Llama.cpp timings structure from the response
 */
interface LlamaCppTimings {
  prompt_n?: number
  predicted_n?: number
  predicted_per_second?: number
  prompt_per_second?: number
  cache_n?: number
  // Speculative decoding: tokens a draft proposed, and how many the model kept.
  draft_n?: number
  draft_n_accepted?: number
}

// prompt_n only counts tokens freshly processed this turn; tokens served from
// the KV cache (the rest of the conversation) are reported separately in
// cache_n, so total prompt/context usage is the sum of both.
const totalPromptTokens = (timings: LlamaCppTimings): number =>
  (timings.prompt_n ?? 0) + (timings.cache_n ?? 0)

// The engine's own cache count, only when it sent one. An engine that reports
// no `cache_n` has said nothing about its cache, which is not the same as
// "nothing was cached"; see lib/tokenUsage.ts.
const cacheTokensOf = (timings: LlamaCppTimings): { cacheTokens?: number } =>
  typeof timings.cache_n === 'number' && Number.isFinite(timings.cache_n)
    ? { cacheTokens: timings.cache_n }
    : {}

// Only when a draft ran this turn; an engine without speculative decoding sends
// neither field, and a turn with none proposed says nothing about acceptance.
const draftOf = (
  timings: LlamaCppTimings
): { draftTokens?: number; draftAccepted?: number } =>
  typeof timings.draft_n === 'number' &&
  timings.draft_n > 0 &&
  typeof timings.draft_n_accepted === 'number'
    ? { draftTokens: timings.draft_n, draftAccepted: timings.draft_n_accepted }
    : {}

const timingsMetadata = (timings: LlamaCppTimings) => ({
  providerMetadata: {
    promptTokens: totalPromptTokens(timings),
    completionTokens: timings.predicted_n ?? null,
    tokensPerSecond: timings.predicted_per_second ?? null,
    promptPerSecond: timings.prompt_per_second ?? null,
    ...cacheTokensOf(timings),
    ...draftOf(timings),
  },
})

interface LlamaCppPromptProgress {
  total?: number
  cache?: number
  processed?: number
  time_ms?: number
}

interface LlamaCppChunk {
  timings?: LlamaCppTimings
  prompt_progress?: LlamaCppPromptProgress
}

/**
 * Custom metadata extractor for MLX that extracts timing information
 * and converts it to token usage format. MLX uses the same timing structure
 * as llama.cpp.
 */
const createProviderMetadataExtractor = (
  streamThreadId?: string
): MetadataExtractor => ({
  extractMetadata: async ({ parsedBody }: { parsedBody: unknown }) => {
    const body = parsedBody as LlamaCppChunk
    if (body?.timings) return timingsMetadata(body.timings)
    return undefined
  },
  createStreamExtractor: () => {
    let lastTimings: LlamaCppTimings | undefined

    return {
      processChunk: (parsedChunk: unknown) => {
        const chunk = parsedChunk as LlamaCppChunk
        const state = useAppState.getState()
        // The legacy global fields mirror only the stream the user is looking
        // at; the per-thread ones always belong to this stream's own thread.
        const isCurrentStream =
          !!streamThreadId && state.currentStreamThreadId === streamThreadId
        if (isCurrentStream && state.loadingModel) {
          state.updateLoadingModel(false)
        }
        if (streamThreadId) {
          state.updateThreadLoadingModel(streamThreadId, false)
        }
        if (chunk?.timings) {
          // Cumulative per chunk: the latest snapshot replaces the last one,
          // it is never added to it.
          lastTimings = chunk.timings
          const cache = cacheTokensOf(lastTimings)
          const liveStats = {
            promptTokens: totalPromptTokens(lastTimings),
            completionTokens: lastTimings.predicted_n ?? 0,
            tokensPerSecond: lastTimings.predicted_per_second ?? null,
            promptPerSecond: lastTimings.prompt_per_second ?? null,
            ...(cache.cacheTokens !== undefined
              ? { cachedPromptTokens: cache.cacheTokens }
              : {}),
          }
          if (isCurrentStream) state.updateLiveTokenStats(liveStats)
          if (streamThreadId) {
            state.updateThreadLiveTokenStats(streamThreadId, liveStats)
          }
        }
        const pp = chunk?.prompt_progress
        if (
          pp &&
          typeof pp.total === 'number' &&
          typeof pp.processed === 'number'
        ) {
          const progress = {
            total: pp.total,
            processed: pp.processed,
            cache: pp.cache ?? 0,
            time_ms: pp.time_ms ?? 0,
          }
          if (isCurrentStream) state.updatePromptProgress(progress)
          if (streamThreadId) {
            state.updateThreadPromptProgress(streamThreadId, progress)
          }
        }
      },
      buildMetadata: () =>
        lastTimings ? timingsMetadata(lastTimings) : undefined,
    }
  },
})

/** The llama.cpp/MLX extractor, for tests that drive a real provider model. */
export const __llamacppExtractorForTests = createProviderMetadataExtractor()
/** Builds the extractor for one thread's stream, for tests. */
export const __createLlamacppExtractorForTests = createProviderMetadataExtractor

/**
 * Strip sampler params the active provider doesn't accept. Built-in providers
 * with strict capability tables (e.g. real OpenAI rejecting `top_k`) drop the
 * unsupported keys here so the wire request never carries them. Custom/permissive
 * providers keep everything — the user opted into an unknown OAI-compat endpoint.
 *
 * Unknown keys (not in paramsSettings) pass through untouched so non-sampler
 * fields like reasoning controls aren't affected.
 */
function stripUnsupportedSamplers(
  parameters: Record<string, unknown>,
  provider: ProviderObject,
  modelId: string
): Record<string, unknown> {
  const caps = resolveProviderCaps(provider)
  const exclusionDrops = getMutualExclusionDrops(
    parameters,
    provider.provider,
    getProviderApiType(provider)
  )
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parameters)) {
    if (exclusionDrops.has(k)) continue
    if (isModelLevelRejected(k, provider.provider, modelId)) continue
    const def = paramsSettings[k]
    if (!def) {
      out[k] = v
      continue
    }
    if (def.capability === 'client_only') {
      out[k] = v
      continue
    }
    if (def.capability === 'core') {
      out[k] = v
      continue
    }
    if (caps.supported.has(def.capability) || caps.maybe.has(def.capability)) {
      out[k] = v
    }
  }
  return out
}

/**
 * Maps the OpenAI-shaped sampling params onto the AI SDK call settings, which
 * the Bedrock client turns into the Converse `inferenceConfig` before the body
 * is built and signed. `seed` (and top_k etc.) have no Converse equivalent and
 * are ignored. Settings the caller already set (e.g. maxOutputTokens from the
 * transport) win.
 */
export function bedrockSamplingMiddleware(
  parameters: Record<string, unknown>
): LanguageModelMiddleware {
  const num = (v: unknown): number | undefined => {
    const n =
      typeof v === 'string' && v.trim() !== '' ? Number(v) : (v as number)
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined
  }
  const temperature = num(parameters.temperature)
  const topP = num(parameters.top_p)
  const maxTokens = num(parameters.max_output_tokens ?? parameters.max_tokens)
  const rawStop = parameters.stop_sequences ?? parameters.stop
  const stop = (
    typeof rawStop === 'string'
      ? rawStop.split(/\r?\n/)
      : Array.isArray(rawStop)
        ? rawStop
        : []
  ).filter((s): s is string => typeof s === 'string' && s.length > 0)
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => ({
      ...params,
      temperature: params.temperature ?? temperature,
      topP: params.topP ?? topP,
      maxOutputTokens:
        params.maxOutputTokens ??
        (maxTokens !== undefined && maxTokens > 0 ? maxTokens : undefined),
      stopSequences:
        params.stopSequences ?? (stop.length > 0 ? stop : undefined),
    }),
  } as LanguageModelMiddleware
}

function isOpenRouterProvider(
  provider: Pick<ProviderObject, 'provider' | 'base_url'>
): boolean {
  if (provider.provider === 'openrouter') return true
  try {
    return new URL(provider.base_url || '').hostname.toLowerCase() === 'openrouter.ai'
  } catch {
    return false
  }
}

/**
 * Azure OpenAI: the v1 endpoint takes Bearer, but legacy deployments-style
 * endpoints (`/openai/deployments/<name>?api-version=...`) only accept the
 * `api-key` header. janhq/jan#451.
 */
export function isAzureOpenAIProvider(
  provider: Pick<ProviderObject, 'provider' | 'base_url'>
): boolean {
  if (provider.provider === 'azure') return true
  try {
    const host = new URL(provider.base_url || '').hostname.toLowerCase()
    return (
      host.endsWith('.openai.azure.com') ||
      host.endsWith('.services.ai.azure.com')
    )
  } catch {
    return false
  }
}

/**
 * Moves a `?api-version=...` typed into the base URL into `queryParams`, so
 * appending `/chat/completions` does not land after the query string.
 */
export function splitBaseUrlQuery(baseUrl: string): {
  baseURL: string
  queryParams?: Record<string, string>
} {
  try {
    const url = new URL(baseUrl)
    if (!url.search) return { baseURL: baseUrl }
    const queryParams: Record<string, string> = {}
    url.searchParams.forEach((v, k) => {
      queryParams[k] = v
    })
    return {
      baseURL: `${url.origin}${url.pathname}`.replace(/\/+$/, ''),
      queryParams,
    }
  } catch {
    return { baseURL: baseUrl }
  }
}

/**
 * The `api-version` an Azure provider's settings carry, for legacy
 * deployments-style endpoints whose URL does not name one. Blank when unset.
 */
export function azureApiVersionSetting(
  provider: Pick<ProviderObject, 'settings'>
): string {
  const setting = provider.settings?.find((s) => s.key === 'api-version')
  const value = (setting?.controller_props as { value?: unknown } | undefined)
    ?.value
  return typeof value === 'string' ? value.trim() : ''
}

/** Reads the global "Strip reasoning from context" toggle; defaults to false. */
function shouldStripReasoningFromContext(): boolean {
  return useGeneralSetting.getState().stripReasoningFromContext === true
}

/**
 * A local llama.cpp model "preserves reasoning" when its chat template accepts
 * a `preserve_thinking` kwarg that is on (user-set value, else the GGUF-detected
 * default). Such templates re-emit prior `<think>` from the resent
 * `reasoning_content`, so stripping that field would shrink earlier assistant
 * turns and force llama.cpp to reprocess the KV-cache prefix. When true, the
 * reasoning must be resent even if the global strip toggle is on.
 */
export function modelPreservesReasoning(
  provider: ProviderObject | undefined,
  modelId: string
): boolean {
  const model = provider?.models?.find((m) => m.id === modelId)
  if (!model) return false
  const raw: unknown =
    model.settings?.chat_template_kwargs?.controller_props?.value
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const v = (raw as Record<string, unknown>).preserve_thinking
    if (typeof v === 'boolean') return v
  }
  return (
    model.template_kwargs?.find((k) => k.name === 'preserve_thinking')
      ?.default === true
  )
}

/** Wraps `inner` to strip reasoning fields from assistant messages before send. */
function withAssistantReasoningStripped(
  inner: typeof globalThis.fetch
): typeof globalThis.fetch {
  return async (input, init) => {
    if ((init?.method === 'POST' || !init?.method) && init?.body) {
      try {
        const body = JSON.parse(init.body as string)
        stripAssistantReasoningInBody(body)
        init = { ...init, body: JSON.stringify(body) }
      } catch {
        // non-JSON body; fall through
      }
    }
    return inner(input, init)
  }
}

// An empty apiKey still puts an empty auth header on the wire, which upstreams
// answer with misleading 401s (e.g. Anthropic's "x-api-key header is
// required"). Fail here with an actionable message instead.
function requireRemoteApiKey(
  provider: ProviderObject,
  keyChain: string[]
): string {
  const key = keyChain[0] ?? provider.api_key?.trim()
  if (!key) {
    throw new Error(
      `No API key configured for ${provider.provider}. Add one in Settings > Model Providers.`
    )
  }
  return key
}

/** True for the `/openai/v1` style Azure endpoint (no deployment path or query). */
export function isAzureV1Endpoint(baseUrl: string | undefined): boolean {
  try {
    const url = new URL(baseUrl ?? '')
    return !url.search && !/\/deployments(\/|$)/i.test(url.pathname)
  } catch {
    return false
  }
}

// Azure endpoints are per resource and have no safe default: the
// OpenAI-compatible route would fall back to api.openai.com and a relative URL
// would post to the app's own origin, either way carrying the Azure key. Fail
// before any request is built. janhq/jan#9210.
function requireAzureEndpoint(provider: ProviderObject): void {
  if (!provider.base_url?.trim()) {
    throw new Error(
      i18n.t('model-errors:azureEndpointMissing', {
        provider: provider.provider,
      })
    )
  }
}

function getRuntimeFetch(): typeof globalThis.fetch {
  const maybeWindow = globalThis as typeof globalThis & {
    __TAURI__?: unknown
    __TAURI_INTERNALS__?: unknown
  }
  const hasTauriRuntime =
    typeof maybeWindow.__TAURI__ !== 'undefined' ||
    typeof maybeWindow.__TAURI_INTERNALS__ !== 'undefined'

  // The canonical provider transport, so a completion resolves its endpoint the
  // same way model discovery and a connection test do.
  // Served by `flint serve`, the same transport runs on the server.
  return (isPlatformTauri() && hasTauriRuntime) || isServerTransport()
    ? providerFetch
    : globalThis.fetch
}

/**
 * Map of model keywords to their respective reasoning tags.
 * Used for models that use tags other than the default 'think'.
 */
const REASONING_TAG_MAP: Record<string, string> = {
  gemma: 'thought',
}

/**
 * The default tag used for reasoning extraction if no specific override is found.
 */
const DEFAULT_REASONING_TAG = 'think'

/**
 * Determines the reasoning tag name based on the model ID.
 * Defaults to 'think' if no specific override is found in the map.
 */
function getReasoningTagName(modelId: string): string {
  const lowerId = modelId.toLowerCase()
  for (const [keyword, tag] of Object.entries(REASONING_TAG_MAP)) {
    if (lowerId.includes(keyword)) {
      return tag
    }
  }
  return DEFAULT_REASONING_TAG
}

/**
 * Factory for creating language models based on provider type.
 * Supports native AI SDK providers (Anthropic, Google) and OpenAI-compatible providers.
 */
export class ModelFactory {
  /**
   * Create a language model instance based on the provider configuration
   */
  static async createModel(
    modelId: string,
    provider: ProviderObject,
    parameters: Record<string, unknown> = {},
    streamThreadId?: string
  ): Promise<LanguageModel> {
    const providerName = provider.provider.toLowerCase()
    if (providerName === 'azure') {
      requireAzureEndpoint(provider)
      // Azure's v1 API serves the OpenAI Responses API at the same base URL,
      // and its reasoning deployments reject function tools on
      // /chat/completions. Legacy deployments-style endpoints (path with
      // /deployments, or an api-version query) only speak Chat Completions
      // and keep the compatible route below. janhq/jan#9206.
      if (isAzureV1Endpoint(provider.base_url)) {
        return this.createOpenAIModel(modelId, provider, parameters)
      }
    }
    parameters = stripUnsupportedSamplers(parameters, provider, modelId)

    // Wire-format dispatch wins over name-based dispatch — custom providers
    // pointing at Anthropic-compatible proxies (LiteLLM, Bedrock gateways)
    // need the Anthropic SDK regardless of the user-chosen provider name.
    if (getProviderApiType(provider) === 'anthropic' && providerName !== 'anthropic') {
      return this.createAnthropicModel(modelId, provider, parameters)
    }

    switch (providerName) {
      case 'llamacpp':
        return this.createLlamaCppModel(modelId, provider, parameters, streamThreadId)

      case 'mlx':
        return this.createMlxModel(modelId, provider, parameters, streamThreadId)

      case 'anthropic':
        return this.createAnthropicModel(modelId, provider, parameters)

      case 'openai':
        return this.createOpenAIModel(modelId, provider, parameters)
      case 'google':
      case 'gemini':
        return this.createGoogleModel(modelId, provider, parameters)
      case 'azure':
      case 'groq':
      case 'together':
      case 'fireworks':
      case 'deepseek':
      case 'cohere':
      case 'perplexity':
      case 'moonshot':
      case 'minimax':
        // These take no sampling parameters from the caller, but the
        // conversation they belong to must still reach the transport, or the
        // request is sent unattributed and its prompt snapshot is dropped.
        return this.createOpenAICompatibleModel(
          modelId,
          provider,
          dispatchOnly(parameters)
        )

      case 'bedrock':
        return this.createBedrockModel(modelId, provider, parameters)

      case 'mistral':
        return this.createMistralModel(modelId, provider, parameters)

      case 'xai':
        return this.createXaiModel(modelId, provider, parameters)

      default:
        return this.createOpenAICompatibleModel(modelId, provider, parameters)
    }
  }

  /**
   * Create a llamacpp model by starting the model and finding the running session
   */
  private static async createLlamaCppModel(
    modelId: string,
    provider?: ProviderObject,
    parameters: Record<string, unknown> = {},
    streamThreadId?: string
  ): Promise<LanguageModel> {
    // Start the model first if provider is available
    if (provider) {
      try {
        const { useServiceStore } = await import('@/hooks/useServiceHub')
        const serviceHub = useServiceStore.getState().serviceHub

        if (serviceHub) {
          await serviceHub.models().startModel(provider, modelId)
        }
      } catch (error) {
        console.error('Failed to start llamacpp model:', error)
        // A serialized engine error is a plain object, so the previous
        // `instanceof Error` path stringified it into raw JSON for the user.
        // It rides along as `cause` so an outer layer describes the failure
        // once from its code instead of nesting this sentence inside its own.
        throw engineFailure('model-errors:startModelFailed', error)
      }
    }

    // Get session info which includes port and api_key
    const sessionInfo = await findSessionByModel(modelId)

    if (!sessionInfo) {
      throw new Error(
        i18n.t('model-errors:noRunningSession', { model: modelId })
      )
    }

    const onLlamacppServerError = provider
      ? () => {
          void (async () => {
            try {
              const { useServiceStore } = await import('@/hooks/useServiceHub')
              const hub = useServiceStore.getState().serviceHub
              await hub?.models().reloadModel(provider, modelId)
            } catch (e) {
              console.warn('[llamacpp] reload after crash failed:', e)
            }
          })()
        }
      : undefined
    // The global toggle can strip reasoning_content from resent assistant turns,
    // but never for a preserve_thinking model: its template re-emits prior
    // <think> from that field, so stripping it would diverge the KV-cache prefix.
    let customFetch = createCustomFetch(
      httpFetch,
      parameters,
      true,
      onLlamacppServerError,
      true
    )
    if (
      shouldStripReasoningFromContext() &&
      !modelPreservesReasoning(provider, modelId)
    ) {
      customFetch = withAssistantReasoningStripped(customFetch)
    }

    const llamaConfig = {
      provider: 'llamacpp',
      headers: () => ({
        Authorization: `Bearer ${sessionInfo.api_key}`,
        Origin: 'tauri://localhost',
      }),
      url: ({ path }: { path: string }) => {
        const url = new URL(`http://localhost:${sessionInfo.port}/v1${path}`)
        return url.toString()
      },
      includeUsage: true,
      fetch: customFetch,
    }

    // A template-less base model (GPT-2 style) can only continue text, so it
    // goes to /v1/completions. It has no tool calls to repair.
    const rawCompletion = provider?.models
      ?.find((m) => m.id === modelId)
      ?.capabilities?.includes(ModelCapabilities.RAW_COMPLETION)
    if (rawCompletion) {
      return new OpenAICompatibleCompletionLanguageModel(modelId, llamaConfig)
    }

    const llamaModel = new OpenAICompatibleChatLanguageModel(modelId, {
      ...llamaConfig,
      metadataExtractor: createProviderMetadataExtractor(streamThreadId),
    })

    // A model whose tool-call syntax the server could not parse otherwise
    // leaves the call as text and no tool runs.
    return wrapLanguageModel({
      model: llamaModel,
      middleware: textToolCallMiddleware(),
    })
  }

  /**
   * Create an MLX model by starting the model and finding the running session.
   * MLX uses the same OpenAI-compatible API pattern as llamacpp.
   */
  private static async createMlxModel(
    modelId: string,
    provider?: ProviderObject,
    parameters: Record<string, unknown> = {},
    streamThreadId?: string
  ): Promise<LanguageModel> {
    parameters = filterParameters(parameters, false)
    // Start the model first if provider is available
    if (provider) {
      try {
        const { useServiceStore } = await import('@/hooks/useServiceHub')
        const serviceHub = useServiceStore.getState().serviceHub

        if (serviceHub) {
          await serviceHub.models().startModel(provider, modelId)
        }
      } catch (error) {
        console.error('Failed to start MLX model:', error)
        throw engineFailure('model-errors:startModelFailed', error)
      }
    }

    // Get session info which includes port and api_key
    const sessionInfo = await invoke<SessionInfo | null>(
      'plugin:mlx|find_mlx_session_by_model',
      { modelId }
    )

    if (!sessionInfo) {
      throw new Error(`No running MLX session found for model: ${modelId}`)
    }

    const baseUrl = `http://localhost:${sessionInfo.port}`
    const authHeaders = {
      Authorization: `Bearer ${sessionInfo.api_key}`,
      Origin: 'tauri://localhost',
    }

    // Share the common fetch (param normalisation + error-body cleaning that
    // rebuilds upstream errors from buffered text rather than re-decoding the
    // raw stream) with every other provider, then layer MLX's /cancel-on-abort
    // on top.
    let baseCustomFetch = createCustomFetch(
      httpFetch,
      parameters,
      false,
      undefined,
      true
    )
    if (shouldStripReasoningFromContext()) {
      baseCustomFetch = withAssistantReasoningStripped(baseCustomFetch)
    }
    // A server that died on this request says why instead of a network error.
    const crashAwareFetch = withMlxCrashReport(
      baseCustomFetch,
      (cmd, args) => invoke(cmd, args),
      sessionInfo.pid
    )
    const customFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      // When the request is aborted, also call the server's /cancel endpoint
      // to stop MLX inference immediately.
      if (init?.signal) {
        init.signal.addEventListener('abort', () => {
          httpFetch(`${baseUrl}/v1/cancel`, {
            method: 'POST',
            headers: { ...authHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          }).catch(() => {
            // Ignore cancel request errors
          })
        })
      }

      return crashAwareFetch(input, init)
    }

    const model = new OpenAICompatibleChatLanguageModel(modelId, {
      provider: 'mlx',
      headers: () => authHeaders,
      url: ({ path }) => {
        const url = new URL(`${baseUrl}/v1${path}`)
        return url.toString()
      },
      fetch: customFetch,
      metadataExtractor: createProviderMetadataExtractor(streamThreadId),
    })

    return wrapLanguageModel({
      model: model,
      middleware: [
        // Outermost, so it sees text after reasoning has been split out.
        textToolCallMiddleware(),
        extractReasoningMiddleware({
          tagName: getReasoningTagName(modelId),
          separator: '\n',
        }),
      ],
    })
  }

  /**
   * Create an Anthropic model using the official AI SDK
   */
  private static createAnthropicModel(
    modelId: string,
    provider: ProviderObject,
    parameters: Record<string, unknown> = {}
  ): LanguageModel {
    const headers: Record<string, string> = {}

    // Reserved names (the key's own header among them) are never applied, so
    // the configured key cannot be replaced. janhq/jan#8208.
    applyCustomHeaders(headers, provider)
    // Custom Anthropic providers may ship no custom_header; Anthropic rejects
    // browser-context requests (webview Origin) without the opt-in header.
    ensureAnthropicHeaders(provider, headers)

    const keyChain = providerRemoteApiKeyChain(provider)
    const fetchImpl =
      keyChain.length > 1
        ? createApiKeyRotatingFetch(
            getRuntimeFetch(),
            keyChain,
            parameters,
            'x-api-key'
          )
        : createCustomFetch(getRuntimeFetch(), parameters)

    const anthropic = createAnthropic({
      apiKey: requireRemoteApiKey(provider, keyChain),
      baseURL: provider.base_url,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      fetch: fetchImpl,
    })

    // Anthropic rejects empty text blocks outright.
    return wrapLanguageModel({
      model: anthropic(modelId),
      middleware: emptyTextMiddleware(),
    })
  }


  /**
   * Create an OpenAI model using the official AI SDK
   */
  private static createOpenAIModel(
    modelId: string,
    provider: ProviderObject,
    parameters: Record<string, unknown> = {}
  ): LanguageModel {
    const headers: Record<string, string> = {}

    // Reserved names (the key's own header among them) are never applied, so
    // the configured key cannot be replaced. janhq/jan#8208.
    applyCustomHeaders(headers, provider)

    const keyChain = providerRemoteApiKeyChain(provider)
    const fetchImpl =
      keyChain.length > 1
        ? createApiKeyRotatingFetch(
            getRuntimeFetch(),
            keyChain,
            parameters,
            'authorization-bearer'
          )
        : createCustomFetch(getRuntimeFetch(), parameters)

    const openai = createOpenAI({
      apiKey: requireRemoteApiKey(provider, keyChain),
      baseURL: provider.base_url,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      fetch: fetchImpl,
    })

    // The genuine OpenAI provider (and Azure's v1 API) always supports the
    // Responses API, so use it unconditionally: it is a superset of Chat Completions and the only surface
    // that returns reasoning summaries. Custom OpenAI-compatible providers route
    // through createOpenAICompatibleModel, not here, so this cannot hit a proxy
    // that only implements /chat/completions.
    return openai.responses(modelId)
  }

  /**
   * Amazon Bedrock through the AI SDK's Converse client. The SDK is given a
   * placeholder bearer key only so it does not look for AWS credentials in the
   * webview; the signing fetch replaces its headers with a SigV4 signature the
   * backend makes from the keyring (see lib/bedrock.ts).
   */
  private static createBedrockModel(
    modelId: string,
    provider: ProviderObject,
    parameters: Record<string, unknown> = {}
  ): LanguageModel {
    const baseURL = (provider.base_url?.trim() || DEFAULT_BEDROCK_BASE_URL).replace(
      /\/+$/,
      ''
    )
    const region = bedrockRegion(baseURL)
    if (!region) {
      throw new Error(
        'The Amazon Bedrock Base URL must look like https://bedrock-runtime.<region>.amazonaws.com'
      )
    }
    // Signing must be innermost: nothing may touch the body after the SigV4
    // hash is taken. OpenAI-style assistant params are not merged into the
    // Converse body (they are invalid there); only dispatch identity rides.
    const dispatchOnly: Record<string, unknown> =
      parameters[DISPATCH_PARAM_KEY] !== undefined
        ? { [DISPATCH_PARAM_KEY]: parameters[DISPATCH_PARAM_KEY] }
        : {}
    const fetchImpl = createCustomFetch(
      createBedrockSigningFetch(getRuntimeFetch()),
      dispatchOnly
    )
    const bedrock = createAmazonBedrock({
      region,
      baseURL,
      apiKey: 'signed-by-flint',
      fetch: fetchImpl,
    })
    return wrapLanguageModel({
      model: bedrock(modelId),
      middleware: bedrockSamplingMiddleware(parameters),
    })
  }

  /**
   * Create a Mistral model using the official AI SDK. Needed for magistral-*,
   * which streams `delta.content` as an array of typed parts (thinking + text);
   * the generic openai-compatible schema rejects this with a Zod
   * "expected string, received array" error.
   */
  private static createMistralModel(
    modelId: string,
    provider: ProviderObject,
    parameters: Record<string, unknown> = {}
  ): LanguageModel {
    const headers: Record<string, string> = {}
    // Reserved names (the key's own header among them) are never applied, so
    // the configured key cannot be replaced. janhq/jan#8208.
    applyCustomHeaders(headers, provider)

    const keyChain = providerRemoteApiKeyChain(provider)
    const fetchImpl =
      keyChain.length > 1
        ? createApiKeyRotatingFetch(
            getRuntimeFetch(),
            keyChain,
            parameters,
            'authorization-bearer'
          )
        : createCustomFetch(getRuntimeFetch(), parameters)

    const mistral = createMistral({
      apiKey: requireRemoteApiKey(provider, keyChain),
      baseURL: provider.base_url,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      fetch: fetchImpl,
    })

    return mistral(modelId)
  }

  /**
   * Create an XAI (Grok) model using the official AI SDK
   */
  private static createXaiModel(
    modelId: string,
    provider: ProviderObject,
    parameters: Record<string, unknown> = {}
  ): LanguageModel {
    const headers: Record<string, string> = {}

    // Reserved names (the key's own header among them) are never applied, so
    // the configured key cannot be replaced. janhq/jan#8208.
    applyCustomHeaders(headers, provider)

    const keyChain = providerRemoteApiKeyChain(provider)
    const fetchImpl =
      keyChain.length > 1
        ? createApiKeyRotatingFetch(
            getRuntimeFetch(),
            keyChain,
            parameters,
            'authorization-bearer'
          )
        : createCustomFetch(getRuntimeFetch(), parameters)

    const xai = createXai({
      apiKey: requireRemoteApiKey(provider, keyChain),
      baseURL: provider.base_url,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      fetch: fetchImpl,
    })

    return xai(modelId)
  }

  // Native Google provider. Gemini 3 preview models require a
  // `thought_signature` to be round-tripped on tool-call replays, which
  // Google's /v1beta/openai compat layer does not surface — so we go native.
  // Stored base_url points at …/v1beta/openai for the compat path; the native
  // client wants the bare …/v1beta base.
  private static createGoogleModel(
    modelId: string,
    provider: ProviderObject,
    parameters: Record<string, unknown> = {}
  ): LanguageModel {
    const headers: Record<string, string> = {}
    // Reserved names (the key's own header among them) are never applied, so
    // the configured key cannot be replaced. janhq/jan#8208.
    applyCustomHeaders(headers, provider)

    const keyChain = providerRemoteApiKeyChain(provider)
    // Rotate over configured keys on 401/402/403/429 (e.g. exhausted credit or
    // free-tier quota). The native Google client authenticates via `x-goog-api-key`, so
    // the rotating fetch must override that header — not Authorization.
    const fetchImpl =
      keyChain.length > 1
        ? createApiKeyRotatingFetch(
            getRuntimeFetch(),
            keyChain,
            parameters,
            'x-goog-api-key'
          )
        : createCustomFetch(getRuntimeFetch(), parameters)

    const rawBase = provider.base_url?.trim()
    const baseURL = rawBase
      ? rawBase.replace(/\/openai\/?$/, '').replace(/\/$/, '')
      : 'https://generativelanguage.googleapis.com/v1beta'

    const google = createGoogleGenerativeAI({
      apiKey: requireRemoteApiKey(provider, keyChain),
      baseURL,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      fetch: fetchImpl,
    })

    return google(modelId)
  }

  /**
   * Create an OpenAI-compatible model for providers that support the OpenAI API format
   */
  private static createOpenAICompatibleModel(
    modelId: string,
    provider: ProviderObject,
    parameters: Record<string, unknown> = {}
  ): LanguageModel {
    const headers: Record<string, string> = {}

    // Reserved names (the key's own header among them) are never applied, so
    // the configured key cannot be replaced. janhq/jan#8208.
    applyCustomHeaders(headers, provider)

    const isAzure = isAzureOpenAIProvider(provider)
    const keyChain = providerRemoteApiKeyChain(provider)
    if (keyChain.length === 1) {
      headers['Authorization'] = `Bearer ${keyChain[0]}`
      if (isAzure) headers['api-key'] = keyChain[0]!
    }

    const imageTap = new ImageTap()
    let fetchImpl: typeof globalThis.fetch =
      keyChain.length > 1
        ? createApiKeyRotatingFetch(
            getRuntimeFetch(),
            keyChain,
            parameters,
            isAzure ? 'authorization-bearer+api-key' : 'authorization-bearer',
            true
          )
        : createCustomFetch(getRuntimeFetch(), parameters, false, undefined, true)

    // Groq's API rejects assistant `reasoning` fields, so it always strips
    // regardless of the toggle; other providers honor the global setting.
    if (provider.provider === 'groq' || shouldStripReasoningFromContext()) {
      fetchImpl = withAssistantReasoningStripped(fetchImpl)
    }

    // OpenRouter needs reasoning_details replayed with tool results (Gemini 3
    // thought signatures); the SDK does not carry them. janhq/jan#283.
    if (isOpenRouterProvider(provider)) {
      fetchImpl = withOpenRouterReasoningDetails(fetchImpl)
      fetchImpl = withOpenRouterOptions(fetchImpl, parameters)
      fetchImpl = withImageTap(fetchImpl, imageTap)
    }

    // Only OpenAI itself may fall back to api.openai.com: any other provider
    // with a blank Base URL would send its own key there.
    if (!isAzure && provider.provider !== 'openai') requireAzureEndpoint(provider)
    const endpoint: { baseURL: string; queryParams?: Record<string, string> } =
      isAzure
        ? splitBaseUrlQuery(provider.base_url ?? '')
        : { baseURL: provider.base_url || 'https://api.openai.com/v1' }
    if (isAzure && !endpoint.queryParams?.['api-version']) {
      // The Azure settings field fills in what the URL did not say; a version
      // typed into the URL always wins.
      const apiVersion = azureApiVersionSetting(provider)
      if (apiVersion) {
        endpoint.queryParams = { ...endpoint.queryParams, 'api-version': apiVersion }
      }
    }
    const openAICompatible = createOpenAICompatible({
      name: provider.provider,
      baseURL: endpoint.baseURL,
      queryParams: endpoint.queryParams,
      headers,
      includeUsage: true,
      fetch: fetchImpl,
    })

    const model = openAICompatible.languageModel(modelId)

    return wrapLanguageModel({
      model,
      middleware: [
        // Outermost, so it sees text after reasoning has been split out.
        textToolCallMiddleware(),
        extractReasoningMiddleware({
          tagName: getReasoningTagName(modelId),
          separator: '\n',
        }),
        ...(isOpenRouterProvider(provider)
          ? [imageOutputMiddleware(imageTap)]
          : []),
      ],
    })
  }
}
