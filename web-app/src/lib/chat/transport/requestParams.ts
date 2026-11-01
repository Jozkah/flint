/**
 * The request-body parameters a chat turn sends with its model: per-model
 * sampling defaults, then the assistant's params, then the llama.cpp
 * reasoning params, shaped for the provider. Split out of
 * `CustomChatTransport.sendOnceUnguarded` (Q2-006); behaviour unchanged.
 */
import { buildReasoningBodyParams } from '@/lib/reasoningProviderOptions'
import { isPredefinedRemoteProvider } from '@/lib/providerCaps'
import { OPENROUTER_PARAM_KEYS, paramsSettings } from '@/lib/predefinedParams'

export type RequestParamsInput = {
  /** Per-model sidebar sampling defaults (llama.cpp thinking budget included). */
  modelSamplingDefaults: Record<string, unknown>
  /** The assistant's params: the explicit per-conversation override. */
  inferenceParams: Record<string, unknown> | undefined
  reasoningParams: Record<string, unknown>
  providerId: string
  /** The model resolved with this chat's overrides. */
  selectedModel: Parameters<typeof buildReasoningBodyParams>[1]
  /** The llama.cpp slot pinning, only for llamacpp. */
  slotParams?: Record<string, unknown>
}

export function mergeRequestParams({
  modelSamplingDefaults,
  inferenceParams,
  reasoningParams,
  providerId,
  selectedModel,
  slotParams,
}: RequestParamsInput): Record<string, unknown> {
  const mergedParams: Record<string, unknown> = {
    ...modelSamplingDefaults,
    ...(inferenceParams ?? {}),
    ...reasoningParams,
  }
  // A blank assistant `stop` must not erase the model's own stop strings.
  if (
    typeof mergedParams.stop === 'string' &&
    mergedParams.stop.trim() === ''
  ) {
    if (modelSamplingDefaults.stop !== undefined)
      mergedParams.stop = modelSamplingDefaults.stop
    else delete mergedParams.stop
  }
  if (isPredefinedRemoteProvider(providerId)) {
    // OpenRouter request shaping is consumed client-side by the model
    // factory, so it survives the strip of wire-level sampler keys.
    const kept = Object.fromEntries(
      OPENROUTER_PARAM_KEYS.filter((k) => k in mergedParams).map((k) => [
        k,
        mergedParams[k],
      ])
    )
    for (const key of Object.keys(paramsSettings)) delete mergedParams[key]
    Object.assign(mergedParams, kept)
  }
  // A remote OpenAI-compatible reasoning model takes its effort as a
  // `reasoning_effort` body field. Unlike the first-party providers (which
  // go through the AI SDK's native providerOptions), this reaches the
  // server through the request body, so it is merged in here — after the
  // sampling-param strip above, since it is not one of those params.
  // `selectedModel` is already resolved with this chat's overrides, so a
  // per-chat effort applies. See `buildReasoningBodyParams`.
  const reasoningBodyParams = buildReasoningBodyParams(providerId, selectedModel)
  if (reasoningBodyParams) Object.assign(mergedParams, reasoningBodyParams)
  // Pin chat to the chat slot so llama-server reuses this thread's cached
  // KV prefix across turns; background tasks use BACKGROUND_SLOT_ID and
  // can't evict it.
  //
  // thread_id names whose cache that is, which is what lets the engine
  // park it when another thread takes the slot and pick it back up later,
  // including in a later session. It is stripped before the request
  // reaches llama.cpp.
  if (providerId === 'llamacpp' && slotParams) {
    Object.assign(mergedParams, slotParams)
  }
  return mergedParams
}
