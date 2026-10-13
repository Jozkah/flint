import { describe, it, expect } from 'vitest'
import {
  AUTO_LANGUAGE,
  TRANSLATE_LANGUAGES,
  buildTranslatePrompt,
} from '../translatePrompt'

describe('buildTranslatePrompt', () => {
  it('names both languages and ends with the untouched text', () => {
    const prompt = buildTranslatePrompt('Hola\nmundo', 'Spanish', 'English')
    expect(prompt).toContain('from Spanish to English')
    expect(prompt.endsWith('\n\nHola\nmundo')).toBe(true)
  })

  it('does not name a source language for auto-detect', () => {
    const prompt = buildTranslatePrompt('Hola', AUTO_LANGUAGE, 'French')
    expect(prompt).toContain('from the source language to French')
    expect(prompt).not.toContain(AUTO_LANGUAGE)
  })

  it('offers each language once', () => {
    expect(new Set(TRANSLATE_LANGUAGES).size).toBe(TRANSLATE_LANGUAGES.length)
  })
})
