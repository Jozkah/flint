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

const tree = (suppressed: boolean) => (
  <RowPreview
    title="Chat title"
    summary="first"
    suppressed={suppressed}
    pullRequests={{ sessionId: 's', folder: '/x' }}
  >
    <button>row</button>
  </RowPreview>
)
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms))
const hover = (el: HTMLElement) => {
  fireEvent.pointerEnter(el)
  fireEvent.mouseEnter(el)
  tick(600)
}
const leave = (el: HTMLElement) => {
  fireEvent.pointerLeave(el)
  fireEvent.mouseLeave(el)
  tick(400)
}

describe('RowPreview closes deterministically', () => {
  it('closes after the pointer leaves the row', () => {
    vi.useFakeTimers()
    render(tree(false))
    const row = screen.getByText('row')
    hover(row)
    expect(screen.queryByText('Chat title')).toBeTruthy()
    leave(row)
    expect(screen.queryByText('Chat title')).toBeNull()
    vi.useRealTimers()
  })

  it('still closes on later hovers after the card vanished with focus inside it', () => {
    vi.useFakeTimers()
    const { rerender } = render(tree(false))
    const row = screen.getByText('row')
    hover(row)
    // A mouse click inside the card focuses its link...
    const link = screen.getByText('PR one')
    link.focus()
    expect(document.activeElement).toBe(link)
    // ...then the card unmounts (menu opened / row suppressed) with no blur.
    rerender(tree(true))
    expect(screen.queryByText('Chat title')).toBeNull()
    rerender(tree(false))
    hover(row)
    expect(screen.queryByText('Chat title')).toBeTruthy()
    leave(row)
    expect(screen.queryByText('Chat title')).toBeNull()
    vi.useRealTimers()
  })

  it('closes when the pointer leaves the card, even after a mouse click focused its link', () => {
    vi.useFakeTimers()
    render(tree(false))
    const row = screen.getByText('row')
    hover(row)
    leave(row)
    hover(row)
    const link = screen.getByText('PR one')
    vi.spyOn(link, 'matches').mockReturnValue(false) // mouse focus
    link.focus()
    const card = link.closest('[data-slot="hover-card-content"]') as HTMLElement
    fireEvent.pointerEnter(card)
    fireEvent.pointerLeave(card)
    tick(400)
    expect(screen.queryByText('Chat title')).toBeNull()
    vi.useRealTimers()
  })

  it('keeps the card while keyboard focus (focus-visible) is inside, and Escape closes it', () => {
    vi.useFakeTimers()
    render(tree(false))
    const row = screen.getByText('row')
    hover(row)
    const link = screen.getByText('PR one')
    vi.spyOn(link, 'matches').mockReturnValue(true)
    link.focus()
    leave(row)
    expect(screen.queryByText('Chat title')).toBeTruthy()
    fireEvent.keyDown(link, { key: 'Escape' })
    tick(400)
    expect(screen.queryByText('Chat title')).toBeNull()
    vi.useRealTimers()
  })
})
