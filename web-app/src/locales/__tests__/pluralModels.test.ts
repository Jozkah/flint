import { describe, it, expect } from 'vitest'
import i18next from 'i18next'
import engine from '../en/engine.json'
import providers from '../en/providers.json'

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
