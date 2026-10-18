import { describe, expect, it } from 'vitest'
import i18next from 'i18next'
import en from '../en/common.json'
import ru from '../ru/common.json'
import pl from '../pl/common.json'
import cs from '../cs/common.json'
import ja from '../ja/common.json'

async function tr(lng: string, res: unknown) {
  const i = i18next.createInstance()
  await i.init({
    lng,
    resources: { [lng]: { common: res as Record<string, unknown> } },
    interpolation: { escapeValue: false },
  })
  return (count: number) => i.t('common:mentions.totals', { count, tokens: '100' })
}

describe('mention totals plural forms', () => {
  it('en: one and other', async () => {
    const t = await tr('en', en)
    expect(t(1)).toBe('1 message · ~100 tokens included')
    expect(t(4)).toBe('4 messages · ~100 tokens included')
  })
  it('ru: one, few, many', async () => {
    const t = await tr('ru', ru)
    expect(t(1)).toContain('1 сообщение')
    expect(t(3)).toContain('3 сообщения')
    expect(t(5)).toContain('5 сообщений')
    expect(t(21)).toContain('21 сообщение')
  })
  it('pl: one, few, many', async () => {
    const t = await tr('pl', pl)
    expect(t(1)).toContain('1 wiadomość')
    expect(t(3)).toContain('3 wiadomości')
    expect(t(5)).toContain('5 wiadomości')
  })
  it('cs: one, few, other', async () => {
    const t = await tr('cs', cs)
    expect(t(1)).toContain('1 zpráva')
    expect(t(3)).toContain('3 zprávy')
    expect(t(5)).toContain('5 zpráv')
  })
  it('ja: one form', async () => {
    const t = await tr('ja', ja)
    expect(t(1)).toContain('1 件')
    expect(t(7)).toContain('7 件')
  })
})
