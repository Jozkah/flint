import {
  isThinkingBudgetLevelKey,
  type ThinkingBudgetLevelKey,
} from './thinkingBudget'

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
 * Translate Jan's shared reasoning settings (reasoning on/off/auto + thinking
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
): Record<string, Record<string, unknown>> | undefined {
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
      // Adaptive lets Claude size its own thinking budget; 'summarized' streams
      // the thought summary we render in the reasoning trace.
      return {
        anthropic: { thinking: { type: 'adaptive', display: 'summarized' } },
      }
    }
    return undefined
  }

  if (providerId === 'openai') {
    // Reasoning models always reason, so 'off' has no universal equivalent;
    // only a concrete effort level maps ('unlimited' = model default).
    // reasoningSummary surfaces the (otherwise hidden) reasoning as summary
    // parts — it requires the Responses API, which model-factory selects when
    // an effort level is set.
    const effort = level ? LEVEL_TO_OPENAI_EFFORT[level] : undefined
    return effort
      ? { openai: { reasoningEffort: effort, reasoningSummary: 'auto' } }
      : undefined
  }

  return undefined
}
