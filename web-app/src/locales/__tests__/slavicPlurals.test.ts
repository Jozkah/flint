import { describe, it, expect } from 'vitest'
import i18next from 'i18next'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')
const PLURAL = /_(zero|one|two|few|many|other)$/

function flat(v: unknown, prefix = '', out = new Map<string, string>()) {
  if (typeof v === 'string') out.set(prefix, v)
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) flat(x, prefix ? `${prefix}.${k}` : k, out)
  return out
}
const read = (loc: string, ns: string) =>
  JSON.parse(readFileSync(resolve(ROOT, loc, `${ns}.json`), 'utf8'))

describe.each(['ru', 'pl', 'cs'])('%s plural keys', (loc) => {
  const categories = new Intl.PluralRules(loc).resolvedOptions().pluralCategories
  it(`have every form ${loc} needs (${categories.join('/')})`, () => {
    const missing: string[] = []
    for (const file of readdirSync(resolve(ROOT, 'en')).filter((f) => f.endsWith('.json'))) {
      const ns = file.slice(0, -5)
      const en = flat(read('en', ns))
      const theirs = flat(read(loc, ns))
      const bases = new Set([...en.keys()].filter((k) => PLURAL.test(k)).map((k) => k.replace(PLURAL, '')))
      for (const base of bases) {
        for (const c of categories) {
          const bare = (c === 'one' || c === 'other') && theirs.has(base)
          if (!theirs.has(`${base}_${c}`) && !bare) missing.push(`${ns}:${base}_${c}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})

describe('reported plural wording', () => {
  const make = async (lng: string, ns: string) => {
    const i18n = i18next.createInstance()
    await i18n.init({
      lng,
      resources: { [lng]: { [ns]: read(lng, ns) } },
      defaultNS: ns,
      interpolation: { escapeValue: false },
    })
    return i18n
  }
  it('Czech model count: 1 model, 2-4 modely, 5+ modelů', async () => {
    const i18n = await make('cs', 'sweep')
    expect(i18n.t('hub.modelCount', { count: 1 })).toBe('1 model')
    expect(i18n.t('hub.modelCount', { count: 3 })).toBe('3 modely')
    expect(i18n.t('hub.modelCount', { count: 5 })).toBe('5 modelů')
    expect(i18n.t('hub.modelCount', { count: 0 })).toBe('0 modelů')
  })
  it('Russian hidden lines agree in number', async () => {
    const i18n = await make('ru', 'common')
    const key = Object.keys(read('ru', 'common')).find((k) =>
      typeof read('ru', 'common')[k]?.truncated_few === 'string'
    )
    expect(i18n.t(`${key}.truncated`, { count: 3 })).toBe('Ещё 3 строки не показаны')
    expect(i18n.t(`${key}.truncated`, { count: 5 })).toBe('Ещё 5 строк не показано')
  })
})
