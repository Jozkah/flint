import { type UIMessageChunk } from 'ai'
import { resolveAutoCompact, isContextLengthError } from '@/lib/compaction'
import { parseServerContextLimit } from '@/lib/contextLimitRecovery'
import { isContextOverflowMessage } from '@/utils/error'
import { getCompactionPolicy } from '@/lib/compactionPolicy'

// Recovery from a provider refusing a request for its length, moved out of
// `CustomChatTransport` unchanged. The class state it touches goes through
// `OverflowRecoveryHost`; the class method delegates here.

export interface OverflowRecoveryHost<O> {
  /** False for Cowork, which compacts and retries in its own run loop. */
  compactsAtThreshold: boolean
  /** Set while a resend is in flight so the compaction runs harder. */
  overflowRetry: { learnedWindow: number | null } | null
  sendWithFallback(options: O): Promise<ReadableStream<UIMessageChunk>>
  getActiveInferenceParams(): Record<string, unknown>
}

export async function sendMessagesCore<O extends { abortSignal?: AbortSignal }>(
  host: OverflowRecoveryHost<O>,
  options: O
): Promise<ReadableStream<UIMessageChunk>> {
  // Cowork compacts and retries in its own run loop.
  if (!host.compactsAtThreshold) return host.sendWithFallback(options)

  // The provider refusing a request for its length is not the end of a run
  // the window could still hold: compact, harder than the estimate asked
  // for, and send it once more. Only before any reply content, so nothing
  // the chat already showed is taken back.
  const refusedForLength = async (failure: unknown): Promise<boolean> => {
    const message =
      failure instanceof Error ? failure.message : String(failure ?? '')
    return (
      !options.abortSignal?.aborted &&
      (isContextLengthError(failure) || isContextOverflowMessage(message)) &&
      (await canRecoverFromOverflow(host))
    )
  }
  const resend = async (
    failure: unknown
  ): Promise<ReadableStream<UIMessageChunk>> => {
    const message =
      failure instanceof Error ? failure.message : String(failure ?? '')
    const learned = parseServerContextLimit(
      (failure as { data?: unknown } | null)?.data ?? null,
      message
    )
    host.overflowRetry = { learnedWindow: learned?.contextTokens ?? null }
    try {
      return await host.sendWithFallback(options)
    } finally {
      host.overflowRetry = null
    }
  }

  let first: ReadableStream<UIMessageChunk>
  try {
    first = await host.sendWithFallback(options)
  } catch (error) {
    if (!(await refusedForLength(error))) throw error
    first = await resend(error)
    return first
  }

  let source = first.getReader()
  let retried = false
  // Chunks pass straight through. An error before any reply content that is
  // a length refusal is swallowed instead, and the resent request's stream
  // continues in its place (its opening chunks were already delivered).
  let sawContent = false
  let sentStart = false
  let sentStep = false
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      for (;;) {
        let next: ReadableStreamReadResult<UIMessageChunk>
        try {
          next = await source.read()
        } catch (error) {
          // Some providers reject the reader instead of emitting an error
          // chunk. Use the same one-time recovery for either representation.
          if (sawContent || retried || !(await refusedForLength(error))) {
            controller.error(error)
            return
          }
          retried = true
          try {
            source = (await resend(error)).getReader()
          } catch (retryError) {
            controller.error(retryError)
            return
          }
          continue
        }
        const { done, value } = next
        if (done) {
          controller.close()
          return
        }
        if (
          !sawContent &&
          !retried &&
          value.type === 'error' &&
          (await refusedForLength(value.errorText))
        ) {
          retried = true
          void source.cancel().catch(() => {})
          try {
            source = (await resend(value.errorText)).getReader()
          } catch (error) {
            controller.error(error)
            return
          }
          continue
        }
        if (retried && value.type === 'start' && sentStart) {
          // Already delivered; its metadata (a compaction the resend made)
          // still has to reach the message.
          const metadata = (value as { messageMetadata?: unknown })
            .messageMetadata
          if (metadata === undefined) continue
          controller.enqueue({
            type: 'message-metadata',
            messageMetadata: metadata,
          } as UIMessageChunk)
          return
        }
        if (retried && value.type === 'start-step' && sentStep) continue
        if (value.type === 'start') sentStart = true
        if (value.type === 'start-step') sentStep = true
        if (!/^(start|start-step|message-metadata)$/.test(value.type)) {
          sawContent = true
        }
        controller.enqueue(value)
        return
      }
    },
    cancel: (reason) => source.cancel(reason),
  })
}

/**
 * Whether a request the provider refused for its length can be compacted
 * and sent again: automatic compaction is on, by summary, and the model does
 * not shift its own context.
 */
async function canRecoverFromOverflow(
  host: OverflowRecoveryHost<unknown>
): Promise<boolean> {
  try {
    const params = host.getActiveInferenceParams()
    const policy = await getCompactionPolicy()
    return (
      resolveAutoCompact(params, policy.auto) && policy.strategy === 'summarize'
    )
  } catch {
    return false
  }
}
