/**
 * The room page paints with the theme's semantic tokens only, so light and
 * dark stay in step. A hex literal, an rgb()/hsl() literal in a class, or a
 * raw palette colour (emerald-600, red-400, ...) would drift from the theme.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(__dirname, '..')
const files = readdirSync(dir).filter((f) => f.endsWith('.tsx'))

// Participant colours are data (each participant's own hue), not UI paint.
const ALLOWED = new Set(['roomUi.ts'])

describe('room colours', () => {
  it.each(files.filter((f) => !ALLOWED.has(f)))('%s uses semantic colour tokens only', (file) => {
    const src = readFileSync(join(dir, file), 'utf8')
      // Comments may name colours or issue numbers.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
    expect(src.match(/\[[^\]]*\b(?:rgba?|hsla?)\(/g) ?? []).toEqual([])
    expect(
      src.match(/\b(?:text|bg|border|from|to|ring)-(?:red|green|emerald|blue|amber|yellow|orange|slate|gray|zinc)-\d{2,3}\b/g) ?? []
    ).toEqual([])
  })
})
