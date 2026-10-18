import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyInterfaceFontSize,
  interfaceZoomFactor,
  isWebKitGtk,
} from '@/lib/interfaceScale'

const LINUX_WEBKIT =
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const WINDOWS_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
const LINUX_CHROME =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36'

const root = () => document.documentElement.style

function stubEnv(ua: string, tauri: boolean) {
  vi.stubGlobal('IS_TAURI', tauri)
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  root().removeProperty('--font-size-base')
  root().removeProperty('--app-font-base')
})

describe('isWebKitGtk', () => {
  it('matches the Linux WebKitGTK webview only', () => {
    expect(isWebKitGtk(LINUX_WEBKIT)).toBe(true)
    expect(isWebKitGtk(WINDOWS_EDGE)).toBe(false)
    expect(isWebKitGtk(LINUX_CHROME)).toBe(false)
    expect(isWebKitGtk(ANDROID)).toBe(false)
  })
})

describe('interfaceZoomFactor', () => {
  it('maps the interface size onto the 16px design', () => {
    expect(interfaceZoomFactor('14px')).toBe(0.875)
    expect(interfaceZoomFactor('16px')).toBe(1)
    expect(interfaceZoomFactor('18px')).toBe(1.125)
    expect(interfaceZoomFactor('20px')).toBe(1.25)
  })

  it('falls back to 1 for a bad value', () => {
    expect(interfaceZoomFactor('')).toBe(1)
    expect(interfaceZoomFactor('abc')).toBe(1)
    expect(interfaceZoomFactor('0px')).toBe(1)
  })
})

describe('applyInterfaceFontSize', () => {
  it('zooms the Linux desktop webview and keeps rem at design size', () => {
    stubEnv(LINUX_WEBKIT, true)
    const setZoom = vi.fn().mockResolvedValue(undefined)
    applyInterfaceFontSize('20px', setZoom)
    expect(setZoom).toHaveBeenCalledWith(1.25)
    expect(root().getPropertyValue('--font-size-base')).toBe('16px')
    expect(root().getPropertyValue('--app-font-base')).toBe('16px')
  })

  it('keeps the CSS path on Windows', () => {
    stubEnv(WINDOWS_EDGE, true)
    const setZoom = vi.fn()
    applyInterfaceFontSize('20px', setZoom)
    expect(setZoom).not.toHaveBeenCalled()
    expect(root().getPropertyValue('--font-size-base')).toBe('20px')
  })

  it('keeps the rem fallback in a Linux browser (no Tauri)', () => {
    stubEnv(LINUX_WEBKIT, false)
    const setZoom = vi.fn()
    applyInterfaceFontSize('18px', setZoom)
    expect(setZoom).not.toHaveBeenCalled()
    expect(root().getPropertyValue('--font-size-base')).toBe('18px')
  })

  it('survives a zoom call that fails', async () => {
    stubEnv(LINUX_WEBKIT, true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    applyInterfaceFontSize('18px', () => Promise.reject(new Error('denied')))
    await Promise.resolve()
    await Promise.resolve()
    expect(warn).toHaveBeenCalled()
  })
})
