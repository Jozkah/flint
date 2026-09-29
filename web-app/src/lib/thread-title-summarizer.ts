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

export function cleanTitle(raw: string): string | null {
  let text = raw.trim()
  text = text
    .replace(/<(think|thinking|reasoning|analysis)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .trim()
  if (/<(think|thinking|reasoning|analysis)[^>]*>/i.test(text)) return null
  const lastClose = text.match(
    /<\/(?:think|thinking|reasoning|analysis)>\s*([\s\S]*)$/i
  )
  if (lastClose) text = lastClose[1].trim()
  text = text.replace(/<[^>]+>/g, '').trim()
  text = text.replace(/\s+/g, ' ').trim()
  text = text.replace(/^["']+|["']+$/g, '').trim()
  text = text.replace(/[^\p{L}\p{N}\s]/gu, '').trim()
  text = text.split(/\s+/).slice(0, MAX_TITLE_WORDS).join(' ')
  return !text || text.length < 2 ? null : text
}

const FALLBACK_TITLE_WORDS = 6
const FALLBACK_TITLE_CHARS = 60

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

const titleInFlight = new Map<string, Promise<string | null>>()
const titleDone = new Set<string>()

export function resetTitleGuards(): void {
  titleInFlight.clear()
  titleDone.clear()
}

export function generateThreadTitle(
  transcript: string,
  abortSignal: AbortSignal,
  session = '',
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

const ABORTED = Symbol('aborted')

async function requestTitle(
  transcript: string,
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

    if (selectedProvider === 'mlx') return null

    const provider = getProviderByName(selectedProvider)
    if (!provider) {
      console.warn('[ThreadTitle] Provider not found:', selectedProvider)
      return null
    }

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

    const text = await runUtilityAgent({
      kind: 'title',
      session,
      model,
      modelId: selectedModel.id,
      messages: [{ role: 'user', content: buildSummarizePrompt(transcript) }],
      maxOutputTokens: 128,
      abortSignal,
    })
    return cleanTitle(text)
  } catch (error) {
    if ((error as Error).name === 'AbortError') return ABORTED
    console.error(
      '[ThreadTitle] Failed to generate title:',
      (error as Error).name
    )
    return null
  }
}
