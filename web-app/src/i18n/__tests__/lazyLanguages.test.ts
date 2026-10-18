import { describe, it, expect, vi } from 'vitest'
import i18n, { ensureLanguage, languageLoader } from '../setup'

describe('language loading', () => {
  it('bundles English only; another language loads when asked for', async () => {
    expect(Object.keys(i18n.resources)).toEqual(['en'])
    await i18n.changeLanguage('fr')
    expect(i18n.language).toBe('fr')
    expect(Object.keys(i18n.resources['fr']).length).toBeGreaterThan(0)
    // Same set of namespaces as English.
    expect(Object.keys(i18n.resources['fr']).sort()).toEqual(
      Object.keys(i18n.resources['en']).sort()
    )
    await i18n.changeLanguage('en')
  })

  it('retries a language whose download failed instead of caching the failure', async () => {
    const spy = vi
      .spyOn(languageLoader, 'load')
      .mockRejectedValue(new Error('offline'))
    await expect(ensureLanguage('it')).rejects.toThrow('offline')
    await Promise.resolve()
    spy.mockRestore()
    await i18n.changeLanguage('it')
    expect(i18n.language).toBe('it')
    await i18n.changeLanguage('en')
  })

  it('ignores a language that does not exist', async () => {
    await ensureLanguage('xx')
    await i18n.changeLanguage('xx')
    expect(i18n.language).toBe('en')
  })
})
