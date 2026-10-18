import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { item?: string }) => (o?.item ? `${k}:${o.item}` : k),
  }),
}))

import { SidebarItemsPicker } from '../SidebarItemsPicker'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { SIDEBAR_SECTIONS, hideableSidebarIds } from '@/lib/sidebarItems'

const hidden = () => useInterfaceSettings.getState().hiddenNavItems

describe('SidebarItemsPicker', () => {
  beforeEach(() => {
    useInterfaceSettings.setState({ hiddenNavItems: [] })
  })

  it('has a switch for every hideable item and none for Settings', () => {
    render(<SidebarItemsPicker />)
    for (const id of hideableSidebarIds()) {
      expect(screen.getByTestId(`sidebar-item-switch-${id}`)).toBeChecked()
    }
    expect(screen.queryByTestId('sidebar-item-switch-settings')).toBeNull()
    expect(screen.queryByTestId('sidebar-item-switch-new-chat')).toBeNull()
  })

  it('hides an item with its switch and updates the live preview', () => {
    render(<SidebarItemsPicker />)
    expect(screen.getByTestId('sidebar-preview-studio')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('sidebar-item-switch-studio'))
    expect(hidden()).toEqual(['studio'])
    expect(screen.getByTestId('sidebar-item-switch-studio')).not.toBeChecked()
    expect(screen.queryByTestId('sidebar-preview-studio')).toBeNull()
    // Settings stays in the preview no matter what.
    expect(screen.getByTestId('sidebar-preview-settings')).toBeInTheDocument()
  })

  it('Show all puts everything back, and is off when nothing is hidden', () => {
    render(<SidebarItemsPicker />)
    expect(screen.getByTestId('sidebar-items-show-all')).toBeDisabled()
    fireEvent.click(screen.getByTestId('sidebar-item-switch-logs'))
    fireEvent.click(screen.getByTestId('sidebar-item-switch-archive'))
    expect(hidden()).toHaveLength(2)
    fireEvent.click(screen.getByTestId('sidebar-items-show-all'))
    expect(hidden()).toEqual([])
  })

  it('can leave the preview out', () => {
    render(<SidebarItemsPicker preview={false} />)
    expect(screen.queryByTestId('sidebar-items-preview')).toBeNull()
  })

  it('groups the switches by section under a heading each', () => {
    render(<SidebarItemsPicker />)
    const columns = screen.getByTestId('sidebar-items-columns')
    for (const section of SIDEBAR_SECTIONS) {
      expect(
        columns.querySelector(`#sidebar-items-${section}`)
      ).toHaveTextContent(`settings:sidebarItems.section.${section}`)
    }
    expect(columns.querySelectorAll('section')).toHaveLength(
      SIDEBAR_SECTIONS.length
    )
  })

  it('lays the switches out in container-query columns, preview beside them', () => {
    render(<SidebarItemsPicker />)
    expect(screen.getByTestId('sidebar-items-picker')).toHaveClass('@container')
    expect(screen.getByTestId('sidebar-items-columns').className).toContain(
      '@min-[30rem]:grid-cols-2'
    )
    const preview = screen.getByTestId('sidebar-items-preview')
    expect(preview.className).toContain('@min-[46rem]:sticky')
    expect(preview.className).toContain('@min-[46rem]:grid-cols-1')
  })
})
