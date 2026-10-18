import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { ComposerOptionsMenu } from '../ComposerOptionsMenu'

const user = userEvent.setup({ pointerEventsCheck: 0 })

describe('web search inside the options button', () => {
  it('is one button: the switch lives in its panel and toggles there', async () => {
    const onChange = vi.fn()
    render(
      <ComposerOptionsMenu
        label="common:composerOptions"
        active={[]}
        webSearch={{ enabled: true, onChange }}
      >
        <span />
      </ComposerOptionsMenu>
    )
    // No globe button next to the options button.
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.queryByRole('switch')).toBeNull()

    await user.click(screen.getByTestId('composer-options'))
    const toggle = await screen.findByRole('switch', { name: 'common:web_search' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    toggle.focus()
    await user.keyboard(' ')
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(false))
  })

  it('shows no web search row when the composer offers none', async () => {
    render(
      <ComposerOptionsMenu label="o" active={[]}>
        <span />
      </ComposerOptionsMenu>
    )
    await user.click(screen.getByTestId('composer-options'))
    await screen.findByTestId('composer-options-panel')
    expect(screen.queryByTestId('composer-web-search-row')).toBeNull()
  })
})
