import type { LanguageModel } from 'ai'
import { runUtilityAgent } from '@/lib/utilityAgents'
import { ModelFactory } from '@/lib/model-factory'
import { useModelProvider } from '@/hooks/useModelProvider'
import { BACKGROUND_SLOT_ID } from '@/constants/models'
import { SUMMARY_SYSTEM_PROMPT, type Summarize } from '@/lib/compaction'

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
      system: SUMMARY_SYSTEM_PROMPT,
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
