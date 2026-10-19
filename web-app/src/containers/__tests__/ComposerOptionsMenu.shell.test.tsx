import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { ComposerOptionsMenu } from '../ComposerOptionsMenu'

const user = userEvent.setup({ pointerEventsCheck: 0 })

describe('chat shell switch inside the options button', () => {
  it('is a row in the panel, under web search, and toggles there', async () => {
    const onChange = vi.fn()
    render(
      <ComposerOptionsMenu
        label="common:composerOptions"
        active={[]}
        webSearch={{ enabled: true, onChange: vi.fn() }}
        shell={{ enabled: true, onChange }}
      >
        <span />
      </ComposerOptionsMenu>
    )
    // Still one button: the switch is not a toolbar button of its own.
    expect(screen.getAllByRole('button')).toHaveLength(1)
    await user.click(screen.getByTestId('composer-options'))
    const toggle = await screen.findByRole('switch', { name: 'common:chatShell' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await user.click(toggle)
    expect(onChange).toHaveBeenCalledWith(false)
  })

  it('is absent when the composer offers no shell', async () => {
    render(
      <ComposerOptionsMenu
        label="common:composerOptions"
        active={[]}
        webSearch={{ enabled: true, onChange: vi.fn() }}
      >
        <span />
      </ComposerOptionsMenu>
    )
    await user.click(screen.getByTestId('composer-options'))
    await screen.findByRole('switch', { name: 'common:web_search' })
    expect(screen.queryByRole('switch', { name: 'common:chatShell' })).toBeNull()
  })
})
