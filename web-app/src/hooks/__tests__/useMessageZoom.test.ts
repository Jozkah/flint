import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMessageZoom } from '../useMessageZoom'
import { useInterfaceSettings } from '../useInterfaceSettings'

vi.mock('@/constants/localStorage', () => ({
  localStorageKey: { settingInterface: 'setting-appearance' },
}))

vi.mock('../useTheme', () => ({
  useTheme: {
    getState: vi.fn(() => ({ isDark: false })),
    subscribe: vi.fn(),
  },
}))

vi.mock('zustand/middleware', () => ({
  persist: (fn: any) => fn,
  createJSONStorage: () => ({
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  }),
}))

const pressKey = (key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: true,
    cancelable: true,
    ...init,
  })
  act(() => {
    window.dispatchEvent(event)
  })
  return event
}

const zoom = () => useInterfaceSettings.getState().messageZoom

/** A wheel event fired over an element inside (or outside) the chat transcript. */
const wheelOver = (target: Element, init: WheelEventInit) => {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

const transcript = () => {
  const root = document.createElement('div')
  root.className = 'message-zoom'
  const message = document.createElement('p')
  root.appendChild(message)
  document.body.appendChild(root)
  return { root, message }
}

describe('useMessageZoom', () => {
  beforeEach(() => {
    useInterfaceSettings.getState().resetMessageZoom()
  })

  it('zooms in on the meta key with either "+" or "="', () => {
    renderHook(() => useMessageZoom())

    expect(pressKey('=').defaultPrevented).toBe(true)
    expect(zoom()).toBe(1.1)

    pressKey('+', { shiftKey: true })
    expect(zoom()).toBe(1.25)
  })

  it('zooms out on the meta key with "-"', () => {
    renderHook(() => useMessageZoom())

    expect(pressKey('-').defaultPrevented).toBe(true)
    expect(zoom()).toBe(0.9)
  })

  it('ignores the keys without the meta key', () => {
    renderHook(() => useMessageZoom())

    const event = pressKey('=', { ctrlKey: false })

    expect(event.defaultPrevented).toBe(false)
    expect(zoom()).toBe(1)
  })

  it('ignores unrelated keys', () => {
    renderHook(() => useMessageZoom())

    pressKey('a')

    expect(zoom()).toBe(1)
  })

  it('zooms on ctrl + wheel and prevents the page zoom', () => {
    renderHook(() => useMessageZoom())
    const { root, message } = transcript()

    const up = wheelOver(message, { deltaY: -120, ctrlKey: true })
    expect(up.defaultPrevented).toBe(true)
    expect(zoom()).toBe(1.1)

    wheelOver(message, { deltaY: 120, ctrlKey: true })
    expect(zoom()).toBe(1)
    root.remove()
  })

  it('leaves ctrl + wheel alone anywhere outside the chat transcript', () => {
    renderHook(() => useMessageZoom())
    const elsewhere = document.createElement('div')
    document.body.appendChild(elsewhere)

    const event = wheelOver(elsewhere, { deltaY: -120, ctrlKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(zoom()).toBe(1)

    const onWindow = new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, cancelable: true })
    act(() => {
      window.dispatchEvent(onWindow)
    })
    expect(onWindow.defaultPrevented).toBe(false)
    expect(zoom()).toBe(1)
    elsewhere.remove()
  })

  it('leaves plain scrolling alone', () => {
    renderHook(() => useMessageZoom())

    const event = new WheelEvent('wheel', { deltaY: -120, cancelable: true })
    act(() => {
      window.dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(false)
    expect(zoom()).toBe(1)
  })

  it('detaches its listeners on unmount', () => {
    const { unmount } = renderHook(() => useMessageZoom())
    unmount()

    pressKey('=')

    expect(zoom()).toBe(1)
  })
})
