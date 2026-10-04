import type { UIMessageChunk } from 'ai'

/**
 * Pass a stream through, and when it fails before any reply content with an
 * error chunk that `shouldRetry` accepts, swallow that error and continue with
 * the stream `resend` returns. The resent stream's opening chunks were already
 * delivered by the first one, so duplicates of them are dropped (its message
 * metadata still goes through). Nothing the chat already showed is taken back.
 */
export function withEarlyRetry(
  first: ReadableStream<UIMessageChunk>,
  shouldRetry: (errorText: string) => boolean | Promise<boolean>,
  resend: () => Promise<ReadableStream<UIMessageChunk>>
): ReadableStream<UIMessageChunk> {
  let source = first.getReader()
  let retried = false
  let sawContent = false
  let sentStart = false
  let sentStep = false
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await source.read()
        if (done) {
          controller.close()
          return
        }
        if (
          !sawContent &&
          !retried &&
          value.type === 'error' &&
          (await shouldRetry(
            String((value as { errorText?: unknown }).errorText ?? '')
          ))
        ) {
          retried = true
          void source.cancel().catch(() => {})
          try {
            source = (await resend()).getReader()
          } catch (error) {
            controller.error(error)
            return
          }
          continue
        }
        if (retried && value.type === 'start' && sentStart) {
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
