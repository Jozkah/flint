import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import translatedKeys from './translated-keys.json'

const LOCALES_DIR = resolve(__dirname, '..')

type Flat = Record<string, string>

function flatten(obj: unknown, prefix = '', out: Flat = {}): Flat {
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flatten(v, path, out)
    else if (typeof v === 'string') out[path] = v
  }
  return out
}

/** Every namespaced key ("ns:dotted.path") of one locale. */
function loadLocale(locale: string): Flat {
  const out: Flat = {}
  const dir = join(LOCALES_DIR, locale)
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const ns = file.slice(0, -'.json'.length)
    const flat = flatten(JSON.parse(readFileSync(join(dir, file), 'utf8')))
    for (const [k, v] of Object.entries(flat)) out[`${ns}:${k}`] = v
  }
  return out
}

const LOCALES = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'en' && d.name !== '__tests__')
  .map((d) => d.name)
  .sort()

const en = loadLocale('en')

/** en uses the bare key as the singular form; other locales may use `_one`. */
const lookup = (loc: Flat, key: string) => loc[key] ?? loc[`${key}_one`]

/**
 * (locale, key) pairs that are legitimately identical to English: product
 * names, loanwords and technical terms the locale really uses as-is. Anything
 * else identical to English is an untranslated copy and fails the test.
 */
const SAME_AS_ENGLISH: Record<string, string[]> = {
  // "Cowork" is the product feature name, not translated anywhere.
  'settings:sidebarItems.section.cowork': ['*'],
  // The slash-menu source label; locale word is "prompt" (a loanword).
  'slash:source.prompt': ['cs', 'es', 'id', 'it', 'pl', 'pt-BR'],
  // "Pull requests" is the GitHub term, kept as-is in these locales.
  'common:rowPreview.pullRequests': ['ca', 'es', 'fr', 'pt-BR'],
  // "Error" is the real Catalan / Spanish word.
  'common:rowPreview.status.error': ['ca', 'es'],
  // "Name" and "Details" are the real German words.
  'common:promptLibrary.name': ['de-DE'],
  'common:translate.errorDetails': ['de-DE'],
  // Indonesian uses "Edit" and "prompt" as everyday loanwords.
  'common:promptLibrary.edit': ['id'],
  'common:promptLibrary.editTitle': ['id'],
}

const allowed = (key: string, locale: string) => {
  const l = SAME_AS_ENGLISH[key]
  return !!l && (l.includes('*') || l.includes(locale))
}

const PLACEHOLDER = /\{\{\s*[^}]+?\s*\}\}|<\/?\d+\s*\/?>|<\/?[a-z]+\s*\/?>/gi
const placeholders = (s: string) =>
  (s.match(PLACEHOLDER) ?? []).map((p) => p.replace(/\s+/g, '')).sort()

describe('shipped locales are translated', () => {
  it('keeps the key list in sync with en', () => {
    for (const key of translatedKeys) expect(en[key], key).toBeDefined()
  })

  for (const locale of LOCALES) {
    it(`${locale}: translated-keys differ from English`, () => {
      const loc = loadLocale(locale)
      const copies: string[] = []
      for (const key of translatedKeys) {
        const value = lookup(loc, key)
        if (value === undefined) continue // presence is lint:locales' job
        if (value === en[key] && !allowed(key, locale)) copies.push(key)
      }
      expect(copies, `English copies in ${locale}`).toEqual([])
    })
  }

  it('allowlist has no stale entries', () => {
    const stale: string[] = []
    for (const [key, locales] of Object.entries(SAME_AS_ENGLISH)) {
      expect(translatedKeys, key).toContain(key)
      for (const locale of locales.filter((l) => l !== '*')) {
        const value = lookup(loadLocale(locale), key)
        if (value !== en[key]) stale.push(`${locale} ${key}`)
      }
    }
    expect(stale).toEqual([])
  })
})

describe('locale placeholders match English', () => {
  for (const locale of LOCALES) {
    it(`${locale}: {{vars}} and <n></n> tags match`, () => {
      const loc = loadLocale(locale)
      const bad: string[] = []
      for (const [key, enValue] of Object.entries(en)) {
        const value = lookup(loc, key)
        if (value === undefined) continue
        if (placeholders(value).join('|') !== placeholders(enValue).join('|'))
          bad.push(key)
      }
      expect(bad, `placeholder mismatch in ${locale}`).toEqual([])
    })
  }
})

describe('plural families have every form the language needs', () => {
  /** Keys that have a `_one` or `_other` form, by base key. */
  const families = (loc: Flat) => {
    const bases = new Set<string>()
    for (const k of Object.keys(loc)) {
      const m = k.match(/^(.*)_(one|other)$/)
      if (m) bases.add(m[1])
    }
    return [...bases]
  }
  const missing = (locale: string, forms: string[]) => {
    const loc = loadLocale(locale)
    return families(loc).flatMap((b) =>
      forms.filter((f) => !(`${b}_${f}` in loc)).map((f) => `${b}_${f}`)
    )
  }

  for (const locale of ['ru', 'pl']) {
    it(`${locale}: every plural key has _few and _many`, () => {
      expect(missing(locale, ['few', 'many'])).toEqual([])
    })
  }
  it('cs: every plural key has _few', () => {
    expect(missing('cs', ['few'])).toEqual([])
  })
})
