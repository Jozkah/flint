// Reading a provider's error: the context counts it names, and the retry
// wrapper the AI SDK puts around it. Used by CustomChatTransport.

/**
 * Pull llama-server's structured context-overflow fields out of an
 * APICallError. The AI SDK's OpenAI-compatible provider zod-parses the
 * error body and strips unknown keys from `error.data`, but the raw text
 * survives on `error.responseBody`. Parse that to recover the original
 * `n_prompt_tokens` / `n_ctx` siblings so the UI can render an actionable
 * "Used X of Y context tokens" line instead of just the keyword-based
 * banner.
 *
 * Returns null unless both fields are present and numeric.
 */
export function extractContextInfoFromError(
  error: unknown
): { nPromptTokens: number; nCtx: number } | null {
  if (!error || typeof error !== 'object') return null
  const responseBody = (error as { responseBody?: unknown }).responseBody
  if (typeof responseBody !== 'string' || responseBody.length === 0) return null
  try {
    const parsed = JSON.parse(responseBody) as {
      error?: { n_prompt_tokens?: unknown; n_ctx?: unknown }
    }
    const inner = parsed?.error
    if (!inner || typeof inner !== 'object') return null
    const nPromptTokens = (inner as Record<string, unknown>).n_prompt_tokens
    const nCtx = (inner as Record<string, unknown>).n_ctx
    if (typeof nPromptTokens !== 'number' || typeof nCtx !== 'number') return null
    return { nPromptTokens, nCtx }
  } catch {
    return null
  }
}

export function unwrapRetryError(error: unknown): unknown {
  if (!error || typeof error !== 'object') return error
  const errors = (error as { errors?: unknown }).errors
  if (Array.isArray(errors) && errors.length > 0) {
    return errors[errors.length - 1] ?? error
  }
  return error
}

export const RETRY_PREFIX_RE = /^Failed after \d+ attempts\. Last error: /
export const RETRY_NONRETRYABLE_RE = /^Failed after \d+ attempts with non-retryable error: '(.+)'$/s

export function stripRetryErrorWrapper(message: string): string {
  if (typeof message !== 'string') return message
  const m = message.match(RETRY_NONRETRYABLE_RE)
  if (m) return m[1]
  return message.replace(RETRY_PREFIX_RE, '')
}
