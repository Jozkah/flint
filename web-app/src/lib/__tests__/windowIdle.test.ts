import { describe, it, expect, vi, afterEach } from 'vitest'
import { installWindowIdleMarker } from '@/lib/windowIdle'

afterEach(() => vi.restoreAllMocks())

const marked = () => document.documentElement.hasAttribute('data-window-idle')

describe('idle window marker', () => {
  it('marks on blur and when hidden, clears on focus', () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const stop = installWindowIdleMarker()
    expect(marked()).toBe(false)

    focus.mockReturnValue(false)
    window.dispatchEvent(new Event('blur'))
    expect(marked()).toBe(true)

    focus.mockReturnValue(true)
    window.dispatchEvent(new Event('focus'))
    expect(marked()).toBe(false)

    vis.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(marked()).toBe(true)

    stop()
    expect(marked()).toBe(false)
    // Listeners are gone after stop.
    window.dispatchEvent(new Event('blur'))
    expect(marked()).toBe(false)
  })
})
