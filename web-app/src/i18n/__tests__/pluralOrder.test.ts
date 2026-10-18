import { describe, it, expect, afterEach } from 'vitest'
import i18n from '../setup'

/**
 * Plural lookup order. In ru / pl the bare key is the singular, so a count
 * that is not "one" must reach `_other` before it falls back to the bare key
 * (5 events read "5 событие"). English keeps its bare singular for count 1.
 */
const original = i18n.language
afterEach(() => {
  i18n.language = original
  for (const l of ['ru', 'pl', 'cs', 'ja']) delete i18n.resources[l]
})

const use = (lng: string, table: Record<string, string>) => {
  i18n.resources[lng] = { common: table }
  i18n.language = lng
}

describe('plural lookup order', () => {
  it('ru: 5 and 0 skip the bare singular and use _other when _many is missing', () => {
    use('ru', { ev: '{{count}} событие', ev_other: '{{count}} событий' })
    expect(i18n.t('common:ev', { count: 5 })).toBe('5 событий')
    expect(i18n.t('common:ev', { count: 0 })).toBe('0 событий')
    expect(i18n.t('common:ev', { count: 1 })).toBe('1 событие')
    expect(i18n.t('common:ev', { count: 21 })).toBe('21 событие')
  })

  it('ru / pl: _few and _many win when present', () => {
    use('ru', {
      ev_one: '{{count}} событие',
      ev_few: '{{count}} события',
      ev_many: '{{count}} событий',
      ev_other: '{{count}} события',
    })
    expect(i18n.t('common:ev', { count: 3 })).toBe('3 события')
    expect(i18n.t('common:ev', { count: 5 })).toBe('5 событий')
    use('pl', {
      z: '{{count}} zdarzenie',
      z_few: '{{count}} zdarzenia',
      z_many: '{{count}} zdarzeń',
      z_other: '{{count}} zdarzenia',
    })
    expect(i18n.t('common:z', { count: 2 })).toBe('2 zdarzenia')
    expect(i18n.t('common:z', { count: 5 })).toBe('5 zdarzeń')
    expect(i18n.t('common:z', { count: 1 })).toBe('1 zdarzenie')
  })

  it('cs: few and other', () => {
    use('cs', { f_one: '1 s', f_few: '{{count}} f', f_other: '{{count}} o' })
    expect(i18n.t('common:f', { count: 3 })).toBe('3 f')
    expect(i18n.t('common:f', { count: 7 })).toBe('7 o')
  })

  it('ja: _other first, then the bare key', () => {
    use('ja', { n: '{{count}} 件', n_other: '{{count}} 件s' })
    expect(i18n.t('common:n', { count: 1 })).toBe('1 件s')
    use('ja', { m: '{{count}} 件' })
    expect(i18n.t('common:m', { count: 4 })).toBe('4 件')
  })

  it('en: bare singular still serves count 1; _other serves the rest', () => {
    i18n.language = 'en'
    expect(i18n.t('common:coworkDisplay.hiddenCount', { count: 1 })).toBe(
      '1 completed tool activity hidden'
    )
    expect(i18n.t('common:coworkDisplay.hiddenCount', { count: 4 })).toBe(
      '4 completed tool activities hidden'
    )
  })
})
