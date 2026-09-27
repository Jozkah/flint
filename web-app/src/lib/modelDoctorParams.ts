import { extractModelSamplingDefaults } from '@/lib/custom-chat-transport'
import { buildReasoningBodyParams } from '@/lib/reasoningProviderOptions'
import { isPredefinedRemoteProvider } from '@/lib/providerCaps'
import { paramsSettings } from '@/lib/predefinedParams'
import { BACKGROUND_SLOT_ID } from '@/constants/models'

/**
 * The request parameters a Cowork run would build for this model (sampling
 * defaults, reasoning effort), so the probe goes through the same provider
 * connection with the same body. On llama.cpp it uses the background slot,
 * like other utility calls, so a chat's cached prompt is not evicted.
 */
export function probeModelParams(provider: ProviderObject, model: Model): Record<string, unknown> {
  const params: Record<string, unknown> = { ...extractModelSamplingDefaults(model) }
  if (isPredefinedRemoteProvider(provider.provider)) {
    for (const key of Object.keys(paramsSettings)) delete params[key]
  }
  Object.assign(params, buildReasoningBodyParams(provider.provider, model) ?? {})
  if (provider.provider === 'llamacpp') params.id_slot = BACKGROUND_SLOT_ID
  return params
}
