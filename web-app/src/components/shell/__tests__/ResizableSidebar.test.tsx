import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

import { ResizableSidebar } from '../AppSidebar'
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sanitizeSidebarWidth,
  useInterfaceSettings,
} from '@/hooks/useInterfaceSettings'

const panel = () => screen.getByTestId('app-sidebar-panel')
const handle = () => screen.getByTestId('app-sidebar-resize')
// jsdom has no PointerEvent; a MouseEvent under the pointer event's name
// carries clientX to the listener the same way.
const pointer = (el: Element, type: string, clientX: number) =>
  fireEvent(el, new MouseEvent(type, { bubbles: true, button: 0, clientX }))
const cssWidth = () => panel().style.getPropertyValue('--sidebar-w')

describe('ResizableSidebar', () => {
  beforeEach(() => {
    useInterfaceSettings.setState({ sidebarWidth: SIDEBAR_DEFAULT_WIDTH })
  })

  it('keeps a width within the range', () => {
    expect(sanitizeSidebarWidth(10)).toBe(SIDEBAR_MIN_WIDTH)
    expect(sanitizeSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH)
    expect(sanitizeSidebarWidth(300.4)).toBe(300)
    expect(sanitizeSidebarWidth('wide')).toBe(SIDEBAR_DEFAULT_WIDTH)
    expect(sanitizeSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH)
  })

  it('uses the saved width', () => {
    useInterfaceSettings.setState({ sidebarWidth: 320 })
    render(<ResizableSidebar open>x</ResizableSidebar>)
    expect(cssWidth()).toBe('320px')
    expect(handle().getAttribute('aria-valuenow')).toBe('320')
  })

  it('drags the width, stopping at the limits, and saves it when the drag ends', () => {
    render(<ResizableSidebar open>x</ResizableSidebar>)
    const el = handle()
    el.setPointerCapture = () => undefined
    // jsdom has no layout: the panel's left edge is at 0 and it is unzoomed.
    pointer(el, 'pointerdown', 250)
    pointer(el, 'pointermove', 330)
    expect(cssWidth()).toBe('330px')
    // Not written until the drag ends.
    expect(useInterfaceSettings.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH)
    pointer(el, 'pointermove', 2000)
    expect(cssWidth()).toBe(`${SIDEBAR_MAX_WIDTH}px`)
    pointer(el, 'pointermove', 5)
    expect(cssWidth()).toBe(`${SIDEBAR_MIN_WIDTH}px`)
    pointer(el, 'pointermove', 300)
    pointer(el, 'pointerup', 300)
    expect(useInterfaceSettings.getState().sidebarWidth).toBe(300)
    expect(document.body.style.cursor).toBe('')
  })

  it('resizes from the keyboard and resets on double-click', () => {
    render(<ResizableSidebar open>x</ResizableSidebar>)
    fireEvent.keyDown(handle(), { key: 'ArrowRight' })
    expect(useInterfaceSettings.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH + 16)
    fireEvent.keyDown(handle(), { key: 'End' })
    expect(useInterfaceSettings.getState().sidebarWidth).toBe(SIDEBAR_MAX_WIDTH)
    fireEvent.keyDown(handle(), { key: 'Home' })
    expect(useInterfaceSettings.getState().sidebarWidth).toBe(SIDEBAR_MIN_WIDTH)
    fireEvent.doubleClick(handle())
    expect(useInterfaceSettings.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH)
  })

  it('has no handle while closed', () => {
    render(<ResizableSidebar open={false}>x</ResizableSidebar>)
    expect(screen.queryByTestId('app-sidebar-resize')).toBeNull()
  })
})
