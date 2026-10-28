import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiKeyInput } from '../ApiKeyInput'

vi.mock('@/i18n/react-i18next-compat', async () => await import('@/test/englishI18n'))

vi.mock('@/hooks/useLocalApiServer', () => ({
  useLocalApiServer: () => ({ apiKey: 'sk-test', setApiKey: vi.fn() }),
}))

vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(true),
}))

describe('ApiKeyInput', () => {
  it('names its icon buttons and reflects the visibility state', async () => {
    const user = userEvent.setup()
    render(<ApiKeyInput />)

    const toggle = screen.getByRole('button', { name: 'Show API key' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Copy API key' })).toBeInTheDocument()

    await user.click(toggle)
    const hide = screen.getByRole('button', { name: 'Hide API key' })
    expect(hide).toHaveAttribute('aria-pressed', 'true')
  })

  it('announces a copy in a polite live region', async () => {
    const user = userEvent.setup()
    render(<ApiKeyInput />)

    await user.click(screen.getByRole('button', { name: 'Copy API key' }))
    const status = await screen.findByText('Copied')
    expect(status).toHaveAttribute('aria-live', 'polite')
  })
})
