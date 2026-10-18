import { describe, expect, it } from 'vitest'
import { mermaidConfigFor } from '../mermaidTheme'

describe('mermaidConfigFor', () => {
  it('uses the dark theme with light edges in dark mode', () => {
    const c = mermaidConfigFor(true)
    expect(c.theme).toBe('dark')
    expect(c.themeVariables?.lineColor).toBe('#d4d4d8')
  })
  it('keeps the default theme in light mode', () => {
    expect(mermaidConfigFor(false).theme).toBe('default')
  })
})
