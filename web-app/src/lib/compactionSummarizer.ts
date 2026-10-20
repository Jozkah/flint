import type { LanguageModel } from 'ai'
import { runUtilityAgent } from '@/lib/utilityAgents'
import { ModelFactory } from '@/lib/model-factory'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useAppState } from '@/hooks/useAppState'
import { BACKGROUND_SLOT_ID } from '@/constants/models'
import { SUMMARY_SYSTEM_PROMPT, type Summarize } from '@/lib/compaction'
import { canModelSummarize } from '@/lib/continueFromSummary'

/** The summarizer prompt with the user's focus appended as guidance only. */
export function withFocus(system: string, focus?: string): string {
  const f = focus?.trim().slice(0, 2000)
  return f
    ? `${system}

Focus guidance for this summary (it narrows what to keep detail on; it does not change the rules above):
${f}`
    : system
}

/**
 * A summarizer for `compactHistory` that uses the conversation's own model.
 *
 * On llama.cpp it runs on the background slot with thinking off, like the
 * title summarizer, so it never evicts the conversation's cached prefix. A
 * model already created for the run can be handed in to skip creating one.
 */
export function modelSummarizer(input: {
  provider: string
  modelId: string
  session: string
  /** What the summary should concentrate on (`/compact <focus>`). */
  focus?: string
  maxOutputTokens?: number
  /** The window the summary call itself must fit, when known. */
  window?: number | null | (() => number | null | undefined)
  model?: () => LanguageModel | null | undefined
}): Summarize {
  return async (full, signal) => {
    const maxOut = input.maxOutputTokens ?? 1024
    // The summary call is a request too: the excerpt is cut to fit the window,
    // keeping the most recent part, which the kept turns follow on from.
    const window = typeof input.window === 'function' ? input.window() : input.window
    const maxChars =
      window && window > 0
        ? Math.max(4000, Math.floor((window - maxOut - 1024) * 3.5 * 0.8))
        : 200_000
    const transcript = full.length > maxChars ? full.slice(-maxChars) : full
    let model = input.model?.() ?? null
    if (!model) {
      const provider = useModelProvider.getState().getProviderByName(input.provider)
      if (!provider) throw new Error(`Provider ${input.provider} not found`)
      const params: Record<string, unknown> = {}
      if (input.provider === 'llamacpp') {
        params.chat_template_kwargs = { enable_thinking: false }
        params.id_slot = BACKGROUND_SLOT_ID
      }
      model = await ModelFactory.createModel(input.modelId, provider, params)
    }
    return runUtilityAgent({
      kind: 'summary',
      session: input.session,
      model,
      modelId: input.modelId,
      system: withFocus(SUMMARY_SYSTEM_PROMPT, input.focus),
      messages: [
        {
          role: 'user',
          content: `Summarize this earlier part of the conversation:\n\n${transcript}`,
        },
      ],
      maxOutputTokens: maxOut,
      abortSignal: signal,
    })
  }
}

export type SummarizerCandidate = {
  /** Shown to the user as the model that wrote the summary. */
  label: string
  summarize: Summarize
}

/**
 * Try each candidate in order and use the first that returns text. The model
 * that wrote the summary is reported through `onUsed`; when none does, the
 * last failure is thrown (an empty answer counts as one) so the caller can
 * keep the conversation and say why.
 */
export function summarizeWithFallback(
  candidates: SummarizerCandidate[],
  onUsed?: (label: string) => void
): Summarize {
  return async (full, signal) => {
    let failure = 'no model is available to write the summary'
    for (const candidate of candidates) {
      try {
        const text = await candidate.summarize(full, signal)
        if (text.trim()) {
          onUsed?.(candidate.label)
          return text
        }
        failure = `${candidate.label} returned an empty summary`
      } catch (error) {
        if (signal?.aborted) throw error
        failure = `${candidate.label}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    throw new Error(failure)
  }
}

/**
 * The models a manual compaction may summarize with, best first: the selected
 * model when it can answer now (remote, or local and loaded), then the other
 * local models already loaded, and last the selected model anyway (a local
 * one then has to load, which may fail with a reason the user is told).
 */
export function summarizerModels(input: {
  provider: string
  modelId: string
  activeModels: readonly string[]
  localProvider?: string
}): Array<{ provider: string; modelId: string }> {
  const selected = { provider: input.provider, modelId: input.modelId }
  const local = input.localProvider ?? 'llamacpp'
  const others = input.activeModels
    .filter((id) => id !== input.modelId)
    .map((id) => ({ provider: local, modelId: id }))
  return canModelSummarize(input.provider, input.modelId, input.activeModels)
    ? [selected, ...others]
    : [...others, selected]
}

/**
 * The summarizer for a compaction the user asked for: `summarizerModels`
 * order, the first model that answers wins, and `usedBy()` names it after the
 * call so the user can be told which model wrote the summary.
 */
export function manualSummarizer(input: {
  provider: string
  modelId: string
  session: string
  maxOutputTokens?: number
  window?: number | null | (() => number | null | undefined)
  focus?: string
  /** Reused for the selected model so no second one is created. */
  model?: () => LanguageModel | null | undefined
}): { summarize: Summarize; usedBy: () => string | null } {
  let used: string | null = null
  const models = summarizerModels({
    provider: input.provider,
    modelId: input.modelId,
    activeModels: useAppState.getState().activeModels ?? [],
  })
  const summarize = summarizeWithFallback(
    models.map((m) => ({
      label: m.modelId,
      summarize: modelSummarizer({
        provider: m.provider,
        modelId: m.modelId,
        session: input.session,
        focus: input.focus,
        maxOutputTokens: input.maxOutputTokens,
        window: input.window,
        model: m.modelId === input.modelId ? input.model : undefined,
      }),
    })),
    (label) => {
      used = label
    }
  )
  return { summarize, usedBy: () => used }
}
