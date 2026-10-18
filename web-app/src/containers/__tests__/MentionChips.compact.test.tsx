import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MentionChips } from '../MentionChips'
import type { MentionPreview } from '@/lib/chatMentionPreview'

const previews: MentionPreview[] = [
  { token: 'chat:a', kind: 'chat', status: 'ok', title: 'Alpha', messages: 2, chars: 100, summary: false },
  { token: 'chat:b', kind: 'chat', status: 'ok', title: 'Beta', messages: 3, chars: 100, summary: false },
]

function mockWidth(narrow: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: narrow && query.includes('max-width: 520px'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
}

describe('MentionChips on a narrow composer', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('folds the chip row into one summary line that expands on tap', () => {
    mockWidth(true)
    render(<MentionChips prompt="@chat:a @chat:b" previews={previews} onChange={() => {}} canSummarize />)
    const compact = screen.getByTestId('mention-chips-compact')
    expect(compact.textContent).toContain('common:mentions.compact')
    expect(compact.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getAllByTestId('mention-chip')[0]!.closest('ul')!.hidden).toBe(true)
    fireEvent.click(compact)
    expect(screen.queryByTestId('mention-chips-compact')).toBeNull()
    expect(screen.getAllByTestId('mention-chip')[0]!.closest('ul')!.hidden).toBe(false)
    fireEvent.click(screen.getByTestId('mention-chips-collapse'))
    expect(screen.getByTestId('mention-chips-compact')).toBeTruthy()
  })

  it('shows the chips on a wide composer, capped at whole rows', () => {
    mockWidth(false)
    render(<MentionChips prompt="@chat:a @chat:b" previews={previews} onChange={() => {}} canSummarize />)
    expect(screen.queryByTestId('mention-chips-compact')).toBeNull()
    const ul = screen.getAllByTestId('mention-chip')[0]!.closest('ul')!
    expect(ul.hidden).toBe(false)
    expect(ul.className).toContain('max-h-[4rem]')
    expect(ul.className).toContain('snap-y')
  })
})
