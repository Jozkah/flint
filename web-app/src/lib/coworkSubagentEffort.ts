/**
 * A subagent's own reasoning effort.
 *
 * The child normally reuses the parent's model instance, so the parent's
 * effort rides along. A definition (`effort`) or a `task` call (`effort`) that
 * asks for a different level gets a model instance built with that level, by
 * the same rules a Room participant's reasoning uses (`rooms/participantReasoning`):
 * a level the provider and model do not act on is dropped with a note instead
 * of being sent.
 */
import type { LanguageModel } from 'ai'
import type { JSONObject } from '@ai-sdk/provider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { ModelFactory } from '@/lib/model-factory'
import { clampEffort, isEffortLevel, supportedEffortLevels, type EffortLevel } from '@/lib/modelEffort'
import {
  buildParticipantReasoningRequest,
  participantReasoningControls,
} from '@/lib/rooms/participantReasoning'

/** Output cap the llama.cpp thinking budget is clamped against for a child. */
const CHILD_MAX_OUTPUT_TOKENS = 8192

/** A well-formed effort level, else undefined. */
export function parseEffort(value: unknown): EffortLevel | undefined {
  return isEffortLevel(value) ? value : undefined
}

export type ChildEffortDeps = {
  /** The provider and the model entry as configured, or null when unknown. */
  lookup: (providerId: string, modelId: string) => { provider: ModelProvider; model: Model } | null
  createModel: (
    modelId: string,
    provider: ModelProvider,
    params: Record<string, unknown>
  ) => Promise<LanguageModel>
}

const defaultDeps: ChildEffortDeps = {
  lookup: (providerId, modelId) => {
    const provider = useModelProvider.getState().getProviderByName(providerId)
    const model = provider?.models?.find((m) => m.id === modelId)
    return provider && model ? { provider, model } : null
  },
  createModel: (id, provider, params) => ModelFactory.createModel(id, provider, params),
}

export type ChildEffort =
  | {
      model: LanguageModel
      providerOptions?: Record<string, JSONObject>
      /** The level actually sent, after clamping to what the model offers. */
      level: EffortLevel
      note?: string
    }
  | { note: string }

/**
 * The model instance and per-request options that run a child at `level`, or a
 * note saying why the parent's own setting stays in force.
 */
export async function resolveChildEffort(
  input: { providerId: string; modelId: string; level: EffortLevel },
  deps: ChildEffortDeps = defaultDeps
): Promise<ChildEffort> {
  const found = deps.lookup(input.providerId, input.modelId)
  if (!found) {
    return { note: `effort ${input.level} ignored: model ${input.modelId} is not configured` }
  }
  const controls = participantReasoningControls(input.providerId, found.model)
  const levels = controls.thinkingBudget
    ? supportedEffortLevels(input.providerId, found.model)
    : controls.effortLevels.filter(isEffortLevel)
  const level = clampEffort(input.level, levels)
  if (!level) {
    return { note: `effort ${input.level} ignored: ${input.modelId} has no effort control` }
  }
  try {
    const request = await buildParticipantReasoningRequest(
      input.providerId,
      found.model,
      input.modelId,
      { level },
      CHILD_MAX_OUTPUT_TOKENS
    )
    const model = await deps.createModel(input.modelId, found.provider, request.params)
    return {
      model,
      level,
      ...(request.providerOptions ? { providerOptions: request.providerOptions } : {}),
      ...(level !== input.level ? { note: `effort ${input.level} is not offered by ${input.modelId}; used ${level}` } : {}),
    }
  } catch (e) {
    return {
      note: `effort ${input.level} not applied (${e instanceof Error ? e.message : String(e)}); used the parent's setting`,
    }
  }
}
