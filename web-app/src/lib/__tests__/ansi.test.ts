import { describe, expect, it } from 'vitest'
import { hasAnsi, paletteColor, parseAnsi, stripAnsi } from '@/lib/ansi'

const ESC = '\x1b'

describe('ansi', () => {
  it('strips colour, cursor, OSC and charset escapes', () => {
    expect(stripAnsi(`${ESC}[1;31mred${ESC}[0m plain`)).toBe('red plain')
    expect(stripAnsi(`a${ESC}]0;title\x07b`)).toBe('ab')
    const ST = ESC + String.fromCharCode(92)
    expect(stripAnsi(`a${ESC}]8;;http://x${ST}link${ESC}]8;;${ST}b`)).toBe(
      'alinkb'
    )
    expect(stripAnsi(`x${ESC}(By${ESC}[2K`)).toBe('xy')
    expect(hasAnsi('plain')).toBe(false)
    expect(hasAnsi(`${ESC}[0m`)).toBe(true)
  })

  it('maps SGR codes to styled segments', () => {
    const segs = parseAnsi(
      `ok ${ESC}[32mpass${ESC}[0m ${ESC}[1;91mFAIL${ESC}[22;39m done`
    )
    expect(segs.map((s) => s.text)).toEqual([
      'ok ',
      'pass',
      ' ',
      'FAIL',
      ' done',
    ])
    expect(segs[1].style.fg).toBe(paletteColor(2))
    expect(segs[2].style).toEqual({})
    expect(segs[3].style).toMatchObject({ fg: paletteColor(9), bold: true })
    expect(segs[4].style.fg).toBeUndefined()
    expect(segs[4].style.bold).toBe(false)
  })

  it('handles 256-colour and truecolour, and drops non-SGR escapes', () => {
    const segs = parseAnsi(`${ESC}[38;5;196ma${ESC}[48;2;1;2;3mb${ESC}[Hc`)
    expect(segs[0].style.fg).toBe('rgb(255, 0, 0)')
    expect(segs[1].style.bg).toBe('rgb(1, 2, 3)')
    expect(segs.map((s) => s.text).join('')).toBe('abc')
  })

  it('uses theme variables for the 16 base colours', () => {
    expect(paletteColor(1)).toBe('var(--ansi-red)')
    expect(paletteColor(15)).toBe('var(--ansi-bright-white)')
  })
})
