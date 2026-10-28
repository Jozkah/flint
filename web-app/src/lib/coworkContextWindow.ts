import { useAssistant } from '@/hooks/useAssistant'
import { coworkWindow } from '@/lib/coworkBudget'

/**
 * The window a request has to fit inside, when it is known.
 *
 * Resolved by `useModelCapabilities` (AH-195) rather than read from one
 * settings field: an OpenAI-compatible server reports its window under any of
 * several names, and reading only Flint's own `ctx_len` left every such endpoint
 * permanently "not known". When a local runtime has answered this is its
 * effective `n_ctx`, which `--fit` may have set well below the model's
 * training size -- the smaller number is the real limit.
 */
export const configuredContextTokens = (
  caps: { contextTokens: number | null; source?: string } | null | undefined,
  acceptedPrompt?: number | null
): number | null =>
  coworkWindow({
    // Use this only when the provider has not reported its own window.
    userSet:
      useAssistant.getState().currentAssistant?.parameters?.max_context_tokens,
    capabilities: caps,
    acceptedPrompt,
  })
