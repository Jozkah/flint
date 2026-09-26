import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { useCallback, useRef, useState } from 'react'
import type { UIMessage } from '@ai-sdk/react'

// Render counts for a transcript while its last message streams. MessageItem
// reads its own error from the message-errors store on every render, so the
// store's `errors` is a proxy that tallies each read under the message id.

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: any) =>
    selector({ selectedModel: { id: 'm1' } }),
}))
vi.mock('../RenderMarkdown', () => ({
  RenderMarkdown: ({ content }: any) => <div>{content}</div>,
}))
const renders = vi.hoisted(() => new Map<string, number>())
vi.mock('@/stores/message-errors', () => {
  const errors = new Proxy(
    {},
    {
      get: (_t, id) => {
        if (typeof id === 'string') renders.set(id, (renders.get(id) ?? 0) + 1)
        return undefined
      },
    }
  )
  const state = { errors, clearError: () => {} }
  const useMessageErrors = (selector: (s: typeof state) => unknown) =>
    selector(state)
  useMessageErrors.getState = () => state
  return { useMessageErrors }
})
vi.mock('@/containers/TokenSpeedIndicator', () => ({ default: () => null }))
vi.mock('@/components/PromptProgress', () => ({ PromptProgress: () => null }))

import { MessageItem } from '../MessageItem'

const MESSAGES = 20
const DELTAS = 50

const initial = (): UIMessage[] =>
  Array.from({ length: MESSAGES }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    parts: [{ type: 'text', text: `message ${i}` }],
    metadata: { createdAt: new Date(0) },
  })) as UIMessage[]

/** Replaces only the last message, the way the AI SDK applies a delta. */
const withDelta = (messages: UIMessage[], delta: string): UIMessage[] => {
  const last = messages[messages.length - 1]
  const text = (last.parts[0] as { text: string }).text + delta
  return [
    ...messages.slice(0, -1),
    { ...last, parts: [{ type: 'text', text }] },
  ]
}

let push: (delta: string) => void = () => {}

/**
 * The transcript as ThreadConversation renders it. `handlersReadRef` picks
 * how the per-message handlers see the transcript: through a ref (current),
 * or by depending on the array (before), which renews them on every delta.
 */
function Transcript({ handlersReadRef }: { handlersReadRef: boolean }) {
  const [messages, setMessages] = useState(initial)
  push = (delta) => setMessages((m) => withDelta(m, delta))
  const ref = useRef(messages)
  ref.current = messages
  const viaRef = useCallback((id: string) => {
    void ref.current.find((m) => m.id === id)
  }, [])
  const viaDeps = useCallback(
    (id: string) => {
      void messages.find((m) => m.id === id)
    },
    [messages]
  )
  const onContinue = handlersReadRef ? viaRef : viaDeps
  return (
    <>
      {messages.map((message, index) => (
        <MessageItem
          key={message.id}
          message={message}
          isFirstMessage={index === 0}
          isLastMessage={index === messages.length - 1}
          status="streaming"
          onContinue={onContinue}
          onDelete={onContinue}
          isAnimating
        />
      ))}
    </>
  )
}

function stream() {
  for (let i = 0; i < DELTAS; i++) act(() => push(' tok'))
}

const completedRenders = () =>
  [...renders.entries()]
    .filter(([id]) => id !== `m${MESSAGES - 1}`)
    .reduce((sum, [, n]) => sum + n, 0)

describe('transcript render counts while streaming', () => {
  beforeEach(() => renders.clear())

  it('re-renders only the streaming message when handlers read a ref', () => {
    render(<Transcript handlersReadRef />)
    const mounted = completedRenders()
    stream()
    // Completed messages rendered once, at mount, and never again.
    expect(completedRenders()).toBe(mounted)
    expect(renders.get(`m${MESSAGES - 1}`)).toBe(1 + DELTAS)
  })

  it('does not re-render completed messages when the handlers are renewed per delta', () => {
    // MessageItem's comparator leaves the callbacks out, so a parent handing
    // it a new handler on every delta still re-renders only the tail.
    render(<Transcript handlersReadRef={false} />)
    const mounted = completedRenders()
    stream()
    expect(completedRenders()).toBe(mounted)
    expect(renders.get(`m${MESSAGES - 1}`)).toBe(1 + DELTAS)
  })
})
