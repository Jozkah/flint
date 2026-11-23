import { describe, it, expect } from 'vitest'
import { Chat } from '@ai-sdk/react'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import { chatFollowUp, markTurnStopped, toolLoopAborted } from '../chatSteering'

const chunk = (c: Record<string, unknown>) => c as unknown as UIMessageChunk
const streamOf = (chunks: UIMessageChunk[]) =>
  new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })

const toolStep = [
  chunk({ type: 'start' }),
  chunk({ type: 'start-step' }),
  chunk({ type: 'tool-input-available', toolCallId: 'c1', toolName: 'read_text_file', input: {} }),
  chunk({ type: 'finish-step' }),
  chunk({ type: 'finish', messageMetadata: { finishReason: 'tool-calls' } }),
]
// What a model returns when it answers nothing after a tool result.
const emptyStep = [
  chunk({ type: 'start' }),
  chunk({ type: 'start-step' }),
  chunk({ type: 'finish-step' }),
  chunk({ type: 'finish', messageMetadata: { finishReason: 'stop' } }),
]
const answer = [
  chunk({ type: 'start' }),
  chunk({ type: 'start-step' }),
  chunk({ type: 'text-start', id: 't' }),
  chunk({ type: 'text-delta', id: 't', delta: 'The file says hello.' }),
  chunk({ type: 'text-end', id: 't' }),
  chunk({ type: 'finish-step' }),
  chunk({ type: 'finish', messageMetadata: { finishReason: 'stop' } }),
]

/**
 * The Chat's wiring, as ThreadConversation builds it: the AI SDK's own loop,
 * `chatFollowUp` as `sendAutomaticallyWhen`, and a tool loop that answers the
 * call and then drops its controller (chatToolLoop.ts) while the model's next
 * request is already under way.
 */
async function runTurn(
  steps: UIMessageChunk[][],
  idPrefix: string,
  { hangAfterTool = false, stopAfterMs = 0 } = {}
) {
  const toolAbort: { current: AbortController | null } = { current: null }
  const requests: UIMessage[][] = []
  const transport: ChatTransport<UIMessage> = {
    sendMessages: async ({ messages, abortSignal }) => {
      requests.push(structuredClone(messages))
      if (hangAfterTool && requests.length > 1) {
        // A reply that never comes; Stop ends it the way streamText does: an
        // abort part, then a clean close.
        return new ReadableStream<UIMessageChunk>({
          start(controller) {
            controller.enqueue(chunk({ type: 'start' }))
            controller.enqueue(chunk({ type: 'start-step' }))
            abortSignal?.addEventListener('abort', () => {
              controller.enqueue(chunk({ type: 'abort' }))
              controller.close()
            })
          },
        })
      }
      return streamOf(steps[Math.min(requests.length - 1, steps.length - 1)])
    },
    reconnectToStream: async () => null,
  }
  let n = 0
  const chat: Chat<UIMessage> = new Chat<UIMessage>({
    id: idPrefix,
    generateId: () => `${idPrefix}-${n++}`,
    transport,
    sendAutomaticallyWhen: ({ messages }) =>
      chatFollowUp({
        messages,
        aborted: toolLoopAborted(toolAbort),
        takeSteering: () => [],
        send: () => {},
      }),
    onFinish: ({ message, isAbort }) => {
      // As createChatFinishHandler does, after its tool-loop call.
      if (isAbort) markTurnStopped(toolAbort)
      const call = message.parts.find(
        (p) => p.type === 'tool-read_text_file' && (p as { state?: string }).state === 'input-available'
      )
      if (!call) return
      // The tool loop: a controller for the run, the result, then released.
      toolAbort.current = new AbortController()
      void (async () => {
        await Promise.resolve()
        await chat.addToolOutput({
          tool: 'read_text_file',
          toolCallId: 'c1',
          output: 'hello',
        } as never)
        toolAbort.current = null
      })()
    },
  })
  const sent = chat.sendMessage({ text: 'read it' })
  if (stopAfterMs) {
    await new Promise((r) => setTimeout(r, stopAfterMs))
    await chat.stop()
  }
  await sent
  // Let the SDK's chained follow-up requests settle.
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 5))
  return { requests, chat }
}

describe('a model step that answers nothing after a tool result', () => {
  it('is asked again instead of ending the run (the retry was unreachable once the tool loop released its controller)', async () => {
    const { requests, chat } = await runTurn([toolStep, emptyStep, answer], 'retry')
    // request 1: the user turn; 2: after the tool result (empty); 3: the retry.
    expect(requests).toHaveLength(3)
    const last = chat.messages[chat.messages.length - 1]
    expect(
      last.parts.some((p) => p.type === 'text' && p.text.includes('hello'))
    ).toBe(true)
  })

  it('gives up after two retries when the model keeps answering nothing', async () => {
    const { requests } = await runTurn([toolStep, emptyStep], 'giveup')
    expect(requests).toHaveLength(4)
  })

  it('Stop on a reply that never comes ends the run: no request follows it', async () => {
    const { requests, chat } = await runTurn([toolStep], 'stop', {
      hangAfterTool: true,
      stopAfterMs: 200,
    })
    // 1: the user turn; 2: after the tool result, hung and stopped. Nothing
    // is sent in answer to the stop (the empty-step retry used to be).
    expect(requests).toHaveLength(2)
    expect(chat.status).toBe('ready')
  })

  it('does not resubmit after Stop aborted the tool loop', async () => {
    const aborted = new AbortController()
    aborted.abort()
    expect(toolLoopAborted({ current: aborted })).toBe(true)
    expect(toolLoopAborted({ current: null })).toBe(false)
  })
})
