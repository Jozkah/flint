/**
 * A participant's reasoning setting, turned into the request fields its
 * provider takes.
 *
 * Not a second mapping: the setting is written onto the participant's model in
 * the same shape chat stores it (`reasoning`, `thinking_budget_tokens`), and
 * the helpers chat sends with read it from there. What reaches each provider is
 * therefore exactly what chat would send for the same choice.
 */
import type { JSONObject } from '@ai-sdk/provider'
import {
  buildReasoningBodyParams,
  buildReasoningProviderOptions,
} from '@/lib/reasoningProviderOptions'
import {
  buildLlamacppReasoningParams,
  resolveThinkingBudgetTokens,
} from '@/lib/llamacppReasoning'
import {
  clampThinkingBudget,
  isThinkingBudgetLevelKey,
} from '@/lib/thinkingBudget'
import {
  isOpenAICompatibleReasoningProvider,
  supportedEffortLevels,
} from '@/lib/modelEffort'
import type { ParticipantReasoning } from './types'

const REASONING_MODES = ['auto', 'on', 'off'] as const

/** Providers whose request takes Auto / On / Off -- as chat's control shows it. */
const MODE_PROVIDERS = new Set([
  'llamacpp',
  'google',
  'gemini',
  'anthropic',
  'openai',
])

/**
 * Which parts of the Reasoning control apply to a provider and model, by the
 * same rules chat's composer uses: Auto / On / Off where the request takes
 * it, a Thinking Budget for llama.cpp (resolved against the live context), and
 * a Reasoning effort where the provider acts on a discrete level.
 */
export function participantReasoningControls(
  providerId: string | null | undefined,
  model: Model | null | undefined
): { modes: boolean; thinkingBudget: boolean; effortLevels: string[] } {
  const thinkingBudget = providerId === 'llamacpp'
  const reachable =
    !!providerId &&
    (MODE_PROVIDERS.has(providerId) ||
      isOpenAICompatibleReasoningProvider(providerId, model))
  return {
    modes: !!providerId && MODE_PROVIDERS.has(providerId),
    thinkingBudget,
    effortLevels:
      reachable && !thinkingBudget
        ? supportedEffortLevels(providerId, model)
        : [],
  }
}

/** Keep only well-formed values; `undefined` when nothing is left. */
export function normaliseParticipantReasoning(
  value: unknown
): ParticipantReasoning | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { mode, level } = value as Record<string, unknown>
  const out: ParticipantReasoning = {}
  if ((REASONING_MODES as readonly unknown[]).includes(mode)) {
    out.mode = mode as ParticipantReasoning['mode']
  }
  if (isThinkingBudgetLevelKey(level)) out.level = level
  return out.mode || out.level ? out : undefined
}

/**
 * Drop what the participant's current provider and model would not act on --
 * a level kept from a previous model, say -- so a setting nobody can see never
 * reaches a request.
 */
export function applicableParticipantReasoning(
  providerId: string,
  model: Model | null | undefined,
  reasoning: ParticipantReasoning | undefined
): ParticipantReasoning | undefined {
  const r = normaliseParticipantReasoning(reasoning)
  if (!r) return undefined
  const controls = participantReasoningControls(providerId, model)
  const out: ParticipantReasoning = {}
  if (r.mode && controls.modes) out.mode = r.mode
  if (
    r.level &&
    (controls.thinkingBudget || controls.effortLevels.includes(r.level))
  ) {
    out.level = r.level
  }
  return out.mode || out.level ? out : undefined
}

export type ParticipantReasoningRequest = {
  /** Fields for the request body, passed to `ModelFactory.createModel`. */
  params: Record<string, unknown>
  /** The AI SDK's native per-request options, for first-party providers. */
  providerOptions?: Record<string, JSONObject>
}

/**
 * The participant's model with its reasoning setting in place of whatever the
 * global model configuration says. A room turn has never followed the chat
 * model settings, so an unset field is removed rather than inherited: a
 * participant left at the default sends what it always sent.
 */
export function withParticipantReasoning(
  model: Model | undefined,
  modelId: string,
  reasoning: ParticipantReasoning | undefined
): Model {
  const settings: Record<string, unknown> = { ...(model?.settings ?? {}) }
  delete settings.reasoning
  delete settings.thinking_budget_tokens
  if (reasoning?.mode) {
    settings.reasoning = {
      key: 'reasoning',
      title: 'Reasoning',
      description: '',
      controller_type: 'dropdown',
      controller_props: { value: reasoning.mode },
    }
  }
  if (reasoning?.level) {
    settings.thinking_budget_tokens = {
      key: 'thinking_budget_tokens',
      title: 'Thinking Budget',
      description: '',
      controller_type: 'dropdown',
      controller_props: { value: reasoning.level },
    }
  }
  return { ...(model ?? {}), id: model?.id ?? modelId, settings } as Model
}

/**
 * Build one turn's reasoning fields.
 *
 * - llama.cpp: `chat_template_kwargs.enable_thinking` for On/Off, and the
 *   Thinking Budget resolved against the live context size, then clamped
 *   against this turn's output cap -- the same rules chat applies.
 * - openai / anthropic / google / gemini: native `providerOptions`.
 * - any other OpenAI-compatible reasoning model: `reasoning_effort` in the
 *   body.
 *
 * Empty for a participant with no setting, or a provider none of these reach.
 */
export async function buildParticipantReasoningRequest(
  providerId: string,
  model: Model | undefined,
  modelId: string,
  reasoning: ParticipantReasoning | undefined,
  maxOutputTokens: number
): Promise<ParticipantReasoningRequest> {
  const applicable = applicableParticipantReasoning(
    providerId,
    model,
    reasoning
  )
  if (!applicable) return { params: {} }
  const resolved = withParticipantReasoning(model, modelId, applicable)
  const params: Record<string, unknown> = {
    ...buildLlamacppReasoningParams(providerId, applicable.mode),
  }
  if (providerId === 'llamacpp') {
    const budget = await resolveThinkingBudgetTokens(resolved, modelId)
    if (budget !== undefined) {
      params.thinking_budget_tokens = clampThinkingBudget(
        budget,
        maxOutputTokens
      )
    }
  }
  const body = buildReasoningBodyParams(providerId, resolved)
  if (body) Object.assign(params, body)
  const providerOptions = buildReasoningProviderOptions(providerId, resolved)
  return providerOptions ? { params, providerOptions } : { params }
}
