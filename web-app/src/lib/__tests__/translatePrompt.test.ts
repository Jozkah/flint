import { describe, it, expect } from 'vitest'
import {
  AUTO_LANGUAGE,
  TRANSLATE_LANGUAGES,
  filterLanguages,
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

  it('offers a comprehensive list', () => {
    expect(TRANSLATE_LANGUAGES.length).toBeGreaterThanOrEqual(60)
    for (const l of [
      'Catalan',
      'Hebrew',
      'Swahili',
      'Esperanto',
      'Simplified Chinese',
    ])
      expect(TRANSLATE_LANGUAGES).toContain(l)
  })

  it('puts any offered language in the prompt', () => {
    for (const l of TRANSLATE_LANGUAGES)
      expect(buildTranslatePrompt('x', AUTO_LANGUAGE, l)).toContain(`to ${l}.`)
  })
})

describe('filterLanguages', () => {
  it('matches English and native names, ignoring accents and case', () => {
    expect(filterLanguages('espa').map((l) => l.name)).toContain('Spanish')
    expect(filterLanguages('francais').map((l) => l.name)).toContain('French')
    expect(filterLanguages('日本').map((l) => l.name)).toEqual(['Japanese'])
  })

  it('ranks prefix matches first and finds nothing for junk', () => {
    expect(filterLanguages('ger')[0].name).toBe('German')
    expect(filterLanguages('zzzzqq')).toEqual([])
  })

  it('prefers word-start matches and keeps mid-word hits as a fallback', () => {
    const ca = filterLanguages('ca').map((l) => l.name)
    expect(ca).toContain('Catalan')
    expect(ca).not.toContain('French')
    expect(ca).not.toContain('Azerbaijani')
    // Nothing starts with "rman", so the substring hit is still offered.
    expect(filterLanguages('rman').map((l) => l.name)).toContain('German')
  })

  it('lists recent languages first when nothing is typed', () => {
    const out = filterLanguages('', ['Latin', 'Greek']).map((l) => l.name)
    expect(out.slice(0, 2)).toEqual(['Latin', 'Greek'])
    expect(out.length).toBe(TRANSLATE_LANGUAGES.length)
  })
})
