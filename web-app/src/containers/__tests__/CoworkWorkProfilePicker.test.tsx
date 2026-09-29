import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) =>
      opts ? `${k} ${Object.values(opts).join(' ')}` : k,
  }),
}))

import { CoworkWorkProfilePicker } from '../CoworkWorkProfilePicker'
import { WORK_PROFILES } from '@/lib/workProfiles'

describe('CoworkWorkProfilePicker', () => {
  it('says which profile Auto picked, and lists every profile with what it is for', async () => {
    render(
      <CoworkWorkProfilePicker
        choice={{ id: 'debug', manual: false }}
        onChoose={vi.fn()}
        onAuto={vi.fn()}
      />
    )
    const trigger = screen.getByTestId('work-profile-picker')
    expect(trigger).toHaveTextContent('Debug')
    await userEvent.click(trigger)
    const items = screen.getAllByRole('menuitemradio')
    expect(items).toHaveLength(WORK_PROFILES.length + 1)
    expect(screen.getByTestId('work-profile-auto')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('work-profile-review')).toHaveTextContent(
      WORK_PROFILES.find((p) => p.id === 'review')!.description
    )
  })

  it('picks a profile by hand, and goes back to Auto', async () => {
    const onChoose = vi.fn()
    const onAuto = vi.fn()
    const { rerender } = render(
      <CoworkWorkProfilePicker choice={undefined} onChoose={onChoose} onAuto={onAuto} />
    )
    await userEvent.click(screen.getByTestId('work-profile-picker'))
    await userEvent.click(screen.getByTestId('work-profile-refactor'))
    expect(onChoose).toHaveBeenCalledWith('refactor')

    rerender(
      <CoworkWorkProfilePicker
        choice={{ id: 'refactor', manual: true }}
        onChoose={onChoose}
        onAuto={onAuto}
      />
    )
    expect(screen.getByTestId('work-profile-picker')).toHaveTextContent('Refactor')
    await userEvent.click(screen.getByTestId('work-profile-picker'))
    expect(screen.getByTestId('work-profile-refactor')).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByTestId('work-profile-auto'))
    expect(onAuto).toHaveBeenCalledTimes(1)
  })
})
