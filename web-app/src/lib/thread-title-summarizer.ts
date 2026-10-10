import { engineSlotsIdle } from '@janhq/tauri-plugin-llamacpp-api'
import { runUtilityAgent } from './utilityAgents'
import { ModelFactory } from './model-factory'
import { useModelProvider } from '@/hooks/useModelProvider'
import { resolveThreadModelSelection } from '@/hooks/useConversationPane'
import { BACKGROUND_SLOT_ID } from '@/constants/models'
import { isEngineProviderName } from '@/lib/engineModels'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { resolveFallbackChain, shouldFallback } from '@/lib/fallbackChain'

const MAX_TITLE_WORDS = 10
const MAX_PROMPT_LENGTH = 1500

function buildSummarizePrompt(transcript: string): string {
  const truncated =
    transcript.length > MAX_PROMPT_LENGTH
      ? transcript.slice(0, MAX_PROMPT_LENGTH) + '...'
      : transcript
  return `Summarize the following conversation into a concise title of at most ${MAX_TITLE_WORDS} words. Capture the overall topic, not just the latest turn. Output the title only, no quotes, no explanation.\n\nConversation:\n${truncated}`
}

/**
 * Clean a model-generated title: strip reasoning tags, special characters,
 * quotes, and enforce a word limit. Returns null if the result is unusable.
 */
export function cleanTitle(raw: string): string | null {
  let text = raw.trim()
  // Strip complete reasoning blocks like <think>...</think> (any tag name)
  text = text
    .replace(/<(think|thinking|reasoning|analysis)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .trim()
  // If a reasoning opener remains without a close, the output is all reasoning -- unusable
  if (/<(think|thinking|reasoning|analysis)[^>]*>/i.test(text)) return null
  // If only a closing tag is present, take what's after the last one
  const lastClose = text.match(
    /<\/(?:think|thinking|reasoning|analysis)>\s*([\s\S]*)$/i
  )
  if (lastClose) text = lastClose[1].trim()
  // Remove leftover XML-like tags
  text = text.replace(/<[^>]+>/g, '').trim()
  // Collapse whitespace and newlines into single spaces
  text = text.replace(/\s+/g, ' ').trim()
  // Remove surrounding quotes
  text = text.replace(/^["']+|["']+$/g, '').trim()
  // Keep letters, numbers and spaces (unicode-aware), plus the punctuation
  // that is part of a name: `hello.txt`, `node.js`, `C++`, `snake_case`,
  // `v1-2`, `a/b`. Whatever else the model added around a word is dropped.
  text = text.replace(/[^\p{L}\p{N}\s._+#/'-]/gu, '')
  text = text
    .split(/\s+/)
    .map((word) => word.replace(/^[._/'-]+|[._-]+$/g, ''))
    .filter(Boolean)
    .join(' ')
    .trim()
  // Enforce word limit
  text = text.split(/\s+/).slice(0, MAX_TITLE_WORDS).join(' ')
  return !text || text.length < 2 ? null : text
}

const FALLBACK_TITLE_WORDS = 6
const FALLBACK_TITLE_CHARS = 60

/**
 * A short title cut from the user's own text, for when the model gives none:
 * the first few words, at most 60 characters, so a whole pasted prompt never
 * becomes the chat's title.
 */
export function fallbackTitle(source: string): string | null {
  const words = source
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, FALLBACK_TITLE_WORDS)
  let text = words.join(' ')
  if (text.length > FALLBACK_TITLE_CHARS) {
    text = text.slice(0, FALLBACK_TITLE_CHARS).replace(/\s+\S*$/, '')
  }
  text = text.replace(/[\s,.;:!?-]+$/, '')
  return text.length >= 2 ? text : null
}

/**
 * Title runs per chat, keyed by chat and the first message the title comes
 * from. Guarded here, at the one call that reaches the model, so no caller
 * can title the same chat twice at once or again once it is done -- the audit
 * saw the helper run 51 times for one thread in under four minutes.
 */
const titleInFlight = new Map<string, Promise<string | null>>()
const titleDone = new Set<string>()

/** Forget every guard (tests). */
export function resetTitleGuards(): void {
  titleInFlight.clear()
  titleDone.clear()
}

/**
 * Generate a summarized thread title from the user's first message.
 * Uses the currently selected model via a non-streaming generateText call.
 * Returns null when aborted, when this chat and source were already titled,
 * or when there is nothing to title from; a model that returns nothing usable
 * yields a short title cut from `source` instead.
 */
export function generateThreadTitle(
  transcript: string,
  abortSignal: AbortSignal,
  /** The conversation being titled, for the utility-agent record. */
  session = '',
  /** The first user message the title is for; defaults to the transcript. */
  source = transcript
): Promise<string | null> {
  const key = session ? `${session}\u0000${source}` : ''
  if (key) {
    if (titleDone.has(key)) return Promise.resolve(null)
    const running = titleInFlight.get(key)
    if (running) return running
  }
  const run = (async () => {
    const title = await requestTitle(transcript, abortSignal, session)
    if (title === ABORTED || abortSignal.aborted) return null
    if (key) titleDone.add(key)
    return title ?? fallbackTitle(source)
  })()
  if (!key) return run
  titleInFlight.set(key, run)
  return run.finally(() => {
    if (titleInFlight.get(key) === run) titleInFlight.delete(key)
  })
}

/**
 * A fresh title on the user's request: the same model call as the automatic
 * one, without its once-per-chat guards, and without the cut-from-the-message
 * fallback, since a title the user asked for that is only their first words
 * would be no answer. Null when aborted or the model gave nothing usable.
 */
export async function regenerateThreadTitle(
  transcript: string,
  abortSignal: AbortSignal,
  session: string
): Promise<string | null> {
  const title = await requestTitle(transcript, abortSignal, session)
  return title === ABORTED || abortSignal.aborted ? null : title
}

const ABORTED = Symbol('aborted')

async function requestTitle(
  transcript: string,
  abortSignal: AbortSignal,
  session: string
): Promise<string | null | typeof ABORTED> {
  // Room for a reasoning model to think and still answer: thinking can only be
  // switched off for the local engine, and on a hosted or custom endpoint 128
  // tokens were spent before the title started, leaving the first words of the
  // prompt as the chat's name.
  const text = await runUtilityText(
    'title',
    buildSummarizePrompt(transcript),
    1024,
    abortSignal,
    session
  )
  return typeof text === 'string' ? cleanTitle(text) : text
}

const SUMMARY_CHARS = 600

/**
 * True when the model this conversation uses runs in Flint's own engine on this
 * machine. The hover summary is made only then: it is sent without the user
 * sending anything, so it must never leave the machine.
 */
export function canSummarizeLocally(session: string): boolean {
  const { selectedProvider } = session
    ? resolveThreadModelSelection(session)
    : useModelProvider.getState()
  return !!selectedProvider && isEngineProviderName(selectedProvider)
}

function buildConversationSummaryPrompt(transcript: string): string {
  const truncated =
    transcript.length > MAX_PROMPT_LENGTH
      ? transcript.slice(0, MAX_PROMPT_LENGTH) + '...'
      : transcript
  return `Summarize the conversation below in two short sentences: what it is about and where it stands now. Plain text only, no lists, no quotes, no preamble.\n\nConversation:\n${truncated}`
}

/**
 * Two sentences on what a conversation is about and where it stands, for the
 * preview card of a sidebar row. Null when aborted, when the model cannot be
 * asked right now, or when it gave nothing usable.
 */
export async function summarizeConversation(
  transcript: string,
  abortSignal: AbortSignal,
  session: string
): Promise<string | null> {
  // Privacy: a hover is not a message. Only an engine on this machine may read
  // the transcript for it; a remote provider is never called.
  if (!canSummarizeLocally(session)) return null
  // A local model serves one request at a time. A summary made for a hover
  // must never queue beside a run, so it is skipped while the engine is busy.
  const { selectedProvider, selectedModel } = session
    ? resolveThreadModelSelection(session)
    : useModelProvider.getState()
  if (selectedProvider === 'llamacpp' && selectedModel?.id) {
    try {
      if (!(await engineSlotsIdle(selectedModel.id))) return null
    } catch {
      // Not reachable: the call below fails the same way and returns null.
    }
  }
  const text = await runUtilityText(
    'summary',
    buildConversationSummaryPrompt(transcript),
    200,
    abortSignal,
    session
  )
  if (typeof text !== 'string') return null
  const clean = text
    .replace(/<(think|thinking|reasoning|analysis)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (clean.length < 10) return null
  return clean.length > SUMMARY_CHARS
    ? `${clean.slice(0, SUMMARY_CHARS).replace(/\s+\S*$/, '')}...`
    : clean
}

/** The call is background work: it never holds a chat for longer than this. */
const UTILITY_TIMEOUT_MS = 30_000
/** The chosen model plus at most this many fallbacks. */
const UTILITY_MAX_FALLBACKS = 2

type Candidate = { selectedProvider: string; selectedModel: { id: string } }

async function runUtilityText(
  kind: 'title' | 'summary',
  prompt: string,
  maxOutputTokens: number,
  abortSignal: AbortSignal,
  session: string
): Promise<string | null | typeof ABORTED> {
  try {
    // A title is part of its conversation, so use that conversation's persisted
    // model rather than whichever model picker happened to be touched last.
    // This matters especially in split view, where another pane can change the
    // global selection while this turn is finishing.
    const selection = session
      ? resolveThreadModelSelection(session)
      : useModelProvider.getState()
    const { selectedModel, selectedProvider } = selection
    const { getProviderByName, providers } = useModelProvider.getState()
    if (!selectedModel || !selectedProvider) {
      console.warn('[ThreadTitle] No model/provider selected')
      return null
    }

    // MLX models often emit reasoning that can't be reliably suppressed; fall back to default title.
    if (selectedProvider === 'mlx') return null

    if (!getProviderByName(selectedProvider)) {
      console.warn('[ThreadTitle] Provider not found:', selectedProvider)
      return null
    }

    // The chosen model first, then the user's fallback chain, as chat does
    // (`shouldFallback`: only a failure another model could fix). A hover
    // summary never leaves the machine, so its chain is local engines only.
    const chain = resolveFallbackChain(
      useGeneralSetting.getState().fallbackModels,
      { provider: selectedProvider, modelId: selectedModel.id },
      providers ?? []
    )
      .filter(
        (c) =>
          c.selectedProvider !== 'mlx' &&
          (kind !== 'summary' || isEngineProviderName(c.selectedProvider))
      )
      .slice(0, UTILITY_MAX_FALLBACKS)
    const candidates: Candidate[] = [
      { selectedProvider, selectedModel },
      ...chain,
    ]

    // Never held open by a model that does not answer.
    // AbortSignal.any() is missing on older WebKit (Safari < 17.4), so combine
    // the signals by hand.
    const combined = new AbortController()
    setTimeout(
      () => combined.abort(new DOMException('Timed out', 'TimeoutError')),
      UTILITY_TIMEOUT_MS
    )
    if (abortSignal.aborted) {
      combined.abort(abortSignal.reason)
    } else {
      abortSignal.addEventListener(
        'abort',
        () => combined.abort(abortSignal.reason),
        { once: true }
      )
    }
    const signal = combined.signal

    for (let i = 0; i < candidates.length; i++) {
      const { selectedProvider: providerId, selectedModel: modelInfo } =
        candidates[i]
      try {
        const provider = getProviderByName(providerId)
        if (!provider) {
          if (i === candidates.length - 1) return null
          continue
        }
        // Pin to the reserved background slot so this call can never evict a chat
        // request's KV cache. It is a fixed index, not one derived from the
        // "Parallel Sequences" setting: upstream wraps an out-of-range id_slot
        // modulo the slot count instead of rejecting it, so a pin computed from the
        // provider-level value silently landed back on slot 0 whenever the emitted
        // count disagreed -- which a per-model `parallel` override does.
        const params: Record<string, unknown> = {}
        if (providerId === 'llamacpp') {
          params.chat_template_kwargs = { enable_thinking: false }
          params.id_slot = BACKGROUND_SLOT_ID
        }
        const model = await ModelFactory.createModel(
          modelInfo.id,
          provider,
          params
        )

        // A hidden utility agent (AH-208): no tools, not shown, always recorded.
        // Neither the transcript nor the title is logged -- both are the user's
        // conversation, and the webview console is written to the app log.
        return await runUtilityAgent({
          kind,
          session,
          model,
          modelId: modelInfo.id,
          messages: [{ role: 'user', content: prompt }],
          maxOutputTokens,
          abortSignal: signal,
          // One attempt per model: the next model in the chain is the retry.
          maxRetries: 0,
        })
      } catch (error) {
        if (abortSignal.aborted) return ABORTED
        const last = i === candidates.length - 1
        if (
          last ||
          signal.aborted ||
          !shouldFallback(
            error,
            false,
            providerId !== candidates[i + 1].selectedProvider
          )
        ) {
          throw error
        }
      }
    }
    return null
  } catch (error) {
    // Silently swallow abort errors -- this is expected when the user sends a new message
    if (abortSignal.aborted && (error as Error).name === 'AbortError') {
      return ABORTED
    }
    console.error(
      '[ThreadTitle] Failed to generate title:',
      (error as Error).name
    )
    return null
  }
}
