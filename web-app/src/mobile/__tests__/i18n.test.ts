import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import en from '../../locales/en/mobile.json'
import { getLanguage, matchLanguage, saveLanguage, setLanguage, t } from '../i18n'

const MOBILE = resolve(__dirname, '..')

function sources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__') sources(full, acc)
    } else if (/\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

function has(key: string): boolean {
  const walk = (k: string) =>
    k.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), en)
  return typeof walk(key) === 'string' || typeof walk(`${key}_one`) === 'string' || typeof walk(`${key}_other`) === 'string'
}

describe('phone strings', () => {
  it('every key the phone code names exists in the English file', () => {
    // Keys composed at run time, which a scan cannot see.
    const found = new Set<string>([
      'sw.result.gone',
      'sw.result.unpaired',
      'sw.result.refused',
      'sw.result.failed',
      'tools.turnOff',
      'tools.turnOn',
      'home.templates.architecture.name',
      'home.templates.naming.name',
      'home.templates.crossCheck.name',
      'home.templates.debate.name',
    ])
    const call = /(?<![\w.])t\(\s*(?:[\w.?!&|() ]+\?\s*)?'([a-zA-Z0-9_.]+)'/g
    for (const file of sources(MOBILE)) {
      if (file.endsWith('i18n.ts')) continue
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(call)) found.add(m[1])
      for (const m of text.matchAll(/k="([a-z][\w.]*)"/g)) found.add(m[1])
    }
    expect([...found].filter((k) => !has(k)).sort()).toEqual([])
  })

  it('fills values in and picks the plural form', () => {
    expect(t('archive.deleted', { count: 3 })).toBe('Deleted 3')
    expect(t('archive.retention', { count: 1 })).toBe('Archived items are deleted for good after 1 day.')
    expect(t('archive.retention', { count: 30 })).toBe('Archived items are deleted for good after 30 days.')
  })

  it('shows the key rather than nothing for an unknown one', () => {
    expect(t('no.such.key')).toBe('no.such.key')
  })

  it('maps browser language tags to a locale folder', () => {
    const folders = ['en', 'de-DE', 'pt-BR', 'zh-CN', 'zh-TW', 'vn']
    expect(matchLanguage('de', folders)).toBe('de-DE')
    expect(matchLanguage('pt-br', folders)).toBe('pt-BR')
    expect(matchLanguage('vi-VN', folders)).toBe('vn')
    expect(matchLanguage('zh-Hant', folders)).toBe('zh-TW')
    expect(matchLanguage('zh', folders)).toBe('zh-CN')
    expect(matchLanguage('xx', folders)).toBeNull()
    expect(matchLanguage(undefined, folders)).toBeNull()
  })

  it('falls back to English for a key a language has not translated yet', () => {
    const before = getLanguage()
    try {
      setLanguage('de')
      // German has no mobile file yet: either it is served or English stands in.
      expect(t('archive.title')).toBeTruthy()
      expect(t('archive.title')).not.toBe('archive.title')
    } finally {
      setLanguage(before)
    }
  })

  it('remembers the language where the app keeps it', () => {
    const before = getLanguage()
    try {
      saveLanguage('en')
      const saved = JSON.parse(localStorage.getItem('setting-general') ?? '{}') as { state?: { currentLanguage?: string } }
      expect(saved.state?.currentLanguage).toBe('en')
    } finally {
      localStorage.removeItem('setting-general')
      setLanguage(before)
    }
  })
})
