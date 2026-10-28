import { describe, it, expect } from 'vitest'
import i18next from 'i18next'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (loc: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '..', loc, 'chat.json'), 'utf8'))

const make = async (lng: string) => {
  const i18n = i18next.createInstance()
  await i18n.init({
    lng,
    resources: { [lng]: { chat: read(lng) } },
    defaultNS: 'chat',
    interpolation: { escapeValue: false },
  })
  return i18n
}

describe('composer plural wording', () => {
  it('English: reference status reads 1 reference, 2 references', async () => {
    const i18n = await make('en')
    expect(i18n.t('composer.references', { count: 1 })).toBe('1 reference')
    expect(i18n.t('composer.references', { count: 2 })).toBe('2 references')
  })

  it('English: a rejected batch names one file or several', async () => {
    const i18n = await make('en')
    const o = { limit: '25MB', files: 'a.wav' }
    expect(i18n.t('composer.audioTooLarge', { ...o, count: 1 })).toBe(
      'Audio file too large (max 25MB): a.wav'
    )
    expect(i18n.t('composer.audioTooLarge', { ...o, count: 2 })).toBe(
      'Audio files too large (max 25MB): a.wav'
    )
    expect(i18n.t('composer.videoInvalid', { files: 'x', count: 2 })).toBe(
      'Invalid video types: x'
    )
  })

  it('Russian: 1, 2 and 5 references take their own forms', async () => {
    const i18n = await make('ru')
    expect(i18n.t('composer.references', { count: 1 })).toBe('1 ссылка')
    expect(i18n.t('composer.references', { count: 2 })).toBe('2 ссылки')
    expect(i18n.t('composer.references', { count: 5 })).toBe('5 ссылок')
  })

  it('Japanese has the single form only and still resolves', async () => {
    const i18n = await make('ja')
    expect(i18n.t('composer.references', { count: 1 })).toBe('1 件の参照')
  })
})
