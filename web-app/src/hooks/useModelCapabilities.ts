/**
 * One model's capabilities, resolved from every source the app already has.
 * AH-195.
 *
 * Synchronous first, then refined: the settings and the provider's metadata
 * are in hand immediately, and a local runtime's effective window arrives only
 * once the model is loaded. Rendering the known answer straight away and
 * improving it when the runtime answers is what stops the window reading
 * "not known" for the whole of a session against a local server.
 */
import { useEffect, useState } from 'react'
import {
  resolveModelCapabilities,
  UNKNOWN_CAPABILITIES,
  type ModelCapabilities,
} from '@/lib/modelCapabilities'
import { getLocalPropsExtension } from '@/lib/llamacppRouterProps'
import { serverReportedLimit } from '@/lib/contextLimitRecovery'

type ModelLike = { id?: string | null } & Record<string, unknown>

export function useModelCapabilities(
  model: ModelLike | null | undefined,
  provider?: Record<string, unknown> | null
): ModelCapabilities {
  const modelId = model?.id ?? null
  const [runtime, setRuntime] = useState<Record<string, unknown> | null>(null)

  useEffect(() => {
    setRuntime(null)
    if (!modelId) return
    let current = true
    const extension = getLocalPropsExtension(
      (provider?.provider as string) ?? ''
    )
    // A remote provider has no local runtime to ask, and asking would be a
    // request Flint has no business making.
    if (!extension?.getModelProps) return
    extension
      .getModelProps(modelId)
      .then((props) => {
        if (current && props) setRuntime(props as unknown as Record<string, unknown>)
      })
      // Not loaded yet, or the router is not up. The configured answer stands.
      .catch(() => {})
    return () => {
      current = false
    }
  }, [modelId, provider])

  if (!model) return UNKNOWN_CAPABILITIES

  // Split deliberately: the settings block is where a user's choice lands and
  // the rest of the entry is what the provider said about the model. Passing
  // the same object as both would make every discovery report itself as a
  // user override, which is the one thing the source field exists to tell
  // apart.
  const { settings, ...metadata } = model
  // What the server said when it last refused a request from this exact
  // endpoint. For a local OpenAI-compatible server that reports no metadata at
  // all, this is frequently the only real answer that exists.
  const learned = modelId
    ? serverReportedLimit({
        provider: (provider?.provider as string) ?? '',
        baseUrl: (provider?.base_url as string) ?? '',
        model: modelId,
      })
    : null
  return resolveModelCapabilities({
    modelId,
    override: settings ? { settings } : null,
    serverReported: learned ? { n_ctx: learned.contextTokens } : null,
    providerMetadata: metadata,
    localRuntime: runtime,
    providerDefault: provider,
  })
}
