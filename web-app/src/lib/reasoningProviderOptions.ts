import type { JSONObject } from '@ai-sdk/provider'
import {
  anthropicTakesAnExplicitBudget,
  clampAnthropicThinkingBudget,
  isThinkingBudgetLevelKey,
  type ThinkingBudgetLevelKey,
} from './thinkingBudget'
import {
  clampEffort,
  effortProfile,
  isOpenAICompatibleReasoningProvider,
  isThinkingOff,
} from './modelEffort'

const VERBOSITY_LEVELS = new Set(['low', 'medium', 'high'])

/**
 * GPT-5 style `verbosity` (low/medium/high), from the assistant parameters.
 * Only OpenAI's gpt-5 family accepts it; every other target gets nothing.
 */
export function buildVerbosityProviderOptions(
  providerId: string,
  modelId: string | undefined,
  params: Record<string, unknown> | undefined
): Record<string, JSONObject> | undefined {
  const v = params?.verbosity
  if (providerId !== 'openai' || typeof v !== 'string') return undefined
  if (!VERBOSITY_LEVELS.has(v) || !/^gpt-?5/i.test(modelId ?? '')) {
    return undefined
  }
  return { openai: { textVerbosity: v } }
}

/** Merges provider-option maps, combining entries that share a provider key. */
export function mergeProviderOptions(
  ...parts: Array<Record<string, JSONObject> | undefined>
): Record<string, JSONObject> | undefined {
  const out: Record<string, JSONObject> = {}
  for (const part of parts) {
    if (!part) continue
    for (const [k, v] of Object.entries(part)) out[k] = { ...out[k], ...v }
  }
  return Object.keys(out).length ? out : undefined
}

type ReasoningChoice = 'auto' | 'on' | 'off' | undefined

// OpenAI's reasoning_effort is a discrete level (no token budget). Our shared
// thinking-budget levels map 1:1; 'unlimited' has no effort equivalent and is
// treated as "no explicit effort" (model default), matching the UI's Default.
const LEVEL_TO_OPENAI_EFFORT: Partial<Record<ThinkingBudgetLevelKey, string>> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
}

// The AI SDK adds budget_tokens on top of max_tokens, so these are safe caps
// regardless of the request's output limit (Anthropic minimum is 1024).
const ANTHROPIC_LEVEL_BUDGET_TOKENS: Record<
  Exclude<ThinkingBudgetLevelKey, 'unlimited'>,
  number
> = {
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
}
const DEFAULT_ANTHROPIC_BUDGET_TOKENS = 8192

function readReasoning(model: Model | null | undefined): ReasoningChoice {
  const v = model?.settings?.reasoning?.controller_props?.value
  return v === 'on' || v === 'off' || v === 'auto' ? v : undefined
}

function readBudgetLevel(
  model: Model | null | undefined
): ThinkingBudgetLevelKey | undefined {
  const v = model?.settings?.thinking_budget_tokens?.controller_props?.value
  return isThinkingBudgetLevelKey(v) ? v : undefined
}

/**
 * Translate Flint's shared reasoning settings (reasoning on/off/auto + thinking
 * budget level) into the per-request `providerOptions` the AI SDK expects for
 * cloud providers, using each provider's NATIVE options rather than a
 * context-derived token budget (which we can't know for cloud models):
 *
 * - Google Gemini: `thinkingConfig.thinkingBudget` -1 (dynamic, model-sized) /
 *   0 (off), plus `includeThoughts` to surface thought summaries.
 * - Anthropic: `thinking` adaptive (model-sized, no token guess) / disabled.
 * - OpenAI: `reasoningEffort` discrete level (no budget).
 *
 * Returns undefined when the provider has no mapping or the user left reasoning
 * at its provider default.
 */
export function buildReasoningProviderOptions(
  providerId: string,
  model: Model | null | undefined
): Record<string, JSONObject> | undefined {
  const reasoning = readReasoning(model)
  const level = readBudgetLevel(model)

  if (providerId === 'google' || providerId === 'gemini') {
    if (reasoning === 'off') {
      return { google: { thinkingConfig: { thinkingBudget: 0 } } }
    }
    if (reasoning === 'on' || level) {
      return {
        google: { thinkingConfig: { thinkingBudget: -1, includeThoughts: true } },
      }
    }
    return undefined
  }

  if (providerId === 'anthropic') {
    if (reasoning === 'off') {
      return { anthropic: { thinking: { type: 'disabled' } } }
    }
    if (reasoning === 'on' || level) {
      const id = (model?.id ?? '').toLowerCase()
      // Adaptive thinking exists on Claude 4.6+ only; pre-4.6 models reject it
      // with a 400 and require enabled + budget_tokens. `display` shipped with
      // 4.7, so it is omitted on the 4.6 family. Unknown ids get the
      // current-generation default (adaptive + summarized).
      const isPre46 = anthropicTakesAnExplicitBudget(id)
      if (isPre46) {
        const budgetTokens =
          level && level !== 'unlimited'
            ? ANTHROPIC_LEVEL_BUDGET_TOKENS[level]
            : DEFAULT_ANTHROPIC_BUDGET_TOKENS
        return {
          anthropic: {
            thinking: {
              type: 'enabled',
              // Below the model's output ceiling, or the API refuses the
              // request (budget_tokens must be < max_tokens).
              budgetTokens: clampAnthropicThinkingBudget(budgetTokens, id),
            },
          },
        }
      }
      const supportsDisplay = !/(opus|sonnet)-4-6\b/.test(id)
      return {
        anthropic: {
          thinking: supportsDisplay
            ? { type: 'adaptive', display: 'summarized' }
            : { type: 'adaptive' },
        },
      }
    }
    return undefined
  }

  // Any other remote provider goes through the OpenAI-compatible factory, whose
  // reasoning knob is the standard `reasoning_effort` body field — see
  // `buildReasoningBodyParams`, not this native-`providerOptions` path.
  if (providerId === 'openai') {
    // Reasoning models always reason, so 'off' has no universal equivalent;
    // only a concrete effort level maps ('unlimited' = model default).
    // reasoningSummary surfaces the (otherwise hidden) reasoning as summary
    // parts — it requires the Responses API, which model-factory selects when
    // an effort level is set.
    // Off is `none`, where the model takes it; the others always reason.
    if (isThinkingOff(model) && effortProfile(providerId, model).canDisable) {
      return { openai: { reasoningEffort: 'none' } }
    }
    // Clamped to what this model takes: `xhigh` is a 400 before gpt-5.2.
    const takes = effortProfile(providerId, model).levels
    const picked =
      level && level !== 'unlimited' ? clampEffort(level, takes) : null
    const effort = picked ? LEVEL_TO_OPENAI_EFFORT[picked] : undefined
    return effort
      ? { openai: { reasoningEffort: effort, reasoningSummary: 'auto' } }
      : undefined
  }

  return undefined
}

/**
 * The reasoning fields to merge into an OpenAI-compatible request BODY (not the
 * AI SDK's native `providerOptions`, which only the first-party providers
 * above understand).
 *
 * A remote OpenAI-compatible reasoning model takes a discrete `reasoning_effort`
 * (`low`/`medium`/`high`/`xhigh`) — the same symbolic level this chat stored
 * under `thinking_budget_tokens`, forwarded verbatim. Returns undefined unless
 * the provider qualifies (see `isOpenAICompatibleReasoningProvider`) and a
 * concrete level is set; `unlimited` is the absence of an effort, so it sends
 * nothing and lets the model decide.
 *
 * Kept the sole source of truth for this path so the control on screen
 * (`supportedEffortLevels`) and the request cannot drift apart.
 */
export function buildReasoningBodyParams(
  providerId: string | null | undefined,
  model: Model | null | undefined
): Record<string, unknown> | undefined {
  if (!isOpenAICompatibleReasoningProvider(providerId, model)) return undefined
  const { levels, canDisable } = effortProfile(providerId, model)
  // Switched off: the template switch every compatible server reads, and no
  // effort, since there is nothing to size.
  if (canDisable && isThinkingOff(model)) {
    return { chat_template_kwargs: { enable_thinking: false } }
  }
  const level = readBudgetLevel(model)
  if (!level || level === 'unlimited') return undefined
  // Clamped to what this model takes (gpt-oss has no `xhigh`).
  const sent = clampEffort(level, levels)
  return sent ? { reasoning_effort: sent } : undefined
}
