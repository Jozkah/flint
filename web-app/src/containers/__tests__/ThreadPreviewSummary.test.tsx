import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => `${k}#${o?.count ?? ''}`,
  }),
}))

const { summarize, provider } = vi.hoisted(() => ({
  summarize: vi.fn(async () => 'A written summary of the chat.'),
  provider: { current: 'openai' },
}))

vi.mock('@/lib/thread-title-summarizer', () => ({
  summarizeConversation: summarize,
  canSummarizeLocally: () => provider.current === 'llamacpp' || provider.current === 'mlx',
}))

const msg = (role: string, text: string) => ({
  id: text,
  role,
  content: [{ type: 'text', text: { value: text } }],
})
vi.mock('@/hooks/useActiveMessages', () => ({ getActiveMessages: () => [] }))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({
    messages: () => ({
      fetchMessages: async () => [msg('user', 'hello there'), msg('assistant', 'hi')],
    }),
  }),
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: { getState: () => ({ threads: {} }) },
}))
vi.mock('@/lib/message-branching', () => ({ activePathOf: (m: unknown) => m }))

import { ThreadPreviewSummary } from '../ThreadPreviewSummary'

describe('ThreadPreviewSummary', () => {
  beforeEach(() => summarize.mockClear())

  it('never asks a remote provider, and still shows text from disk', async () => {
    provider.current = 'openai'
    render(<ThreadPreviewSummary open threadId="remote-1" updated={1} />)
    await waitFor(() => expect(screen.getByTestId('row-preview-summary').textContent).toBe('hello there'))
    expect(screen.getByTestId('row-preview-count').textContent).toBe('common:previewMessageCount#2')
    expect(summarize).not.toHaveBeenCalled()
  })

  it('asks a local engine and shows its summary', async () => {
    provider.current = 'llamacpp'
    render(<ThreadPreviewSummary open threadId="local-1" updated={1} />)
    await waitFor(() =>
      expect(screen.getByTestId('row-preview-summary').textContent).toBe('A written summary of the chat.')
    )
    expect(summarize).toHaveBeenCalledTimes(1)
  })
})
