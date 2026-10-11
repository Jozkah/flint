import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { TokenCounter } from '../TokenCounter'
import { useTokensCount } from '@/hooks/useTokensCount'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))
vi.mock('@/hooks/useTokensCount', () => ({ useTokensCount: vi.fn() }))

// The real tooltip is used here: the point is its open and close behaviour.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO

const calculate = vi.fn()

const card = () => screen.queryByTestId('token-usage-popover')

describe('TokenCounter context card', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useTokensCount).mockReturnValue({
      tokenCount: 500,
      maxTokens: 1000,
      calculateTokens: calculate,
    } as unknown as ReturnType<typeof useTokensCount>)
  })

  it('opens on click, closes on a second click and still recalculates', async () => {
    const user = userEvent.setup()
    render(<TokenCounter />)
    const ring = screen.getByTestId('token-counter')
    expect(card()).toBeNull()
    await user.click(ring)
    await waitFor(() => expect(card()).not.toBeNull())
    expect(ring).toHaveAttribute('aria-expanded', 'true')
    // The pointer is still over the ring: a pinned card does not close on it.
    await user.click(ring)
    await waitFor(() => expect(card()).toBeNull())
    expect(ring).toHaveAttribute('aria-expanded', 'false')
    // And it can be opened by click again, which hover-only could not.
    await user.click(ring)
    await waitFor(() => expect(card()).not.toBeNull())
    expect(calculate).toHaveBeenCalled()
  })

  it('previews on hover, and a click pins it past leaving', async () => {
    const user = userEvent.setup()
    render(<TokenCounter />)
    const ring = screen.getByTestId('token-counter')
    await user.hover(ring)
    await waitFor(() => expect(card()).not.toBeNull(), { timeout: 2000 })
    // Clicking while the preview shows pins it rather than closing it.
    await user.click(ring)
    await waitFor(() => expect(ring).toHaveAttribute('aria-expanded', 'true'))
    await user.unhover(ring)
    fireEvent.pointerMove(document.body)
    expect(card()).not.toBeNull()
  })

  it('closes on Escape and on a click outside', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <button type="button">elsewhere</button>
        <TokenCounter />
      </div>
    )
    const ring = screen.getByTestId('token-counter')
    await user.click(ring)
    await waitFor(() => expect(card()).not.toBeNull())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(card()).toBeNull())
    await user.click(ring)
    await waitFor(() => expect(card()).not.toBeNull())
    fireEvent.pointerDown(screen.getByText('elsewhere'))
    await waitFor(() => expect(card()).toBeNull())
  })

  it('toggles from the keyboard', async () => {
    const user = userEvent.setup()
    render(<TokenCounter />)
    screen.getByTestId('token-counter').focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(card()).not.toBeNull())
    await user.keyboard(' ')
    await waitFor(() => expect(card()).toBeNull())
  })
})
