import { describe, it, expect } from 'vitest'
import i18next from 'i18next'
import engine from '../en/engine.json'
import providers from '../en/providers.json'
import common from '../en/common.json'
import commonRu from '../ru/common.json'
import commonPl from '../pl/common.json'
import commonJa from '../ja/common.json'

describe('provider model counts use proper plurals', () => {
  it('says "1 model", not "1 models"', async () => {
    const i18n = i18next.createInstance()
    await i18n.init({
      lng: 'en',
      resources: { en: { engine, providers } },
      interpolation: { escapeValue: false },
    })
    expect(i18n.t('engine:providers.modelsCount', { count: 1 })).toBe('1 model')
    expect(i18n.t('engine:providers.modelsCount', { count: 3 })).toBe('3 models')
    expect(
      i18n.t('providers:removeProvider.confirmDescription', { provider: 'P', count: 1 })
    ).toContain('its 1 model will')
  })
})

describe('Translate character count uses proper plurals', () => {
  const make = async (lng: string, res: object) => {
    const i18n = i18next.createInstance()
    await i18n.init({
      lng,
      resources: { [lng]: { common: res } },
      defaultNS: 'common',
      interpolation: { escapeValue: false },
    })
    return i18n
  }
  it('says "1 character", not "1 characters"', async () => {
    const i18n = await make('en', common)
    expect(i18n.t('translate.characters', { count: 1 })).toBe('1 character')
    expect(i18n.t('translate.characters', { count: 0 })).toBe('0 characters')
    expect(i18n.t('translate.characters', { count: 12 })).toBe('12 characters')
  })
  it('follows the Russian one/few/many rules', async () => {
    const i18n = await make('ru', commonRu)
    expect(i18n.t('translate.characters', { count: 1 })).toBe('1 символ')
    expect(i18n.t('translate.characters', { count: 3 })).toBe('3 символа')
    expect(i18n.t('translate.characters', { count: 5 })).toBe('5 символов')
    expect(i18n.t('translate.characters', { count: 21 })).toBe('21 символ')
  })
  it('follows the Polish rules', async () => {
    const i18n = await make('pl', commonPl)
    expect(i18n.t('translate.characters', { count: 1 })).toBe('1 znak')
    expect(i18n.t('translate.characters', { count: 2 })).toBe('2 znaki')
    expect(i18n.t('translate.characters', { count: 5 })).toBe('5 znaków')
  })
  it('keeps a single form for Japanese', async () => {
    const i18n = await make('ja', commonJa)
    expect(i18n.t('translate.characters', { count: 1 })).toBe('1 文字')
  })
})
