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
  anthropicTakesAnExplicitBudget,
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

// Anthropic's adaptive thinking sizes itself, so a level changes nothing on
// models that support it. Only the pre-4.6 family takes an explicit
// `budgetTokens`: `anthropicTakesAnExplicitBudget`, the same function
// `buildReasoningProviderOptions` uses, so the control and the request cannot
// disagree.

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
 * Model families that reason on demand and take `reasoning_effort`, matched by
 * id. A custom or self-hosted OpenAI-compatible server (llama.cpp, vLLM,
 * LiteLLM, a proxy) is added by hand and never carries the `reasoning`
 * capability tag the catalogue gives a hosted model, so the id is the only
 * signal there is for it.
 */
const REASONING_MODEL_ID =
  /(^|[/:_.-])(qwen-?3|qwq|deepseek-?r1|r1|gpt-?oss|o[134](-|$)|magistral|glm-?4\.?[5-9]|kimi-?k2|minimax-?m|nemotron|phi-?4-?reasoning|reasoning|thinking)/i

/**
 * A remote provider reached through the OpenAI-compatible factory whose model
 * reasons on demand, so `reasoning_effort` in the request body is honoured:
 * the model declares the `reasoning` capability, or its id names a reasoning
 * family (see `REASONING_MODEL_ID`). A discrete effort only belongs on screen
 * where the model actually reasons on demand. Sending the field to a model
 * that ignores it would be a control that does nothing (or a strict server
 * that rejects the unknown field).
 */
export function isOpenAICompatibleReasoningProvider(
  providerId: string | null | undefined,
  model: Model | null | undefined
): boolean {
  return (
    !!providerId &&
    !NATIVELY_WIRED_REASONING_PROVIDERS.has(providerId) &&
    ((model?.capabilities?.includes('reasoning') ?? false) ||
      REASONING_MODEL_ID.test(model?.id ?? ''))
  )
}

/** The levels a model offers, and the one it uses when none is chosen. */
export interface EffortProfile {
  /** The stops to show, lowest first. Empty means no control belongs on screen. */
  levels: EffortLevel[]
  /**
   * The level the model runs at when none is sent, marked "Recommended" on the
   * bar and shown while nothing is chosen. Null only when there are no levels.
   * llama.cpp defaults to an unbounded budget, so its stop is the highest, the
   * nearest one.
   */
  recommended: EffortLevel | null
  /**
   * Whether the model can be told not to think at all. The bar then gets an
   * extra first stop, Off.
   */
  canDisable: boolean
}

/** A stop on the bar: an effort level, or thinking switched off. */
export type EffortChoice = EffortLevel | 'off'

const NO_EFFORT: EffortProfile = {
  levels: [],
  recommended: null,
  canDisable: false,
}
const THREE_LEVELS: EffortLevel[] = ['low', 'medium', 'high']
/** vLLM's Flash-Next template takes these and answers `high` with a 400. */
const LOW_MEDIUM_XHIGH: EffortLevel[] = ['low', 'medium', 'xhigh']

/**
 * OpenAI: `xhigh` arrived with gpt-5.2 and the codex-max models. The models
 * before it (gpt-5, gpt-5.1, the o-series) top out at `high`, and are named
 * here; an id not named is taken to be newer and gets all four, so a new model
 * is never held back. All default to `medium`.
 */
const OPENAI_TOPS_OUT_AT_HIGH = /(^|[/:])(o[134](-|$)|gpt-?5(-|$)|gpt-?5\.1(-|$))/

function openaiProfile(modelId: string): EffortProfile {
  const id = modelId.toLowerCase()
  const topsOut = OPENAI_TOPS_OUT_AT_HIGH.test(id) && !/codex-max/.test(id)
  return {
    levels: topsOut ? THREE_LEVELS : EFFORT_LEVELS,
    recommended: 'medium',
    // `reasoning_effort: none` arrived with gpt-5.1; the codex models and the
    // earlier ones always reason.
    canDisable: /gpt-?5\.([1-9]|\d{2,})/.test(id) && !/codex/.test(id),
  }
}

/**
 * A remote OpenAI-compatible reasoning model. No provider API reports which
 * efforts a model accepts, so this is what each family is known to take:
 * gpt-oss stops at `high`, and a Flash-Next template on vLLM skips `high`; the
 * rest of the compatible hosts (OpenRouter,
 * vLLM, LiteLLM) normalise `xhigh` themselves. `medium` is the default
 * everywhere. Qwen3 can be told not to think (`enable_thinking: false`, which
 * llama.cpp, vLLM and SGLang all read); the others have no such switch common
 * to every host.
 */
function compatibleProfile(modelId: string): EffortProfile {
  const id = modelId.toLowerCase()
  return {
    levels: /gpt-?oss/.test(id)
      ? THREE_LEVELS
      : /flash-next/.test(id)
        ? LOW_MEDIUM_XHIGH
        : EFFORT_LEVELS,
    recommended: 'medium',
    canDisable: /qwen-?3/.test(id),
  }
}

/**
 * What this provider and model will actually act on, read from the model
 * rather than fixed per provider, since models of one provider differ.
 *
 * Empty levels mean no effort control belongs on screen:
 *
 * - **openai**: per generation, see `openaiProfile`.
 * - **anthropic** (pre-4.6, which can also switch thinking off) takes a distinct `budgetTokens` per level only on pre-4.6
 *   models (default 8192, the `medium` budget); 4.6+ reasons adaptively and
 *   ignores the level entirely.
 * - **llamacpp** resolves each level to a fraction of the live context window,
 *   so all four (its own menu additionally offers `unlimited`, which is not an
 *   effort and so is not offered here). Its default is unbounded, so the
 *   highest stop, the nearest, is the one shown as its default.
 * - **google / gemini** treat any level as a single on switch — the budget is
 *   dynamic — so there is nothing discrete to choose between.
 * - **any other remote** provider (reached through the OpenAI-compatible
 *   factory) when its model reasons, see `compatibleProfile`.
 */
export function effortProfile(
  providerId: string | null | undefined,
  model: Model | null | undefined
): EffortProfile {
  switch (providerId) {
    case 'openai':
      return openaiProfile(model?.id ?? '')
    case 'llamacpp':
      return { levels: EFFORT_LEVELS, recommended: 'xhigh', canDisable: true }
    case 'anthropic':
      return anthropicTakesAnExplicitBudget(model?.id ?? '')
        ? { levels: EFFORT_LEVELS, recommended: 'medium', canDisable: true }
        : NO_EFFORT
    case 'google':
    case 'gemini':
      return NO_EFFORT
    default:
      return isOpenAICompatibleReasoningProvider(providerId, model)
        ? compatibleProfile(model?.id ?? '')
        : NO_EFFORT
  }
}

/** The levels this provider and model will actually act on. */
export function supportedEffortLevels(
  providerId: string | null | undefined,
  model: Model | null | undefined
): EffortLevel[] {
  return effortProfile(providerId, model).levels
}

/**
 * A stored level the model does not take (kept from a previous model, or set
 * before it was known) becomes the nearest one it does: the highest it offers
 * that is not above it, else its lowest. Null where it offers none.
 */
export function clampEffort(
  level: EffortLevel,
  levels: EffortLevel[]
): EffortLevel | null {
  if (!levels.length) return null
  if (levels.includes(level)) return level
  const rank = (l: EffortLevel) => EFFORT_LEVELS.indexOf(l)
  const below = levels.filter((l) => rank(l) < rank(level))
  return below.length ? below[below.length - 1] : levels[0]
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

/** Is thinking switched off for this resolved model? */
export function isThinkingOff(model: Model | null | undefined): boolean {
  return model?.settings?.reasoning?.controller_props?.value === 'off'
}
