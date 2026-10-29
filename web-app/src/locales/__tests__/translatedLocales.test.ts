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
  // "file" is Italian too.
  'rooms:apply.files_one': ['it'],
  // Cowork bundle labels: git terms these locales use as-is.
  'sweep:cowork.bundle.base': ['ca', 'es', 'fr', 'it', 'pt-BR'],
  'sweep:cowork.bundle.branch': ['de-DE', 'pt-BR'],
  'sweep:cowork.bundle.schema': ['it'],
  // uiLeftovers: loanwords and units shared with English.
  'uiLeftovers:hubTasks.embeddings': ['ca', 'de-DE', 'es', 'fr', 'pt-BR'],
  'uiLeftovers:tokenSpeed.tokens': ['ca', 'de-DE', 'es', 'pt-BR'],
  'uiLeftovers:tokenSpeed.count': ['ca', 'es', 'pt-BR'],
  'uiLeftovers:extensions.global': ['ca', 'de-DE', 'es', 'fr', 'id', 'pt-BR'],
  'uiLeftovers:memory.no': ['ca', 'es', 'it'],
  'uiLeftovers:hubTasks.chat': ['cs', 'de-DE', 'es', 'it', 'pt-BR'],
  'uiLeftovers:memory.importedExport': ['cs', 'fr'],
  'uiLeftovers:extensions.plugins': ['de-DE', 'es', 'fr', 'pt-BR'],
  'uiLeftovers:memory.version': ['de-DE', 'fr'],
  'uiLeftovers:hubTasks.vision': ['fr'],
  'uiLeftovers:memory.source': ['fr'],
  'uiLeftovers:memory.conversationId': ['fr'],
  'uiLeftovers:memory.snapshotId': ['id', 'pt-BR'],
  // "Cowork" is the product feature name, not translated anywhere.
  'settings:sidebarItems.section.cowork': ['*'],
  'settings:memoryPage.kindCowork': ['*'],
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
  // "Models" is spelled the same in Catalan.
  'rooms:controls.models': ['ca'],
  // "Page" is the French word too.
  'common:settingsSearch.pageCrumb': ['fr'],
  // "Chat", "{{count}} in {{name}}" and "Conversation" are the real words there.
  'settings:memoryPage.kindChat': ['cs', 'de-DE', 'es', 'fr', 'it', 'pt-BR', 'vn'],
  'settings:memoryPage.stored.projectIn': ['de-DE', 'it'],
  'settings:memoryPage.conversation': ['fr'],
  // Picker filters: words these locales really use as they are in English.
  'common:picker.sourceLocal': ['ca', 'es', 'fr', 'pt-BR'],
  'common:picker.sourceCloud': ['cs', 'de-DE', 'fr', 'id', 'it'],
  'common:picker.cap.embeddings': ['cs', 'de-DE', 'fr', 'id', 'it', 'vn'],
  'common:picker.filter': ['de-DE', 'id'],
  'common:picker.sortName': ['de-DE'],
  'common:picker.source': ['fr'],
  'common:picker.cap.vision': ['fr'],
  // "Chat", "Session" and "Conversations" are the everyday words in these locales.
  'common:mentions.kind.chat': ['cs', 'de-DE', 'es', 'it', 'pt-BR'],
  'common:mentions.kind.session': ['fr'],
  'common:mentions.heading': ['fr'],
  // "{{count}} message(s)" is spelled the same in French.
  'common:mentions.messagesCount_one': ['fr'],
  'common:mentions.messagesCount_other': ['fr'],
  // Leftover sweep (studio / integrations / uiLeftovers / sweep): words and units these locales really use as-is.
  'integrations:claudeCode.local': ['ca', 'es', 'fr', 'pt-BR'],
  'integrations:remoteRunner.model': ['ca', 'cs', 'id', 'pl', 'tr'],
  'studio:duration.min': ['ca', 'cs', 'es', 'fr', 'it', 'pl', 'pt-BR'],
  'studio:duration.minS': ['ca', 'cs', 'es', 'fr', 'it', 'pl', 'pt-BR'],
  'studio:duration.s': ['ca', 'cs', 'de-DE', 'es', 'fr', 'it', 'pl', 'pt-BR'],
  'studio:model.title': ['ca', 'cs', 'id', 'pl', 'tr'],
  'studio:prompt.remixShort': ['ca', 'cs', 'de-DE', 'es', 'fr', 'id', 'it', 'pt-BR', 'vn'],
  'studio:prompt.title': ['ca', 'cs', 'de-DE', 'es', 'fr', 'id', 'it', 'pl', 'pt-BR', 'vn'],
  'sweep:hub.format': ['ca', 'de-DE', 'fr', 'id', 'pl'],
  'sweep:hub.modelCount': ['ca', 'cs', 'pl', 'tr'],
  'sweep:hub.variant': ['ca'],
  'uiLeftovers:extensions.global': ['ca', 'de-DE', 'es', 'fr', 'id', 'pt-BR'],
  'uiLeftovers:hubTasks.embeddings': ['ca', 'de-DE', 'es', 'fr', 'pt-BR'],
  'uiLeftovers:memory.no': ['ca', 'es', 'it'],
  'uiLeftovers:tokenSpeed.count': ['ca', 'es', 'pt-BR'],
  'uiLeftovers:tokenSpeed.tokens': ['ca', 'de-DE', 'es', 'pt-BR'],
  'studio:page.title': ['cs', 'de-DE', 'fr', 'id', 'it', 'pl', 'vn'],
  'studio:page.video': ['cs', 'de-DE', 'id', 'it', 'tr', 'vn'],
  'studio:picker.engine': ['cs', 'de-DE'],
  'studio:settings.seed': ['cs', 'de-DE', 'fr', 'id', 'it', 'pl', 'pt-BR', 'tr', 'vn'],
  'studio:video.seed': ['cs', 'fr', 'id', 'it', 'pl', 'pt-BR', 'tr', 'vn'],
  'uiLeftovers:hubTasks.chat': ['cs', 'de-DE', 'es', 'it', 'pt-BR'],
  'uiLeftovers:memory.importedExport': ['cs', 'fr'],
  'integrations:claudeCode.remote': ['de-DE'],
  'integrations:mcpDialog.headerN': ['de-DE', 'id', 'vn'],
  'studio:gens.filter': ['de-DE', 'id'],
  'uiLeftovers:extensions.plugins': ['de-DE', 'es', 'fr', 'pt-BR'],
  'uiLeftovers:memory.version': ['de-DE', 'fr'],
  'studio:page.images': ['fr'],
  'sweep:hub.architecture': ['fr'],
  'sweep:hub.images': ['fr'],
  'uiLeftovers:hubTasks.vision': ['fr'],
  'uiLeftovers:memory.conversationId': ['fr'],
  'uiLeftovers:memory.source': ['fr'],
  'studio:settings.reset': ['id'],
  'uiLeftovers:memory.snapshotId': ['id', 'pt-BR'],
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
    for (const key of translatedKeys) expect(lookup(en, key), key).toBeDefined()
  })

  for (const locale of LOCALES) {
    it(`${locale}: translated-keys differ from English`, () => {
      const loc = loadLocale(locale)
      const copies: string[] = []
      for (const key of translatedKeys) {
        const value = lookup(loc, key)
        if (value === undefined) continue // presence is lint:locales' job
        if (value === lookup(en, key) && !allowed(key, locale)) copies.push(key)
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
        if (value !== lookup(en, key)) stale.push(`${locale} ${key}`)
      }
    }
    expect(stale).toEqual([])
  })
})

describe('every English key exists in every locale', () => {
  /** Languages with a single plural form: `_other` stands for the bare English key too. */
  const ONE_FORM = new Set(['id', 'ja', 'ko', 'vn', 'zh-CN', 'zh-TW'])

  for (const locale of LOCALES) {
    it(`${locale}: no key of en is missing`, () => {
      const loc = loadLocale(locale)
      const missing = Object.keys(en).filter((key) => {
        if (lookup(loc, key) !== undefined) return false
        // A plural family (`key`/`key_one` + `key_other`): one-form languages only need `_other`.
        const family = key.replace(/_one$/, '')
        const plural = (k: string) => `${k}_other` in en || `${k}_one` in en
        return !(ONE_FORM.has(locale) && plural(family) && (`${family}_other` in loc || family in loc))
      })
      expect(missing, `keys missing in ${locale}`).toEqual([])
    })
  }
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
