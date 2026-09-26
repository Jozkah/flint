import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createResizeFlag,
  RESIZE_SETTLE_MS,
  syncAppViewport,
} from '../useAppViewport'

const root = () => document.documentElement

function fakeWindow(width: number, height: number, vvHeight?: number) {
  return {
    document,
    innerWidth: width,
    innerHeight: height,
    visualViewport: vvHeight === undefined ? null : { height: vvHeight },
  } as unknown as Window
}

afterEach(() => {
  root().style.removeProperty('--app-vvh')
  root().classList.remove('kb-open', 'resizing')
  vi.useRealTimers()
})

describe('syncAppViewport', () => {
  it('leaves --app-vvh unset on a desktop window so 100dvh applies', () => {
    root().style.setProperty('--app-vvh', '700px')
    syncAppViewport(fakeWindow(1200, 800, 800))
    expect(root().style.getPropertyValue('--app-vvh')).toBe('')
    expect(root().classList.contains('kb-open')).toBe(false)
  })

  it('does not touch the root style on repeated desktop resizes', () => {
    const spy = vi.spyOn(root().style, 'setProperty')
    for (let w = 1024; w < 1100; w++) syncAppViewport(fakeWindow(w, 800, 800))
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('tracks the visual height and keyboard on a phone layout', () => {
    syncAppViewport(fakeWindow(390, 800, 500))
    expect(root().style.getPropertyValue('--app-vvh')).toBe('500px')
    expect(root().classList.contains('kb-open')).toBe(true)
    syncAppViewport(fakeWindow(390, 800, 800))
    expect(root().style.getPropertyValue('--app-vvh')).toBe('800px')
    expect(root().classList.contains('kb-open')).toBe(false)
  })
})

describe('createResizeFlag', () => {
  beforeEach(() => vi.useFakeTimers())

  it('adds resizing on the first event and clears it after the settle delay', () => {
    const flag = createResizeFlag(root())
    flag.poke()
    expect(root().classList.contains('resizing')).toBe(true)
    vi.advanceTimersByTime(RESIZE_SETTLE_MS - 1)
    expect(root().classList.contains('resizing')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(root().classList.contains('resizing')).toBe(false)
  })

  it('keeps resizing while events keep arriving (debounced)', () => {
    const flag = createResizeFlag(root())
    for (let i = 0; i < 20; i++) {
      flag.poke()
      vi.advanceTimersByTime(16)
    }
    expect(root().classList.contains('resizing')).toBe(true)
    vi.advanceTimersByTime(RESIZE_SETTLE_MS)
    expect(root().classList.contains('resizing')).toBe(false)
  })

  it('schedules one timer at a time', () => {
    const set = vi.fn((fn: () => void, ms: number) =>
      window.setTimeout(fn, ms)
    )
    const clear = vi.fn((id: number) => window.clearTimeout(id))
    const flag = createResizeFlag(root(), 50, { set, clear })
    flag.poke()
    flag.poke()
    flag.poke()
    expect(set).toHaveBeenCalledTimes(3)
    expect(clear).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('dispose clears the class and pending timer', () => {
    const flag = createResizeFlag(root())
    flag.poke()
    flag.dispose()
    expect(root().classList.contains('resizing')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
