/**
 * A message hit opened from the search dialog must land in the chat with the
 * find bar open on the phrase and the hit scrolled into view, also when the
 * hit is older than the windowed transcript renders. Real SearchDialog, real
 * ConversationFindBar and the same find hook ThreadConversation uses; the
 * router and the stores are stand-ins.
 */
import { StrictMode, useCallback, useRef, useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'

const nav = vi.hoisted(() => ({ to: (_: string) => {} }))
vi.mock('@tanstack/react-router', () => ({
  useNavigate:
    () =>
    ({ params }: { params?: { threadId?: string } }) =>
      nav.to(params?.threadId ?? 'home'),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/hooks/useThreads', () => {
  const state = {
    threads: {},
    getFilteredThreads: () => [],
  }
  const useThreads = (sel: (s: typeof state) => unknown) => sel(state)
  useThreads.getState = () => state
  return { useThreads }
})
const OLD_ID = 'long-m5'
vi.mock('@/lib/messageSearch', () => ({
  searchMessages: async (q: string) =>
    q === 'needleword'
      ? [
          {
            threadId: 'long',
            threadTitle: 'Long chat',
            messageId: OLD_ID,
            role: 'user',
            snippet: 'the old needleword here',
            updated: 1,
          },
        ]
      : [],
}))

import { SearchDialog } from '../dialogs/SearchDialog'
import { ConversationFindBar } from '../ConversationFindBar'
import { useConversationFind, useThreadFind } from '@/hooks/useConversationFind'

const longChat = Array.from({ length: 300 }, (_, i) => ({
  id: `long-m${i}`,
  role: i % 2 ? 'assistant' : 'user',
  parts: [{ type: 'text', text: i === 5 ? 'the old needleword here' : `Q${i} filler` }],
})) as unknown as UIMessage[]
const chats: Record<string, UIMessage[]> = {
  long: longChat,
  other: [
    { id: 'o1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
  ] as unknown as UIMessage[],
}

const WINDOW = 10
/** ThreadConversation in miniature: the find hook, a windowed list, the bar. */
function Thread({ threadId }: { threadId: string }) {
  const { findOpen, findSeed, findWaitsForOther } = useThreadFind(threadId)
  const messages = chats[threadId]
  const [start, setStart] = useState(Math.max(0, messages.length - WINDOW))
  const host = useRef<HTMLDivElement>(null)
  const reveal = useCallback(
    (id: string) => {
      const at = messages.findIndex((m) => m.id === id)
      if (at >= 0) setStart((s) => Math.min(s, at))
    },
    [messages]
  )
  return (
    <div>
      {findOpen && !findWaitsForOther && (
        <ConversationFindBar
          messages={messages}
          root={() => host.current}
          seed={findSeed}
          onClose={() => useConversationFind.getState().setOpen(false)}
          reveal={reveal}
          renderedFrom={start}
        />
      )}
      <div ref={host} data-testid="transcript">
        {messages.slice(start).map((m) => (
          <div key={m.id} data-message-id={m.id}>
            <p>{(m.parts[0] as { text: string }).text}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function App({ initial }: { initial: string }) {
  const [at, setAt] = useState(initial)
  const [dialog, setDialog] = useState(true)
  nav.to = setAt
  return (
    <>
      <SearchDialog open={dialog} onOpenChange={setDialog} />
      {/* A route change remounts the route component, as the router does. */}
      {at === 'home' ? <div>home</div> : <Thread key={at} threadId={at} />}
    </>
  )
}

const scrolled: string[] = []
beforeEach(() => {
  scrolled.length = 0
  localStorage.clear()
  useConversationFind.setState({ open: false, seed: null, owner: null })
  Element.prototype.scrollIntoView = function (this: Element) {
    const id = (this.closest('[data-message-id]') as HTMLElement | null)?.dataset
      .messageId
    if (id) scrolled.push(id)
  }
})

async function enterOnHit(initial: string) {
  render(
    <StrictMode>
      <App initial={initial} />
    </StrictMode>
  )
  const input = await screen.findByRole('textbox')
  fireEvent.change(input, { target: { value: 'needleword' } })
  await screen.findByTestId('search-message-hits', {}, { timeout: 2000 })
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter' })
  })
}

describe('search hit -> chat find bar', () => {
  it.each(['home', 'other'])(
    'from %s: opens the bar on the phrase and scrolls an old message into view',
    async (initial) => {
      await enterOnHit(initial)
      const bar = await screen.findByTestId('conversation-find-bar')
      expect(bar).toBeInTheDocument()
      expect(screen.getByTestId('conversation-find-input')).toHaveValue('needleword')
      await waitFor(() =>
        expect(
          document.querySelector(`[data-message-id="${OLD_ID}"]`)
        ).toBeInTheDocument()
      )
      await waitFor(() => expect(scrolled).toContain(OLD_ID))
      expect(screen.getByTestId('conversation-find-count').textContent).toBe('1 / 1')
    }
  )

  it('the bar does not follow into a chat opened afterwards', async () => {
    await enterOnHit('home')
    await screen.findByTestId('conversation-find-bar')
    act(() => nav.to('other'))
    expect(screen.queryByTestId('conversation-find-bar')).toBeNull()
  })
})
