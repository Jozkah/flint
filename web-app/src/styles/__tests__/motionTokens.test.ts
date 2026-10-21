import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = (name: string) => readFileSync(resolve(__dirname, '..', '..', name), 'utf8')

describe('motion scale and polish utilities', () => {
  it('defines the seven durations of the scale', () => {
    const tokens = readFileSync(resolve(__dirname, '..', 'tokens.css'), 'utf8')
    for (const name of ['stagger', 'micro', 'quick', 'fast', 'medium', 'slow', 'very-slow']) {
      expect(tokens).toContain(`--duration-${name}:`)
    }
  })

  it('has a taller hit area for 28px controls and neutral photo outlines', () => {
    const index = css('index.css')
    expect(index).toMatch(/@utility hit-y[\s\S]*inset-block: -6px/)
    expect(index).toMatch(/@utility img-outline[\s\S]*oklch\(0 0 0 \/ 0\.1\)[\s\S]*oklch\(1 0 0 \/ 0\.1\)/)
  })

  it('does not leave transition: all in the styles', () => {
    for (const f of ['index.css', 'styles/motion-controls.css', 'styles/motion-chat.css', 'styles/motion-media.css', 'styles/motion-status.css', 'styles/motion-voice.css']) {
      expect(css(f), f).not.toMatch(/transition:\s*all\b/)
    }
  })
})
