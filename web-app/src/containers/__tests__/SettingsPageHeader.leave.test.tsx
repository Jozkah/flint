import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: '/settings/general' }),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))
vi.mock('@/containers/SettingsMenu', () => ({
  default: () => null,
  SettingsSectionPicker: () => null,
}))

import { SettingsPageHeader } from '../SettingsPageHeader'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { noteLocation, setSettingsNavigator } from '@/lib/settingsReturn'

// janhq/jan#8581: a way out of Settings with the sidebar collapsed.
describe('SettingsPageHeader leave button', () => {
  beforeEach(() => {
    navigate.mockClear()
    setSettingsNavigator(navigate)
  })

  it('returns to the last page outside Settings', () => {
    noteLocation('/threads/abc?x=1')
    noteLocation('/settings/appearance')
    useLeftPanel.setState({ open: false })
    render(<SettingsPageHeader title="General" />)
    const button = screen.getByTestId('leave-settings')
    expect(button.className).not.toContain('md:hidden')
    fireEvent.click(button)
    expect(navigate).toHaveBeenCalledWith('/threads/abc?x=1')
  })

  it('only shows on narrow windows while the sidebar is open', () => {
    useLeftPanel.setState({ open: true })
    render(<SettingsPageHeader title="General" />)
    expect(screen.getAllByTestId('leave-settings').at(-1)!.className).toContain(
      'md:hidden'
    )
  })
})
