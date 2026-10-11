import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { TokenCounter } from '../TokenCounter'
import { useTokensCount } from '@/hooks/useTokensCount'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))
vi.mock('@/hooks/useTokensCount', () => ({ useTokensCount: vi.fn() }))

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO

const card = () => screen.queryByTestId('token-usage-popover')

// The ring is two components: the one with a known window and the dashed one
// with none. A click toggles the card on both, as it does in the composer.
describe.each([
  ['a known window', { tokenCount: 500, maxTokens: 1000 }],
  ['no known window', { tokenCount: 500, maxTokens: undefined }],
  ['no window and nothing counted', { tokenCount: 0, maxTokens: 0 }],
])('context ring with %s', (_name, tokens) => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useTokensCount).mockReturnValue({
      ...tokens,
      calculateTokens: vi.fn(),
    } as unknown as ReturnType<typeof useTokensCount>)
  })

  it('opens on click and closes on the second click', async () => {
    const user = userEvent.setup()
    render(<TokenCounter />)
    const ring = screen.getByTestId('token-counter')
    expect(card()).toBeNull()
    await user.click(ring)
    await waitFor(() => expect(card()).not.toBeNull())
    expect(ring).toHaveAttribute('aria-expanded', 'true')
    await user.click(ring)
    await waitFor(() => expect(card()).toBeNull())
    expect(ring).toHaveAttribute('aria-expanded', 'false')
  })
})
