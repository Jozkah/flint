
/**
 * How a stopped reply is resumed.
 *
 * - `prefill`: the partial reply goes last as an assistant message and the
 *   engine carries on from it (llama.cpp, MLX do this by themselves).
 * - `prefill-flag`: the same, for OpenAI-compatible servers (vLLM, LiteLLM,
 *   gateways). They only treat a trailing assistant message as a prefill when
 *   the body says `continue_final_message` and `add_generation_prompt: false`;
 *   without it the model starts a new turn and writes the answer again.
 * - `user-turn`: providers that cannot prefill (OpenAI itself, Anthropic's
 *   newer models, Google, hosted gateways) are asked in words to carry on.
 */
export type ContinuationStrategy = 'prefill' | 'prefill-flag' | 'user-turn'

export const CONTINUE_PROMPT =
  'Continue exactly where you left off, without repeating anything.'

const LOCAL_ENGINES = new Set(['llamacpp', 'mlx'])
/** Predefined entries that are really gateways to a server the user runs. */
const GATEWAY_PROVIDERS = new Set(['litellm', 'ollama', 'llmman'])
/** Hosted services with a fixed endpoint: none of them takes the prefill flag. */
const HOSTED_PROVIDERS = new Set([
  'anthropic', 'azure', 'bedrock', 'cerebras', 'cohere', 'deepseek', 'fireworks',
  'gemini', 'google', 'groq', 'huggingface', 'minimax', 'mistral', 'moonshot',
  'nvidia', 'ollama-cloud', 'openrouter', 'perplexity', 'poe', 'qwen',
  'sambanova', 'together', 'xai', 'zai',
])

/**
 * Not api.openai.com. Kept here, not imported from the provider tables, so this
 * stays usable from the model factory without a cycle.
 */
function isCustomOpenAIHost(baseUrl: string | undefined): boolean {
  const raw = baseUrl?.trim()
  if (!raw) return false
  try {
    const host = new URL(raw).hostname.toLowerCase()
    return host !== 'api.openai.com' && !host.endsWith('.openai.com')
  } catch {
    return false
  }
}

export function continuationStrategy(
  provider:
    | (Pick<ProviderObject, 'provider'> &
        Partial<Pick<ProviderObject, 'api_type' | 'base_url'>>)
    | undefined
): ContinuationStrategy {
  if (!provider) return 'prefill'
  const name = provider.provider.toLowerCase()
  if (LOCAL_ENGINES.has(name)) return 'prefill'
  if (provider.api_type === 'anthropic' || name === 'anthropic') return 'user-turn'
  if (name === 'openai') {
    return isCustomOpenAIHost(provider.base_url) ? 'prefill-flag' : 'user-turn'
  }
  if (GATEWAY_PROVIDERS.has(name)) return 'prefill-flag'
  if (HOSTED_PROVIDERS.has(name)) return 'user-turn'
  return 'prefill-flag'
}

type ModelMessage = { role: string; content: unknown }

/** The messages that resume a reply, by strategy. */
export function buildContinuationMessages<M extends ModelMessage>(
  base: M[],
  partial: M,
  strategy: ContinuationStrategy
): M[] {
  if (strategy !== 'user-turn') return [...base, partial]
  return [
    ...base,
    partial,
    { role: 'user', content: [{ type: 'text', text: CONTINUE_PROMPT }] } as unknown as M,
  ]
}

/**
 * The text to put between a partial reply and what resumes it. A prefill
 * resumes mid-word, so nothing is added. A user-turn resume starts fresh: a
 * space unless one side already has whitespace or the new text starts with
 * punctuation that closes the sentence.
 */
export function continuationJoin(partial: string, next: string): string {
  if (!partial || !next) return ''
  if (/\s$/.test(partial) || /^\s/.test(next)) return ''
  if (/^[.,;:!?)\]}%]/.test(next)) return ''
  return ' '
}

/**
 * Wraps `inner` so a request whose last message is an assistant prefill asks
 * the server to continue it instead of opening a new turn.
 */
export function withContinueFinalMessage(
  inner: typeof globalThis.fetch
): typeof globalThis.fetch {
  return async (input, init) => {
    if ((init?.method === 'POST' || !init?.method) && typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body) as {
          messages?: Array<{ role?: string }>
        }
        const last = body.messages?.[body.messages.length - 1]
        if (last?.role === 'assistant') {
          init = {
            ...init,
            body: JSON.stringify({
              ...body,
              continue_final_message: true,
              add_generation_prompt: false,
            }),
          }
        }
      } catch {
        // non-JSON body: send as it is
      }
    }
    return inner(input, init)
  }
}
