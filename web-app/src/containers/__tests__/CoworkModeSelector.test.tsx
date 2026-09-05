import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { CoworkModeSelector } from '../CoworkModeSelector'

/** Radix opens on pointer events jsdom does not fully model. */
const user = userEvent.setup({ pointerEventsCheck: 0 })

const open = async (mode: 'review' | 'ask' | 'auto' = 'review') => {
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
      'common:coworkMode.review.label'
    )
  })

  it('offers all three modes, each with what it does', async () => {
    await open()
    const options = await screen.findAllByRole('menuitemradio')

    expect(options.map((o) => o.textContent)).toEqual([
      'common:coworkMode.review.labelcommon:coworkMode.review.description',
      'common:coworkMode.ask.labelcommon:coworkMode.ask.description',
      'common:coworkMode.auto.labelcommon:coworkMode.auto.description',
    ])
  })

  it('marks the current mode as the one selected', async () => {
    await open('ask')
    const options = await screen.findAllByRole('menuitemradio')

    expect(options.map((o) => o.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
    ])
  })

  it('reports the mode the user picked', async () => {
    const onChange = await open('review')
    const options = await screen.findAllByRole('menuitemradio')

    await user.click(options[2])

    expect(onChange).toHaveBeenCalledWith('auto')
  })

  it('says which mode is active for a screen reader', () => {
    const { container } = render(
      <CoworkModeSelector mode="auto" onChange={vi.fn()} />
    )
    const live = container.querySelector('[aria-live="polite"]')

    expect(live).toHaveTextContent('common:coworkMode.auto.label')
  })
})
