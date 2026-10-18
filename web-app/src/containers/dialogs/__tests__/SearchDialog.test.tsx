/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  threads: {} as Record<string, any>,
  searchMessages: vi.fn(async (_q: string): Promise<any[]> => []),
}))

vi.mock('@/lib/messageSearch', () => ({
  searchMessages: (q: string) => h.searchMessages(q),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => h.navigate,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: (selector: any) =>
    selector({
      threads: h.threads,
      getFilteredThreads: (q: string) =>
        Object.values(h.threads).filter((thread: any) =>
          thread.title.toLowerCase().includes(q.toLowerCase())
        ),
    }),
}))

import { SearchDialog } from '../SearchDialog'

describe('SearchDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // jsdom does not implement it; the dialog scrolls the selection into view.
    Element.prototype.scrollIntoView = vi.fn()
    localStorage.clear()
    h.threads = {
      a: { id: 'a', title: 'Trip planning', metadata: { project: { name: 'Travel' } } },
      b: { id: 'b', title: 'Trip budget' },
    }
  })

  it('groups results with labels', () => {
    render(<SearchDialog open onOpenChange={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('common:searchThreads'), {
      target: { value: 'trip' },
    })
    expect(screen.getByText('common:searchGroup.inProjects')).toBeInTheDocument()
    expect(
      screen.getByText('common:searchGroup.conversations')
    ).toBeInTheDocument()
  })

  it('highlights the keyboard selection and opens it on Enter', () => {
    render(<SearchDialog open onOpenChange={vi.fn()} />)
    const input = screen.getByLabelText('common:searchThreads')
    fireEvent.change(input, { target: { value: 'trip' } })
    const first = document.querySelector('[data-index="0"]')!
    expect(first).toHaveAttribute('data-selected', 'true')
    expect(first.className).toContain('bg-accent')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const second = document.querySelector('[data-index="1"]')!
    expect(second).toHaveAttribute('data-selected', 'true')
    expect(first).toHaveAttribute('data-selected', 'false')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(h.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { threadId: 'b' } })
    )
  })

  it('offers a new chat when nothing is typed', () => {
    render(<SearchDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByText('common:newChat'))
    expect(h.navigate).toHaveBeenCalledWith({ to: '/' })
  })

  describe('message hits', () => {
    const hit = (threadId: string, snippet: string) => ({
      threadId,
      threadTitle: 'Old chat',
      messageId: `m-${threadId}`,
      role: 'user',
      snippet,
      updated: 1,
    })

    beforeEach(() => {
      vi.useFakeTimers()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    const typeQuery = (value: string) =>
      fireEvent.change(screen.getByLabelText('common:searchThreads'), {
        target: { value },
      })

    it('shows hits from inside messages after typing pauses, and opens the chat', async () => {
      h.searchMessages.mockResolvedValue([hit('z', 'the cache key ignores locale')])
      render(<SearchDialog open onOpenChange={vi.fn()} />)
      typeQuery('locale')
      // Not scanned on every keystroke.
      expect(h.searchMessages).not.toHaveBeenCalled()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      expect(h.searchMessages).toHaveBeenCalledTimes(1)
      expect(h.searchMessages).toHaveBeenCalledWith('locale')
      expect(screen.getByText('common:searchGroup.messages')).toBeInTheDocument()
      const mark = screen.getByText('locale')
      expect(mark.tagName).toBe('MARK')
      fireEvent.click(mark)
      expect(h.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ params: { threadId: 'z' } })
      )
    })

    it('debounces fast typing into one scan and drops a stale reply', async () => {
      let release: (v: any[]) => void = () => {}
      h.searchMessages.mockImplementationOnce(
        () => new Promise<any[]>((resolve) => (release = resolve))
      )
      render(<SearchDialog open onOpenChange={vi.fn()} />)
      typeQuery('lo')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })
      typeQuery('loc')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      expect(h.searchMessages).toHaveBeenCalledTimes(1)
      expect(h.searchMessages).toHaveBeenCalledWith('loc')

      typeQuery('locale')
      await act(async () => {
        release([hit('late', 'late reply')])
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.queryByText('late reply')).not.toBeInTheDocument()
    })
  })
})
