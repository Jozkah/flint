export type ThinkingBudgetLevelKey =
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'unlimited'

// Fractions of the model's context window; null = unlimited (-1, llama.cpp's
// sentinel for "don't cap reasoning"). Resolved against the LIVE (post-fit)
// context size at send time, not the configured/default size at selection
// time, since llama.cpp's --fit can pick a runtime n_ctx far from either.
export const THINKING_BUDGET_LEVELS: Array<{
  key: ThinkingBudgetLevelKey
  label: string
  ratio: number | null
}> = [
  { key: 'low', label: 'Low', ratio: 0.1 },
  { key: 'medium', label: 'Medium', ratio: 0.25 },
  { key: 'high', label: 'High', ratio: 0.5 },
  { key: 'xhigh', label: 'XHigh', ratio: 0.75 },
  { key: 'unlimited', label: 'Unlimited', ratio: null },
]

export const DEFAULT_THINKING_BUDGET_LEVEL: ThinkingBudgetLevelKey = 'unlimited'

export function tokensForThinkingBudgetLevel(
  level: ThinkingBudgetLevelKey,
  contextSize: number
): number {
  const ratio = THINKING_BUDGET_LEVELS.find((l) => l.key === level)?.ratio
  return ratio == null ? -1 : Math.max(1, Math.round(contextSize * ratio))
}

export function isThinkingBudgetLevelKey(
  value: unknown
): value is ThinkingBudgetLevelKey {
  return (
    typeof value === 'string' &&
    THINKING_BUDGET_LEVELS.some((l) => l.key === value)
  )
}

/** Floor for a clamped thinking budget: less than this is not useful reasoning. */
export const MIN_THINKING_BUDGET_TOKENS = 1024
/** Reasoning may take at most this share of the output, leaving room to answer. */
export const MAX_THINKING_BUDGET_OUTPUT_RATIO = 0.8

/**
 * Keep a thinking budget within the model's output limit: at most 80% of
 * `maxOutputTokens` (so the answer still fits after the reasoning), never
 * below `MIN_THINKING_BUDGET_TOKENS`. `-1` (unlimited) is capped the same way
 * when the output limit is known. An unknown or non-positive output limit
 * leaves the budget as-is.
 */
export function clampThinkingBudget(
  budget: number,
  maxOutputTokens: number | undefined
): number {
  if (!maxOutputTokens || !Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
    return budget
  }
  const cap = Math.max(
    MIN_THINKING_BUDGET_TOKENS,
    Math.floor(maxOutputTokens * MAX_THINKING_BUDGET_OUTPUT_RATIO)
  )
  if (budget < 0) return cap
  return Math.min(Math.max(budget, MIN_THINKING_BUDGET_TOKENS), cap)
}

/*
 * Where a thinking-budget cap can apply, by provider. Only a request that
 * sends an explicit reasoning token budget can be clamped; the others send no
 * number to clamp, and none is invented for them.
 *
 * - llama.cpp: `thinking_budget_tokens`, clamped against the request's output
 *   limit with `clampThinkingBudget` (custom-chat-transport).
 * - Anthropic, pre-4.6 models: `thinking: { type: 'enabled', budgetTokens }`.
 *   The API requires `budget_tokens < max_tokens`; the AI SDK sets `max_tokens`
 *   to the output limit plus the budget, then cuts it to the model's own output
 *   ceiling, which can leave it at or below the budget (a 400). Clamped with
 *   `clampAnthropicThinkingBudget` against that ceiling.
 * - Anthropic 4.6+: `thinking: { type: 'adaptive' }` -- the model sizes its
 *   own reasoning; there is no budget field.
 * - Google Gemini: `thinkingConfig.thinkingBudget` is sent as -1 (dynamic) or
 *   0 (off), never a token count, so there is nothing to clamp.
 * - OpenAI and OpenAI-compatible: `reasoning_effort` / `reasoningEffort` is a
 *   discrete level with no token budget; not applicable.
 */

/**
 * Output-token ceilings of the Anthropic models that take an explicit
 * thinking budget (pre-4.6), from Anthropic's model documentation. An id not
 * listed returns undefined and its budget is left as configured.
 */
const ANTHROPIC_OUTPUT_CEILINGS: Array<[RegExp, number]> = [
  [/claude-opus-4(-\d{8})?$|claude-opus-4-[01]\b/, 32000],
  [
    /claude-3-7-sonnet\b|claude-sonnet-4\b|claude-haiku-4-5\b|claude-opus-4-5\b/,
    64000,
  ],
]

/**
 * Whether an Anthropic model takes `thinking: { type: 'enabled',
 * budgetTokens }` (Claude 3.7 Sonnet and the 4.x family before 4.6) rather
 * than adaptive thinking. The one test the effort control and the request
 * both use, so they cannot disagree. Dated ids without a minor version
 * (`claude-opus-4-20250514`) count as 4.0.
 */
export function anthropicTakesAnExplicitBudget(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return (
    /(opus|sonnet|haiku)-([0-3]|4-[0-5])\b/.test(id) ||
    /(opus|sonnet|haiku)-4-\d{8}\b/.test(id) ||
    /claude-3-7-sonnet\b/.test(id)
  )
}

/** The model's output ceiling, when it is one we know. */
export function anthropicOutputCeiling(modelId: string): number | undefined {
  const id = modelId.toLowerCase()
  return ANTHROPIC_OUTPUT_CEILINGS.find(([re]) => re.test(id))?.[1]
}

/**
 * Keep an Anthropic `budgetTokens` below the model's output ceiling, with room
 * left for the answer (see `clampThinkingBudget`), and at least Anthropic's
 * 1024-token minimum. Unknown models keep their budget.
 */
export function clampAnthropicThinkingBudget(
  budget: number,
  modelId: string
): number {
  const ceiling = anthropicOutputCeiling(modelId)
  return ceiling === undefined
    ? Math.max(budget, MIN_THINKING_BUDGET_TOKENS)
    : clampThinkingBudget(budget, ceiling)
}
