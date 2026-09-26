import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UIMessage } from 'ai'
import { chatFollowUp } from '../chatSteering'
import { useMessageQueue } from '@/stores/message-queue-store'

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
