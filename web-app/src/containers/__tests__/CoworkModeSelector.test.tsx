import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { CoworkModeSelector } from '../CoworkModeSelector'

/** Radix opens on pointer events jsdom does not fully model. */
const user = userEvent.setup({ pointerEventsCheck: 0 })

const open = async (mode: 'review' | 'ask' | 'auto' | 'bypass' = 'review') => {
  const onChange = vi.fn()
  render(<CoworkModeSelector mode={mode} onChange={onChange} />)
  await user.click(screen.getByRole('button'))
  return onChange
}

describe('CoworkModeSelector', () => {
  // The control it replaces said which mode was on only through a fill colour.
  it('names the current mode on the trigger', () => {
    render(<CoworkModeSelector mode="review" onChange={vi.fn()} />)
    expect(screen.getByRole('button')).toHaveTextContent(
      'common:coworkMode.review.short'
    )
  })

  it('offers bypass permissions alongside the other modes', async () => {
    await open()
    const options = await screen.findAllByRole('menuitemradio')

    expect(options.map((o) => o.textContent)).toEqual([
      'common:coworkMode.review.labelcommon:coworkMode.review.description',
      'common:coworkMode.ask.labelcommon:coworkMode.ask.description',
      'common:coworkMode.auto.labelcommon:coworkMode.auto.description',
      'common:coworkMode.bypass.labelcommon:coworkMode.bypass.description',
    ])
  })

  it('marks the current mode as the one selected', async () => {
    await open('ask')
    const options = await screen.findAllByRole('menuitemradio')

    expect(options.map((o) => o.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ])
  })

  it('reports the mode the user picked', async () => {
    const onChange = await open('review')
    const options = await screen.findAllByRole('menuitemradio')

    await user.click(options[2])

    expect(onChange).toHaveBeenCalledWith('auto')
  })

  it('selects bypass permissions from the menu', async () => {
    const onChange = await open('auto')
    const options = await screen.findAllByRole('menuitemradio')
    await user.click(options[3])
    expect(onChange).toHaveBeenCalledWith('bypass')
  })

  // Under the composer the mode sits beside the access button and looks
  // exactly like it: no outline, no chevron, same height and padding.
  it('quiet variant has no outline or chevron but stays a menu button', async () => {
    render(<CoworkModeSelector mode="ask" variant="quiet" onChange={vi.fn()} />)
    const trigger = screen.getByRole('button')
    expect(trigger.className).not.toContain('border-[0.8px]')
    expect(trigger.className).toContain('h-7')
    expect(trigger.className).toContain('px-2 ')
    expect(trigger.querySelectorAll('svg')).toHaveLength(1)
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAccessibleName('common:coworkMode.label')
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findAllByRole('menuitemradio')).toHaveLength(4)
  })

  it('quiet variant keeps the warning colour for auto and bypass', () => {
    const { rerender } = render(
      <CoworkModeSelector mode="auto" variant="quiet" onChange={vi.fn()} />
    )
    expect(screen.getByRole('button').className).toContain('text-warning')
    rerender(<CoworkModeSelector mode="ask" variant="quiet" onChange={vi.fn()} />)
    expect(screen.getByRole('button').className).not.toContain('text-warning')
  })

  it('pill variant keeps its outline and chevron', () => {
    render(<CoworkModeSelector mode="ask" variant="pill" onChange={vi.fn()} />)
    const trigger = screen.getByRole('button')
    expect(trigger.className).toContain('border-[0.8px]')
    expect(trigger.querySelectorAll('svg')).toHaveLength(2)
  })

  it('says which mode is active for a screen reader', () => {
    const { container } = render(
      <CoworkModeSelector mode="auto" onChange={vi.fn()} />
    )
    const live = container.querySelector('[aria-live="polite"]')

    expect(live).toHaveTextContent('common:coworkMode.auto.label')
  })
})
