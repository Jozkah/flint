import { engineSlotsIdle } from '@janhq/tauri-plugin-llamacpp-api'
import { runUtilityAgent } from './utilityAgents'
import { ModelFactory } from './model-factory'
import { useModelProvider } from '@/hooks/useModelProvider'
import { resolveThreadModelSelection } from '@/hooks/useConversationPane'
import { BACKGROUND_SLOT_ID } from '@/constants/models'

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
  // Keep only letters, numbers, and spaces (unicode-aware)
  text = text.replace(/[^\p{L}\p{N}\s]/gu, '').trim()
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
  const text = await runUtilityText(
    'title',
    buildSummarizePrompt(transcript),
    128,
    abortSignal,
    session
  )
  return typeof text === 'string' ? cleanTitle(text) : text
}

const SUMMARY_CHARS = 600

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
    const { getProviderByName } = useModelProvider.getState()
    if (!selectedModel || !selectedProvider) {
      console.warn('[ThreadTitle] No model/provider selected')
      return null
    }

    // MLX models often emit reasoning that can't be reliably suppressed; fall back to default title.
    if (selectedProvider === 'mlx') return null

    const provider = getProviderByName(selectedProvider)
    if (!provider) {
      console.warn('[ThreadTitle] Provider not found:', selectedProvider)
      return null
    }

    // Pin to the reserved background slot so this call can never evict a chat
    // request's KV cache. It is a fixed index, not one derived from the
    // "Parallel Sequences" setting: upstream wraps an out-of-range id_slot
    // modulo the slot count instead of rejecting it, so a pin computed from the
    // provider-level value silently landed back on slot 0 whenever the emitted
    // count disagreed -- which a per-model `parallel` override does.
    const params: Record<string, unknown> = {}
    if (selectedProvider === 'llamacpp') {
      params.chat_template_kwargs = { enable_thinking: false }
      params.id_slot = BACKGROUND_SLOT_ID
    }
    const model = await ModelFactory.createModel(
      selectedModel.id,
      provider,
      params
    )

    // A hidden utility agent (AH-208): no tools, not shown, always recorded.
    // Neither the transcript nor the title is logged -- both are the user's
    // conversation, and the webview console is written to the app log.
    const text = await runUtilityAgent({
      kind,
      session,
      model,
      modelId: selectedModel.id,
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens,
      abortSignal,
    })
    return text
  } catch (error) {
    // Silently swallow abort errors -- this is expected when the user sends a new message
    if ((error as Error).name === 'AbortError') return ABORTED
    console.error(
      '[ThreadTitle] Failed to generate title:',
      (error as Error).name
    )
    return null
  }
}
