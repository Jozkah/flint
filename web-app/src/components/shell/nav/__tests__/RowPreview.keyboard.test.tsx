import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { RowPreview } from '../RowPreview'

vi.mock('@/hooks/usePreviewSummary', () => ({
  usePreviewSummary: () => ({ summary: undefined, loading: false }),
}))
vi.mock('@/hooks/useSessionPrList', () => ({
  useSessionPrList: () => ({ prs: [], loading: false, error: undefined }),
}))
vi.mock('@/components/shell/nav/PreviewCard', async (orig) => ({
  ...(await orig<object>()),
  PreviewPullRequests: () => <a href="https://example.test/pr/1">PR one</a>,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const open = () => {
  vi.useFakeTimers()
  render(
    <RowPreview
      title="Chat title"
      summary="first"
      suppressed={false}
      pullRequests={{ sessionId: 's', folder: '/x' }}
    >
      <button>row</button>
    </RowPreview>
  )
  const row = screen.getByText('row')
  vi.spyOn(row, 'matches').mockReturnValue(true)
  fireEvent.focus(row)
  act(() => void vi.advanceTimersByTime(600))
  return row
}

describe('RowPreview keyboard access', () => {
  it('moves focus to the PR link with ArrowRight, keeps the card open, and Escape returns to the row', () => {
    const row = open()
    expect(screen.getByText('PR one')).toBeTruthy()
    row.focus()
    fireEvent.keyDown(row, { key: 'ArrowRight' })
    const link = screen.getByText('PR one')
    expect(document.activeElement).toBe(link)
    // Row loses focus to the card; the card must not close.
    fireEvent.blur(row, { relatedTarget: link })
    act(() => void vi.advanceTimersByTime(800))
    expect(screen.queryByText('PR one')).toBeTruthy()
    fireEvent.keyDown(link, { key: 'Escape' })
    act(() => void vi.advanceTimersByTime(800))
    expect(screen.queryByText('PR one')).toBeNull()
    expect(document.activeElement).toBe(row)
    vi.useRealTimers()
  })
})
