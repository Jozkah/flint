/**
 * The context window Flint actually knows for a model, or null.
 *
 * A generation that stops with `finishReason === 'length'` is either a context
 * overflow or an output cap. Telling them apart needs the window, and the chat
 * route used to assume 32,768 tokens for any model without a `ctx_len`
 * setting -- every custom OpenAI-compatible endpoint, which has none. A 128k
 * model cut off by its output cap at 30k then raised the out-of-context banner;
 * an 8k model that genuinely overflowed did not (janhq/jan#8669,
 * janhq/jan#8760).
 *
 * This resolves the window the same way the capability display does (AH-195):
 * the user's own setting, then what the server said when it last refused a
 * request, then what the provider describes, then the bundled table. A window
 * nobody knows stays null, and a null window is never a context-limit verdict.
 */
import { resolveModelCapabilities } from '@/lib/modelCapabilities'
import { serverReportedLimit } from '@/lib/contextLimitRecovery'

type ModelLike = { id?: string | null; settings?: unknown } & Record<
  string,
  unknown
>
type ProviderLike = { provider?: string; base_url?: string } & Record<
  string,
  unknown
>

export function knownContextWindow(
  model: ModelLike | null | undefined,
  provider: ProviderLike | null | undefined
): number | null {
  const modelId = model?.id
  if (!modelId) return null
  // Split as the capability hook does: the settings block is the user's
  // decision, the rest is what the provider said.
  const { settings, ...metadata } = model
  const learned = serverReportedLimit({
    provider: provider?.provider ?? '',
    baseUrl: provider?.base_url ?? '',
    model: modelId,
  })
  return resolveModelCapabilities({
    modelId,
    override: settings ? { settings } : null,
    serverReported: learned ? { n_ctx: learned.contextTokens } : null,
    providerMetadata: metadata,
    providerDefault: provider ?? null,
  }).contextTokens
}

/**
 * Providers whose context window Flint itself sets when it loads the model.
 *
 * For these, raising the model's context size and reloading gives the next
 * request a bigger window. For every other provider the window belongs to the
 * server: raising a number in Flint's settings changes nothing that is sent, so
 * offering "Increase Context Size" there promised a fix that could not work
 * (janhq/jan#8760).
 */
const RESIZABLE_CONTEXT_PROVIDERS = new Set<string>(['llamacpp', 'mlx'])

export function contextIsResizable(providerId: string | null | undefined): boolean {
  return !!providerId && RESIZABLE_CONTEXT_PROVIDERS.has(providerId)
}

/** Whether a length stop at `totalTokens` means the window was exhausted. */
export function stoppedAtContextLimit(
  totalTokens: number,
  window: number | null
): boolean {
  return window != null && window > 0 && totalTokens >= window * 0.9
}
