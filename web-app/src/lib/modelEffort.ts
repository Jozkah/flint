/**
 * Which reasoning-effort levels the active provider actually honours.
 *
 * Derived from the mapping in `reasoningProviderOptions.ts` rather than
 * restated: a level is offered only where choosing it changes the request that
 * provider receives. Showing a stop the provider ignores would be a control
 * that does nothing, which is worse than no control.
 *
 * The four discrete stops are `low`, `medium`, `high` and `xhigh`.
 * `unlimited` is not an effort — it is the absence of one, meaning "let the
 * model decide" — so it is never a stop on the bar.
 */

import {
  THINKING_BUDGET_LEVELS,
  type ThinkingBudgetLevelKey,
} from '@/lib/thinkingBudget'

/** A discrete effort level. `unlimited` is deliberately not one. */
export type EffortLevel = Exclude<ThinkingBudgetLevelKey, 'unlimited'>

export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh']

export const isEffortLevel = (value: unknown): value is EffortLevel =>
  typeof value === 'string' && (EFFORT_LEVELS as string[]).includes(value)

/** The label the shared level list already gives this level. */
export function effortLabel(level: EffortLevel): string {
  return THINKING_BUDGET_LEVELS.find((l) => l.key === level)?.label ?? level
}

/**
 * Anthropic's adaptive thinking sizes itself, so a level changes nothing on
 * models that support it. Only the pre-4.6 family takes an explicit
 * `budgetTokens`, and that is the same test `buildReasoningProviderOptions`
 * makes — kept identical here so the control and the request cannot disagree.
 */
function anthropicTakesAnExplicitBudget(modelId: string): boolean {
  return /(opus|sonnet|haiku)-([0-3]|4-[0-5])\b/.test(modelId.toLowerCase())
}

/**
 * Providers with their own reasoning wiring, handled explicitly elsewhere and
 * so never routed through the generic OpenAI-compatible body path:
 *
 * - `openai` / `anthropic` / `google` / `gemini` take reasoning via the AI
 *   SDK's native `providerOptions` (see `buildReasoningProviderOptions`).
 * - `llamacpp` / `mlx` are local engines with their own budget resolution.
 * - `mistral` / `xai` use their own AI SDK factories, not the OpenAI-compatible
 *   one, so a `reasoning_effort` body field would not reach them.
 */
const NATIVELY_WIRED_REASONING_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'google',
  'gemini',
  'llamacpp',
  'mlx',
  'mistral',
  'xai',
])

/**
 * A remote provider reached through the OpenAI-compatible factory whose model
 * declares the `reasoning` capability, so `reasoning_effort` in the request
 * body is honoured. This is the honest signal — a discrete effort only belongs
 * on screen where the model actually reasons on demand, and the capability tag
 * is how the rest of the app already gates reasoning-only affordances. Sending
 * the field to a model that ignores it would be a control that does nothing (or
 * a strict server that rejects the unknown field).
 */
export function isOpenAICompatibleReasoningProvider(
  providerId: string | null | undefined,
  model: Model | null | undefined
): boolean {
  return (
    !!providerId &&
    !NATIVELY_WIRED_REASONING_PROVIDERS.has(providerId) &&
    (model?.capabilities?.includes('reasoning') ?? false)
  )
}

/**
 * The levels this provider and model will actually act on.
 *
 * Empty means no effort control belongs on screen:
 *
 * - **openai** maps each level to a distinct `reasoningEffort`, so all four.
 * - **anthropic** takes a distinct `budgetTokens` per level only on pre-4.6
 *   models; 4.6+ reasons adaptively and ignores the level entirely.
 * - **llamacpp** resolves each level to a fraction of the live context window,
 *   so all four (its own menu additionally offers `unlimited`, which is not an
 *   effort and so is not offered here).
 * - **google / gemini** treat any level as a single on switch — the budget is
 *   dynamic — so there is nothing discrete to choose between.
 * - **any other remote** provider (reached through the OpenAI-compatible
 *   factory) gets all four when its model declares the `reasoning` capability,
 *   since each level maps to a distinct `reasoning_effort` in the request body.
 */
export function supportedEffortLevels(
  providerId: string | null | undefined,
  model: Model | null | undefined
): EffortLevel[] {
  switch (providerId) {
    case 'openai':
    case 'llamacpp':
      return EFFORT_LEVELS
    case 'anthropic':
      return anthropicTakesAnExplicitBudget(model?.id ?? '')
        ? EFFORT_LEVELS
        : []
    case 'google':
    case 'gemini':
      return []
    default:
      return isOpenAICompatibleReasoningProvider(providerId, model)
        ? EFFORT_LEVELS
        : []
  }
}

/** Does an effort control belong on screen for this provider and model? */
export function supportsEffort(
  providerId: string | null | undefined,
  model: Model | null | undefined
): boolean {
  return supportedEffortLevels(providerId, model).length > 0
}

/**
 * The setting key an effort level is stored under.
 *
 * The same key the existing menus read and `buildReasoningProviderOptions`
 * consumes, so a level set here reaches the provider through the path that
 * already works rather than through a second one built alongside it.
 */
export const EFFORT_SETTING_KEY = 'thinking_budget_tokens'

/** The effort a resolved model is currently set to, if it is set to one. */
export function effortOf(model: Model | null | undefined): EffortLevel | null {
  const value = model?.settings?.[EFFORT_SETTING_KEY]?.controller_props?.value
  return isEffortLevel(value) ? value : null
}
