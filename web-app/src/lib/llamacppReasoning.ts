/**
 * llama.cpp's request-level reasoning fields, shared by every surface that
 * sends to a local model: chat and Cowork (through the chat transport) and a
 * Rooms participant turn.
 */
import { getLlamacppExtension } from '@/lib/llamacppRouterProps'
import {
  isThinkingBudgetLevelKey,
  tokensForThinkingBudgetLevel,
} from '@/lib/thinkingBudget'

/**
 * `thinking_budget_tokens` is stored as a symbolic level (low/medium/high/
 * xhigh/unlimited), not a frozen absolute count — llama.cpp's --fit can pick
 * a runtime n_ctx far from the configured/default size, and that's only known
 * once the model is actually loaded. Resolve against the live n_ctx here, at
 * send time, instead of whatever context size was in scope when the level
 * was picked in ChatInput.
 */
export async function resolveThinkingBudgetTokens(
  model: Model | null | undefined,
  modelId: string | undefined
): Promise<number | undefined> {
  const rawLevel = model?.settings?.thinking_budget_tokens?.controller_props?.value
  if (!isThinkingBudgetLevelKey(rawLevel)) return undefined
  if (rawLevel === 'unlimited') return -1

  let contextSize: number | undefined
  if (modelId) {
    try {
      contextSize = (await getLlamacppExtension()?.getModelProps?.(modelId))?.nCtx
    } catch {
      // Model not loaded yet or router unreachable; fall through to configured/default.
    }
  }
  if (!contextSize) {
    const configured = model?.settings?.ctx_len?.controller_props?.value
    contextSize =
      typeof configured === 'number'
        ? configured
        : typeof configured === 'string' && configured !== ''
          ? Number(configured)
          : undefined
  }
  return tokensForThinkingBudgetLevel(rawLevel, contextSize || 8192)
}

type ChatTemplateKwargs = Record<string, boolean | number | string>

/**
 * Build the per-request `chat_template_kwargs` for llama-server's chat
 * completions endpoint, merging the reasoning toggle with any user-set
 * per-model template kwargs (e.g. `preserve_thinking`) into one object. The
 * server parses each value via `json_value(...).dump()`
 * (server-common.cpp:1056-1069) and rejects values that serialize to a quoted
 * JSON string where a boolean/number is expected — so this emits real JSON
 * types, never the strings `"true"` / `"false"`. Reasoning 'auto'/undefined
 * omits `enable_thinking` so the server falls back to its --reasoning-budget
 * default; `enable_thinking` from the reasoning control always wins over a
 * user-supplied value. The function is a no-op for non-llamacpp providers.
 */
export function buildLlamacppReasoningParams(
  providerName: string | null | undefined,
  reasoning: 'auto' | 'on' | 'off' | undefined,
  userKwargs?: ChatTemplateKwargs | null
): { chat_template_kwargs?: ChatTemplateKwargs } {
  if (providerName !== 'llamacpp') return {}
  const kwargs: ChatTemplateKwargs = {}
  if (userKwargs && typeof userKwargs === 'object') {
    for (const [key, value] of Object.entries(userKwargs)) {
      if (key === 'enable_thinking') continue
      const t = typeof value
      if (t === 'boolean' || t === 'number' || t === 'string') {
        kwargs[key] = value
      }
    }
  }
  if (reasoning === 'on' || reasoning === 'off') {
    kwargs.enable_thinking = reasoning === 'on'
  }
  if (Object.keys(kwargs).length === 0) return {}
  return { chat_template_kwargs: kwargs }
}
