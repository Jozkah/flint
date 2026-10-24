import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UIMessage } from 'ai'
import {
  chatFollowUp,
  holdQueueThenStop,
  nextChatTurn,
  stopChatTurn,
  withdrawApprovalsForSteering,
} from '../chatSteering'
import { useMessageQueue } from '@/stores/message-queue-store'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'

const q = () => useMessageQueue.getState()

const answeredToolRound: UIMessage[] = [
  { id: 'u', role: 'user', parts: [{ type: 'text', text: 'do it' }] },
  {
    id: 'a',
    role: 'assistant',
    parts: [
      { type: 'step-start' },
      {
        type: 'tool-read',
        toolCallId: 't1',
        state: 'output-available',
        input: {},
        output: 'ok',
      },
    ],
  } as UIMessage,
]
const finalAnswer: UIMessage[] = [
  { id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
  { id: 'a', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
]

const run = (messages: UIMessage[], aborted = false) => {
  const send = vi.fn()
  const followUp = chatFollowUp({
    messages,
    aborted,
    takeSteering: () => q().takeSteering('T'),
    send,
  })
  return { followUp, send }
}

describe('post-tool-batch seam', () => {
  it('reports the finished batch, with every tool name in call order', () => {
    const onBatchFinished = vi.fn()
    const messages = [
      answeredToolRound[0],
      {
        id: 'a2',
        role: 'assistant',
        parts: [
          { type: 'tool-ls', toolCallId: 'c1', state: 'output-available', input: {}, output: '' },
          { type: 'dynamic-tool', toolName: 'mcp_x', toolCallId: 'c2', state: 'output-available', input: {}, output: '' },
        ],
      } as UIMessage,
    ]
    chatFollowUp({ messages, aborted: false, takeSteering: () => [], send: vi.fn(), onBatchFinished })
    expect(onBatchFinished).toHaveBeenCalledWith({ key: 'a2:c1,c2', names: ['ls', 'mcp_x'] })
  })

  it('reports only the latest step of the tool loop, not the earlier steps of the same message', () => {
    const onBatchFinished = vi.fn()
    const messages = [
      answeredToolRound[0],
      {
        id: 'a4',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          { type: 'tool-ls', toolCallId: 'c1', state: 'output-available', input: {}, output: '' },
          { type: 'tool-read', toolCallId: 'c2', state: 'output-available', input: {}, output: '' },
          { type: 'step-start' },
          { type: 'tool-read', toolCallId: 'c3', state: 'output-available', input: {}, output: '' },
        ],
      } as UIMessage,
    ]
    chatFollowUp({ messages, aborted: false, takeSteering: () => [], send: vi.fn(), onBatchFinished })
    expect(onBatchFinished).toHaveBeenCalledWith({ key: 'a4:c3', names: ['read'] })
  })

  it('says nothing while a call is unanswered, after a stop, or for a plain reply', () => {
    const onBatchFinished = vi.fn()
    const pending = [
      answeredToolRound[0],
      {
        id: 'a3',
        role: 'assistant',
        parts: [{ type: 'tool-ls', toolCallId: 'c1', state: 'input-available', input: {} }],
      } as UIMessage,
    ]
    const base = { takeSteering: () => [], send: vi.fn(), onBatchFinished }
    chatFollowUp({ ...base, messages: pending, aborted: false })
    chatFollowUp({ ...base, messages: answeredToolRound, aborted: true })
    chatFollowUp({ ...base, messages: finalAnswer, aborted: false })
    expect(onBatchFinished).not.toHaveBeenCalled()
  })
})

describe('chat steering at the tool loop safe point', () => {
  beforeEach(() => useMessageQueue.setState({ queues: {} }))

  it('follows up as usual when nothing is marked to steer', () => {
    q().enqueue('T', { id: '1', text: 'later', createdAt: 1 })
    const { followUp, send } = run(answeredToolRound)
    expect(followUp).toBe(true)
    expect(send).not.toHaveBeenCalled()
    // A plain queued message waits for the run to end.
    expect(q().getQueue('T').map((m) => m.id)).toEqual(['1'])
  })

  it('sends steering in queue order in place of the follow-up', () => {
    q().enqueue('T', { id: '1', text: 'first', createdAt: 1, steer: true })
    q().enqueue('T', { id: '2', text: 'later', createdAt: 2 })
    q().enqueue('T', { id: '3', text: 'second', createdAt: 3, steer: true })
    const { followUp, send } = run(answeredToolRound)
    expect(followUp).toBe(false)
    expect(send).toHaveBeenCalledWith('first\n\nsecond')
    expect(q().getQueue('T').map((m) => m.id)).toEqual(['2'])
  })

  it('takes nothing before the tool round is answered or after a final answer', () => {
    q().enqueue('T', { id: '1', text: 'steer', createdAt: 1, steer: true })
    expect(run(finalAnswer).followUp).toBe(false)
    const pending = structuredClone(answeredToolRound)
    ;(pending[1].parts[1] as { state: string }).state = 'input-available'
    expect(run(pending).followUp).toBe(false)
    // Still queued: if the run ends first it goes as the next message.
    expect(q().getQueue('T')).toHaveLength(1)
  })

  it('delivers nothing into a stopped run', () => {
    q().enqueue('T', { id: '1', text: 'steer', createdAt: 1, steer: true })
    const { followUp, send } = run(answeredToolRound, true)
    expect(followUp).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(q().getQueue('T')).toHaveLength(1)
  })
})

describe('steer when the model answers without a tool call', () => {
  beforeEach(() => useMessageQueue.setState({ queues: {} }))

  it('goes as the immediate next turn, marked steered, ahead of plain queued', () => {
    q().enqueue('T', { id: '1', text: 'plain', createdAt: 1 })
    q().enqueue('T', { id: '2', text: 'steer me', createdAt: 1 })
    q().steerNow('T', '2')
    // No safe point: the answer had no tool call, so nothing was taken.
    const send = vi.fn()
    expect(
      chatFollowUp({
        messages: finalAnswer,
        aborted: false,
        takeSteering: () => q().takeSteering('T'),
        send,
      })
    ).toBe(false)
    expect(send).not.toHaveBeenCalled()
    // The run has ended: the steer goes first, marked.
    expect(nextChatTurn('T')).toEqual({ text: 'steer me', steered: true })
    expect(nextChatTurn('T')).toEqual({ text: 'plain', steered: false })
    expect(nextChatTurn('T')).toBeNull()
  })

  it('joins several steers into one turn, in queue order', () => {
    q().enqueue('T', { id: '1', text: 'a', createdAt: 1, steer: true })
    q().enqueue('T', { id: '2', text: 'b', createdAt: 1, steer: true })
    expect(nextChatTurn('T')).toEqual({ text: 'a\n\nb', steered: true })
  })
})

describe('Stop holds the queue (Chat and Cowork)', () => {
  beforeEach(() => useMessageQueue.setState({ queues: {} }))

  it('holds every queued message, then stops, and clears nothing', () => {
    q().enqueue('S', { id: '1', text: 'one', createdAt: 1 })
    q().enqueue('S', { id: '2', text: 'two', createdAt: 1, steer: true })
    q().enqueue('other', { id: '3', text: 'three', createdAt: 1 })
    let heldAtStop: boolean[] = []
    holdQueueThenStop(['S'], () => {
      // Held before the run is stopped: no last safe point can take it.
      heldAtStop = q().getQueue('S').map((m) => !!m.held)
      expect(q().takeSteering('S')).toEqual([])
    })
    expect(heldAtStop).toEqual([true, true])
    expect(q().getQueue('S')).toHaveLength(2)
    // Another session's queue is untouched by a stop of this one.
    expect(q().getQueue('other')[0].held).toBeUndefined()
  })

  it('stops even with nothing queued or no queue id', () => {
    const stop = vi.fn()
    holdQueueThenStop([''], stop)
    expect(stop).toHaveBeenCalledOnce()
  })
})

describe('chat queue after a stream error', () => {
  beforeEach(() => useMessageQueue.setState({ queues: {} }))

  it('holds what was queued instead of clearing it or sending it', () => {
    q().enqueue('T', { id: '1', text: 'one', createdAt: 1 })
    q().enqueue('T', { id: '2', text: 'two', createdAt: 1, steer: true })
    // What the chat does when status turns to 'error'.
    q().holdQueue('T')
    expect(q().getQueue('T').map((m) => [m.id, m.held, m.steer])).toEqual([
      ['1', true, undefined],
      ['2', true, undefined],
    ])
    expect(nextChatTurn('T')).toBeNull()
    expect(q().getQueue('T')).toHaveLength(2)
  })

  it('sends a held message once the user presses Send, and drops it on Discard', () => {
    q().enqueue('T', { id: '1', text: 'one', createdAt: 1 })
    q().enqueue('T', { id: '2', text: 'two', createdAt: 1 })
    q().holdQueue('T')
    q().release('T', '2')
    expect(nextChatTurn('T')).toEqual({ text: 'two', steered: false })
    q().removeMessage('T', '1')
    expect(q().getQueue('T')).toEqual([])
  })
})

describe('steering while a tool call waits for approval', () => {
  it('withdraws the waiting prompts of the thread so the loop can reach the safe point', () => {
    const resolve = vi.fn()
    useToolApprovalRequests.setState({
      pending: {
        c1: {
          requestId: 'r1',
          toolCallId: 'c1',
          toolName: 'bash',
          threadId: 't1',
          resolve,
        },
      },
      queued: {},
    })
    withdrawApprovalsForSteering('t1')
    expect(resolve).toHaveBeenCalledWith(false)
    expect(useToolApprovalRequests.getState().pending).toEqual({})
    expect(useToolApprovalRequests.getState().refusals.c1).toBe('cancelled')
  })
})

describe('stopChatTurn (Stop on a running tool call)', () => {
  it('ends the turn: the cancelled tool result is not sent back to the model', () => {
    // A tool is running: the turn's tool loop holds a live controller.
    const toolAbort = { current: new AbortController() as AbortController | null }
    const order: string[] = []
    stopChatTurn({
      toolAbort,
      stopDelegation: () => order.push('delegation'),
      stopStream: () => order.push('stream'),
    })
    expect(toolAbort.current?.signal.aborted).toBe(true)
    expect(order).toEqual(['delegation', 'stream'])
    // The cancelled call then lands as a finished tool round; the SDK asks
    // whether to resubmit, as ThreadConversation computes it.
    const aborted = !toolAbort.current || toolAbort.current.signal.aborted
    const send = vi.fn()
    expect(
      chatFollowUp({
        messages: answeredToolRound,
        aborted,
        takeSteering: () => [],
        send,
      })
    ).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('cancels the MCP call in flight first, so the server hears it at Stop (M-011)', () => {
    const order: string[] = []
    stopChatTurn({
      toolAbort: { current: new AbortController() },
      stopDelegation: () => order.push('delegation'),
      stopStream: () => order.push('stream'),
      cancelToolCall: () => order.push('cancel'),
    })
    expect(order).toEqual(['cancel', 'delegation', 'stream'])
  })

  it('is safe with no tool loop running', () => {
    const stopStream = vi.fn()
    stopChatTurn({ toolAbort: { current: null }, stopDelegation: () => {}, stopStream })
    expect(stopStream).toHaveBeenCalledOnce()
  })
})

describe('a step that only thought after tool work', () => {
  const thoughtOnly = (id: string): UIMessage[] => [
    { id: 'u', role: 'user', parts: [{ type: 'text', text: 'compare' }] },
    {
      id,
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        {
          type: 'tool-web_search',
          toolCallId: 'c1',
          state: 'output-available',
          input: {},
          output: 'ok',
        },
        { type: 'step-start' },
        { type: 'reasoning', text: 'Let me search for both in parallel.', state: 'done' },
      ],
    } as UIMessage,
  ]
  const args = (messages: UIMessage[]) => ({
    messages,
    aborted: false,
    takeSteering: () => [],
    send: vi.fn(),
  })

  it('sends another request, at most twice per reply', () => {
    const msgs = thoughtOnly('t1')
    expect(chatFollowUp(args(msgs))).toBe(true)
    expect(chatFollowUp(args(msgs))).toBe(true)
    expect(chatFollowUp(args(msgs))).toBe(false)
  })

  it('retries an empty step after a failed search', () => {
    const msgs = thoughtOnly('t4')
    const parts = msgs[1].parts as Array<Record<string, unknown>>
    parts[1] = {
      type: 'tool-web_search',
      toolCallId: 'c1',
      state: 'output-error',
      input: {},
      errorText: 'Error: Web search is rate limited right now (DuckDuckGo)',
    }
    parts.pop()
    expect(chatFollowUp(args(msgs))).toBe(true)
  })

  it('does not retry a reply with no tool work', () => {
    const msgs: UIMessage[] = [
      { id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 't5', role: 'assistant', parts: [{ type: 'step-start' }] } as UIMessage,
    ]
    expect(chatFollowUp(args(msgs))).toBe(false)
  })

  it('does not retry a reply that answered in text', () => {
    const msgs = thoughtOnly('t2')
    ;(msgs[1].parts as unknown[]).push({ type: 'text', text: 'Here it is.' })
    expect(chatFollowUp(args(msgs))).toBe(false)
  })

  it('does not retry a stopped run', () => {
    expect(chatFollowUp({ ...args(thoughtOnly('t3')), aborted: true })).toBe(false)
  })
})
