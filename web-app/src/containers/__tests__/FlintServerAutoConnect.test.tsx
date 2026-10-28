import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key} ${JSON.stringify(vars)}` : key,
  }),
}))

const platform = vi.hoisted(() => ({ android: true }))
vi.mock('@/lib/platform/utils', () => ({
  isPlatformAndroid: () => platform.android,
  isPlatformIOS: () => false,
}))

import { FlintServerAutoConnect } from '../FlintServerAutoConnect'

const assign = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  platform.android = true
  localStorage.clear()
  sessionStorage.clear()
  assign.mockReset()
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign },
  })
})

afterEach(() => {
  vi.useRealTimers()
})

// One second per act: each tick is a state update that schedules the next.
const tick = (seconds: number) => {
  for (let i = 0; i < seconds; i++) {
    act(() => {
      vi.advanceTimersByTime(1000)
    })
  }
}

const save = (autoConnect: boolean) =>
  localStorage.setItem(
    'flint.server',
    JSON.stringify({ url: 'https://flint.example.ts.net', autoConnect })
  )

describe('FlintServerAutoConnect', () => {
  it('opens the saved server after the countdown', () => {
    save(true)
    render(<FlintServerAutoConnect />)
    expect(screen.getByTestId('flint-server-autoconnect')).toBeInTheDocument()
    tick(3)
    expect(assign).not.toHaveBeenCalled()
    tick(2)
    expect(assign).toHaveBeenCalledWith('https://flint.example.ts.net')
  })

  it('lets the person stay on this device, and remembers it for the session', () => {
    save(true)
    const { unmount } = render(<FlintServerAutoConnect />)
    fireEvent.click(screen.getByText('server:useDevice'))
    tick(10)
    expect(assign).not.toHaveBeenCalled()
    unmount()
    render(<FlintServerAutoConnect />)
    expect(screen.queryByTestId('flint-server-autoconnect')).toBeNull()
  })

  it('Escape stays on this device and the countdown never touches the live text', () => {
    save(true)
    render(<FlintServerAutoConnect />)
    const root = screen.getByTestId('flint-server-autoconnect')
    expect(root).toHaveAttribute('role', 'status')
    const announced = root.querySelector('.sr-only')?.textContent
    tick(2)
    expect(root.querySelector('.sr-only')?.textContent).toBe(announced)
    expect(screen.getByText('server:useDevice')).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    tick(10)
    expect(assign).not.toHaveBeenCalled()
    expect(screen.queryByTestId('flint-server-autoconnect')).toBeNull()
  })

  it('does nothing without the switch, on a desktop build, or without a server', () => {
    save(false)
    const off = render(<FlintServerAutoConnect />)
    expect(off.container).toBeEmptyDOMElement()
    off.unmount()

    save(true)
    platform.android = false
    const desktop = render(<FlintServerAutoConnect />)
    expect(desktop.container).toBeEmptyDOMElement()
    desktop.unmount()

    platform.android = true
    localStorage.clear()
    const none = render(<FlintServerAutoConnect />)
    expect(none.container).toBeEmptyDOMElement()
    tick(10)
    expect(assign).not.toHaveBeenCalled()
  })
})
