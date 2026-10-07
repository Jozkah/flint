import { beforeEach, describe, expect, it } from 'vitest'
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
