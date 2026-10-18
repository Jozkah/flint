import { describe, expect, it } from 'vitest'
import { contrastRatio } from '@/lib/accent'
import css from './tokens.css?raw'

const light = (name: string) =>
  new RegExp(String.raw`:root\s*\{[\s\S]*?--${name}:\s*(#[0-9A-Fa-f]{6})`).exec(css)![1]

describe('light theme text tokens', () => {
  it('keeps subtle-foreground (section labels) readable on the page, cards and wells', () => {
    const subtle = light('subtle-foreground')
    for (const surface of ['background', 'card', 'muted'])
      expect(contrastRatio(subtle, light(surface))).toBeGreaterThanOrEqual(4.5)
  })
})
