import { describe, expect, it } from 'vitest'
import css from '../index.css?raw'

/**
 * The previous design's token names were removed with the redesign. They
 * still compile silently in Tailwind (an unknown colour is simply dropped),
 * so a stray `bg-sunken` or `text-ink-2` would render transparent with no
 * error. This test keeps them from coming back.
 */
const sources = import.meta.glob(['../**/*.{ts,tsx,css}', '!../**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const LEGACY =
  /(?<![\w-])(?:[\w\-[\]&:=.*>~+()]+:)*!?(?:bg|text|border|ring|outline|fill|stroke|from|to|via|divide|decoration|shadow)-(?:sunken|ink-2|line-strong|brand(?:-[a-z]+)*|rail(?:-[a-z]+)*|sidebar(?:-[a-z]+)*|main-view(?:-fg)?|paper|code)(?![\w-])|var\(--(?:sunken|ink-2|line-strong|brand[\w-]*|rail[\w-]*|overlay-shadow|ctx-h|status-h|rail-w)\b|(?<![\w-])font-(?:studio|display)(?![\w-])|(?<![\w-])shadow-overlay(?![\w-])/

describe('design tokens', () => {
  it('uses none of the previous design token names', () => {
    // The glob really reaches the source tree.
    expect(Object.keys(sources).length).toBeGreaterThan(200)
    const offenders = Object.entries(sources)
      .filter(([, text]) => LEGACY.test(text))
      .map(([path, text]) => `${path}: ${text.match(LEGACY)?.[0]}`)
    expect(offenders).toEqual([])
  })

  it('defines no legacy aliases in the stylesheet', () => {
    expect(css).not.toMatch(/--color-(brand|sunken|ink-2|rail|sidebar|paper)\b/)
    expect(css).not.toMatch(/LEGACY ALIASES/)
  })
})
