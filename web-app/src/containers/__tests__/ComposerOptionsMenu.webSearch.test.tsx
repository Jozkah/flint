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

  it('is a compact single-line row the whole of which toggles', async () => {
    const onChange = vi.fn()
    render(
      <ComposerOptionsMenu label="o" active={[]} webSearch={{ enabled: false, onChange }}>
        <span />
      </ComposerOptionsMenu>
    )
    await user.click(screen.getByTestId('composer-options'))
    const row = await screen.findByTestId('composer-web-search-row')
    expect(row.className).toContain('h-8')
    expect(row.className).not.toMatch(/bg-(muted|accent|card)\b/)
    expect(row.querySelector('.flex-col')).toBeNull()
    expect(row.querySelector('svg')!.getAttribute('class')).toContain('size-3.5')
    await user.click(row.querySelector('span')!)
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(true))
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
