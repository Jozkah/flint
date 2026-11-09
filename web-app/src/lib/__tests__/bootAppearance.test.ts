import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BOOT_APPEARANCE_KEY,
  buildBootAppearance,
  writeBootAppearance,
} from '../bootAppearance'
// The boot script is a file of its own so a strict script-src can serve it.
import html from '../../../public/boot-appearance.js?raw'

describe('bootAppearance', () => {
  beforeEach(() => localStorage.clear())

  it('writes no accent variables for the neutral default', () => {
    const snap = buildBootAppearance({
      theme: 'dark',
      isDark: true,
      accent: { preset: 'neutral' },
      fontSize: '16px',
      reduceMotion: false,
    })
    expect(snap).toMatchObject({ theme: 'dark', dark: true, fontSize: '16px' })
    expect(snap.vars).toEqual({ light: {}, dark: {} })
  })

  it('keeps accent variables for both themes so the OS can flip in between', () => {
    const snap = buildBootAppearance({
      theme: 'auto',
      isDark: false,
      accent: { preset: 'moss' },
      fontSize: '18px',
      reduceMotion: true,
    })
    expect(snap.vars.light['--primary']).toBe('#4E6E3A')
    expect(snap.vars.dark['--primary']).toBe('#97B77F')
    expect(snap.vars.dark['--grad']).toContain('linear-gradient')
    expect(snap.reduceMotion).toBe(true)
  })

  it('treats an unknown theme as auto', () => {
    const snap = buildBootAppearance({
      theme: 'sepia',
      isDark: false,
      accent: { preset: 'neutral' },
      fontSize: '16px',
      reduceMotion: false,
    })
    expect(snap.theme).toBe('auto')
  })

  it('stores the snapshot under the key the boot script reads', () => {
    const snap = buildBootAppearance({
      theme: 'light',
      isDark: false,
      accent: { custom: '#3B6EA5' },
      fontSize: '14px',
      reduceMotion: false,
    })
    writeBootAppearance(snap)
    expect(JSON.parse(localStorage.getItem(BOOT_APPEARANCE_KEY)!)).toEqual(snap)
    expect(html).toContain(`localStorage.getItem('${BOOT_APPEARANCE_KEY}')`)
  })
})

describe('boot-appearance.js theme', () => {
  const LINUX_WEBKIT =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)'
  const WINDOWS_EDGE =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0'
  const root = document.documentElement
  const win = window as unknown as Record<string, unknown>
  let ua: ReturnType<typeof vi.spyOn>

  function boot(opts: { ua: string; systemDark: boolean; saved?: object }) {
    ua.mockReturnValue(opts.ua)
    win.matchMedia = vi.fn(() => ({ matches: opts.systemDark }))
    if (opts.saved) localStorage.setItem(BOOT_APPEARANCE_KEY, JSON.stringify(opts.saved))
    new Function(html)()
    return root.classList.contains('dark')
  }

  beforeEach(() => {
    localStorage.clear()
    root.className = ''
    root.removeAttribute('style')
    win.__TAURI_INTERNALS__ = {}
    ua = vi.spyOn(window.navigator, 'userAgent', 'get')
  })
  afterEach(() => {
    ua.mockRestore()
    delete win.__TAURI_INTERNALS__
  })

  // WebKitGTK reports light under a dark desktop; the app's last resolved
  // theme is the truth, so the splash does not flash light first.
  it('uses the mirrored dark value for auto in the Linux app', () => {
    const saved = { theme: 'auto', dark: true, vars: { light: {}, dark: {} } }
    expect(boot({ ua: LINUX_WEBKIT, systemDark: false, saved })).toBe(true)
  })

  it('follows the mirrored light value for auto in the Linux app too', () => {
    const saved = { theme: 'auto', dark: false, vars: { light: {}, dark: {} } }
    expect(boot({ ua: LINUX_WEBKIT, systemDark: true, saved })).toBe(false)
  })

  it('falls back to the media query in the Linux app before any snapshot', () => {
    expect(boot({ ua: LINUX_WEBKIT, systemDark: true })).toBe(true)
  })

  it('keeps the media query elsewhere, where it tracks the OS live', () => {
    const saved = { theme: 'auto', dark: false, vars: { light: {}, dark: {} } }
    expect(boot({ ua: WINDOWS_EDGE, systemDark: true, saved })).toBe(true)
  })

  it('an explicit theme wins over both', () => {
    const saved = { theme: 'light', dark: true, vars: { light: {}, dark: {} } }
    expect(boot({ ua: LINUX_WEBKIT, systemDark: true, saved })).toBe(false)
  })
})
