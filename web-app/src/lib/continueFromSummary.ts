import { ulid } from 'ulidx'
import { ChatCompletionRole, ContentType, MessageStatus } from '@janhq/core'
import type { ThreadMessage } from '@janhq/core'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { useMessages } from '@/hooks/useMessages'
import { useThreads } from '@/hooks/useThreads'
import { useAppState } from '@/hooks/useAppState'
import { transcriptForSummary } from '@/lib/compaction'
import { extractSummary } from '@/lib/context-manager'
import { modelSummarizer } from '@/lib/compactionSummarizer'
import { messagesToFork } from '@/lib/forkThread'
import { convertThreadMessagesToUIMessages } from '@/lib/messages'

/**
 * Continue a chat in a new one that starts from a summary of it.
 *
 * The new chat keeps the model, the assistant, the project and the attached
 * folders, and holds ONE message: the summary, with a pointer back to the
 * chat it came from. The source chat is marked as continued in the new one and
 * is otherwise left alone.
 */

export const SUMMARY_CONTINUE_TITLE_SUFFIX = ' (continued)'
/** Thread metadata the continuation inherits, as a fork does. */
const THREAD_METADATA_KEPT = ['project', 'folders']
/** Engines that run the model in this app and need it loaded to answer. */
const LOCAL_PROVIDERS = new Set(['llamacpp', 'mlx'])

export type ContinueFromSummaryErrorCode =
  | 'no-chat'
  | 'empty'
  | 'no-model'
  | 'model-not-loaded'
  | 'summary-failed'

export class ContinueFromSummaryError extends Error {
  constructor(
    readonly code: ContinueFromSummaryErrorCode,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'ContinueFromSummaryError'
  }
}

/** The continued chat's title: the original's, marked once however often it is continued. */
export function continuedTitle(title: string | undefined): string {
  const base = (title ?? '').trim() || 'New Thread'
  return base.endsWith(SUMMARY_CONTINUE_TITLE_SUFFIX)
    ? base
    : `${base}${SUMMARY_CONTINUE_TITLE_SUFFIX}`
}

/** The text of the one message a continued chat opens with. */
export function continuationText(title: string, summary: string): string {
  return (
    `This chat continues an earlier one, "${title.trim() || 'Untitled'}". ` +
    `Here is a summary of it, for reference. It is not a new request.\n\n${summary.trim()}`
  )
}

export type ContinueFromSummaryOptions = {
  signal?: AbortSignal
  /** The model's context window in tokens, when known, so the transcript is cut to fit. */
  window?: number | null
  /** Replaces the model call; tests use this. */
  summarize?: (transcript: string, signal?: AbortSignal) => Promise<string>
}

/**
 * Returns the new thread's id. Throws `ContinueFromSummaryError` with a code
 * the caller maps to a message; nothing is created unless the summary exists.
 */
export async function continueFromSummary(
  threadId: string,
  options: ContinueFromSummaryOptions = {}
): Promise<string> {
  if (threadId === TEMPORARY_CHAT_ID) throw new ContinueFromSummaryError('no-chat')
  const threads = useThreads.getState()
  const source = threads.threads[threadId]
  if (!source || source.metadata?.isTemporary) {
    throw new ContinueFromSummaryError('no-chat')
  }
  const model = source.model
  if (!model?.id || !model.provider) throw new ContinueFromSummaryError('no-model')

  const shown = messagesToFork(useMessages.getState().getMessages(threadId))
  const transcript = transcriptForSummary(convertThreadMessagesToUIMessages(shown))
  if (!transcript.trim()) throw new ContinueFromSummaryError('empty')

  // A local model that is not loaded cannot write the summary; say so rather
  // than starting an engine load as a side effect of a menu click.
  if (
    LOCAL_PROVIDERS.has(model.provider) &&
    !useAppState.getState().activeModels.includes(model.id)
  ) {
    throw new ContinueFromSummaryError('model-not-loaded')
  }

  const summarize =
    options.summarize ??
    modelSummarizer({
      provider: model.provider,
      modelId: model.id,
      session: `continue-${threadId}`,
      window: options.window,
    })

  let summary: string
  try {
    // The summarizer may answer in its <analysis>/<summary> blocks; keep only the summary.
    summary = extractSummary((await summarize(transcript, options.signal)) ?? '')
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new ContinueFromSummaryError(
      'summary-failed',
      error instanceof Error ? error.message : String(error)
    )
  }
  if (!summary) throw new ContinueFromSummaryError('summary-failed', 'empty summary')

  // The summary can take minutes on a local model: the user may have cancelled,
  // or deleted the chat, meanwhile. Create nothing then.
  if (options.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  if (!useThreads.getState().threads[threadId]) {
    throw new ContinueFromSummaryError('no-chat')
  }

  const project = source.metadata?.project as
    | { id: string; name: string; updated_at: number }
    | undefined
  const created = await threads.createThread(
    model,
    continuedTitle(source.title),
    source.assistants?.[0],
    project
  )

  const kept: Record<string, unknown> = {}
  for (const key of THREAD_METADATA_KEPT) {
    if (source.metadata?.[key] !== undefined) kept[key] = source.metadata[key]
  }
  useThreads.getState().updateThread(created.id, {
    assistants: source.assistants,
    metadata: {
      ...(created.metadata ?? {}),
      ...kept,
      continuedFrom: { threadId, title: source.title ?? '' },
    },
  })

  const now = Date.now()
  const seed: ThreadMessage = {
    type: 'text',
    role: ChatCompletionRole.User,
    content: [
      {
        type: ContentType.Text,
        text: { value: continuationText(source.title ?? '', summary), annotations: [] },
      },
    ],
    id: ulid(),
    object: 'thread.message',
    thread_id: created.id,
    status: MessageStatus.Ready,
    created_at: now,
    completed_at: now,
    metadata: {
      parentId: null,
      continuedFrom: { threadId, title: source.title ?? '' },
    },
  }
  useMessages.getState().addMessage(seed)

  // The source records where it went on, so the pair can be followed both ways.
  const fresh = useThreads.getState().threads[threadId]
  if (fresh) {
    useThreads.getState().updateThread(threadId, {
      metadata: { ...(fresh.metadata ?? {}), continuedIn: created.id },
    })
  }
  return created.id
}
