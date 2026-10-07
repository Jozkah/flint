import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CopyButton } from '../CopyButton'

const copy = vi.fn()
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: (t: string) => copy(t) }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string) => (k === 'chat:actions.copied' ? 'Copied' : 'Copy'),
  }),
}))

describe('CopyButton', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    copy.mockResolvedValue(true)
  })
  afterEach(() => vi.useRealTimers())

  const setup = () =>
    render(
      <TooltipProvider>
        <CopyButton text="hello" />
      </TooltipProvider>
    )

  it('copies, shows Copied, then reverts after 2s', async () => {
    setup()
    const btn = screen.getByRole('button', { name: 'Copy' })
    expect(btn).not.toHaveAttribute('data-copied')
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(copy).toHaveBeenCalledWith('hello')
    expect(btn).toHaveAttribute('data-copied')
    expect(screen.getByText('Copied')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(2100)
    })
    expect(btn).not.toHaveAttribute('data-copied')
    expect(screen.queryByText('Copied')).not.toBeInTheDocument()
  })

  it('stays idle when the clipboard write fails', async () => {
    copy.mockResolvedValue(false)
    setup()
    const btn = screen.getByRole('button', { name: 'Copy' })
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(btn).not.toHaveAttribute('data-copied')
  })
})
