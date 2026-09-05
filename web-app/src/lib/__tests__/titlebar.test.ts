import { describe, it, expect } from 'vitest'
import {
  detectMacOverlay,
  resolveSidebarTitlebar,
  resolveHeaderInset,
} from '@/lib/titlebar'

describe('resolveSidebarTitlebar', () => {
  it('reserves the corner and hides the wordmark under the macOS overlay', () => {
    const r = resolveSidebarTitlebar(true, 0)
    expect(r.reserveLeft).toBe(true)
    expect(r.showWordmarkLeft).toBe(false)
    // The native buttons already brand the corner: no second label on macOS.
    expect(r.showWordmarkRight).toBe(false)
  })

  it('shows the wordmark on the left with no left-anchored controls', () => {
    const r = resolveSidebarTitlebar(false, 0)
    expect(r.reserveLeft).toBe(false)
    expect(r.showWordmarkLeft).toBe(true)
    expect(r.showWordmarkRight).toBe(false)
  })

  it('moves the wordmark into the right cluster for left-anchored Linux buttons', () => {
    const r = resolveSidebarTitlebar(false, 3)
    expect(r.controlsOnLeft).toBe(true)
    expect(r.reserveLeft).toBe(true)
    expect(r.showWordmarkLeft).toBe(false)
    expect(r.showWordmarkRight).toBe(true)
  })

  it('macOS overlay wins over any reported left buttons', () => {
    const r = resolveSidebarTitlebar(true, 3)
    expect(r.controlsOnLeft).toBe(false)
    expect(r.showWordmarkLeft).toBe(false)
    expect(r.showWordmarkRight).toBe(false)
  })
})

describe('resolveHeaderInset', () => {
  it('indents past the macOS traffic lights only while the sidebar is collapsed', () => {
    expect(
      resolveHeaderInset({
        macOverlay: true,
        sidebarOpen: false,
        leftButtonCount: 0,
        rightButtonCount: 0,
      }).macLeftPad
    ).toBe(true)
    // Open, the sidebar itself covers the corner, so no extra header indent.
    expect(
      resolveHeaderInset({
        macOverlay: true,
        sidebarOpen: true,
        leftButtonCount: 0,
        rightButtonCount: 0,
      }).macLeftPad
    ).toBe(false)
  })

  it('reserves exact pixels for left-anchored Linux controls when collapsed', () => {
    const inset = resolveHeaderInset({
      macOverlay: false,
      sidebarOpen: false,
      leftButtonCount: 3,
      rightButtonCount: 0,
    })
    expect(inset.macLeftPad).toBe(false)
    expect(inset.leftPx).toBe(3 * 32 + 24)
  })

  it('never reserves left pixels on macOS (that is the traffic-light indent)', () => {
    const inset = resolveHeaderInset({
      macOverlay: true,
      sidebarOpen: false,
      leftButtonCount: 3,
      rightButtonCount: 0,
    })
    expect(inset.leftPx).toBeUndefined()
    expect(inset.macLeftPad).toBe(true)
  })

  it('reserves right pixels for right-anchored controls at every width', () => {
    const inset = resolveHeaderInset({
      macOverlay: false,
      sidebarOpen: true,
      leftButtonCount: 0,
      rightButtonCount: 3,
    })
    expect(inset.rightPx).toBe(3 * 32 + 24)
  })

  it('reserves nothing when there are no controls', () => {
    const inset = resolveHeaderInset({
      macOverlay: false,
      sidebarOpen: true,
      leftButtonCount: 0,
      rightButtonCount: 0,
    })
    expect(inset.leftPx).toBeUndefined()
    expect(inset.rightPx).toBeUndefined()
    expect(inset.macLeftPad).toBe(false)
  })
})

describe('detectMacOverlay runtime fallback', () => {
  // The whole point: a bundle built without TAURI_ENV_PLATFORM has the
  // build-time IS_MACOS === false (vitest defines it false too), so the runtime
  // check must still catch macOS — but only inside the Tauri shell.
  const w = globalThis as unknown as {
    __TAURI_INTERNALS__?: unknown
  }

  it('returns false in a plain browser tab even on a Mac UA', () => {
    delete w.__TAURI_INTERNALS__
    expect(
      detectMacOverlay({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' })
    ).toBe(false)
  })

  it('detects macOS at runtime inside the Tauri shell', () => {
    w.__TAURI_INTERNALS__ = {}
    try {
      expect(
        detectMacOverlay({
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          platform: 'MacIntel',
        })
      ).toBe(true)
    } finally {
      delete w.__TAURI_INTERNALS__
    }
  })

  it('excludes iOS user agents', () => {
    w.__TAURI_INTERNALS__ = {}
    try {
      expect(
        detectMacOverlay({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS)' })
      ).toBe(false)
    } finally {
      delete w.__TAURI_INTERNALS__
    }
  })
})
