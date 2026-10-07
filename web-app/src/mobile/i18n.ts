// The phone app's words. Same locale folders as the desktop app
// (src/locales/<language>/), but only the `mobile` namespace is bundled: the
// phone page must not carry every desktop string. Plain functions, no React
// context, so the service worker (no React, no DOM) uses the very same `t`.
//
// The language is fixed per page load, which is why module-level label tables
// may call `t` while they are built. Where it comes from, in order:
//   1. the language the app saved (the desktop's general-settings key, in this
//      origin's storage; the phone never shares storage with the desktop),
//   2. the phone's own language (`navigator.languages`),
//   3. English.
// Anything a translation lacks falls back to English, never to the key.

import { localStorageKey } from '@/constants/localStorage'
import en from '../locales/en/mobile.json'

type Tree = { [key: string]: string | Tree }

const bundles = import.meta.glob('../locales/*/mobile.json', { eager: true, import: 'default' }) as Record<string, Tree>

const resources: Record<string, Tree> = {}
for (const [path, tree] of Object.entries(bundles)) {
  const code = path.match(/locales\/([^/]+)\/mobile\.json$/)?.[1]
  if (code) resources[code] = tree
}
resources.en = en as Tree

export const FALLBACK_LANGUAGE = 'en'
/** Where the app mirrors its language for the service worker (see api/idb.ts). */
export const LANGUAGE_KEY = 'language'

/** Browser language tags whose locale folder is named differently. */
const ALIASES: Record<string, string> = {
  vi: 'vn',
  zh: 'zh-CN',
  'zh-hans': 'zh-CN',
  'zh-sg': 'zh-CN',
  'zh-hant': 'zh-TW',
  'zh-hk': 'zh-TW',
  'zh-mo': 'zh-TW',
}

/** The locale folder that serves `tag` ("de", "pt-br", "vi-VN"), or null. */
export function matchLanguage(tag: unknown, available: readonly string[] = Object.keys(resources)): string | null {
  if (typeof tag !== 'string' || !tag) return null
  const lower = tag.toLowerCase().replace(/_/g, '-')
  const exact = available.find((a) => a.toLowerCase() === lower)
  if (exact) return exact
  const alias = ALIASES[lower] ?? ALIASES[lower.split('-')[0]]
  if (alias && available.includes(alias)) return alias
  const base = lower.split('-')[0]
  return available.find((a) => a.toLowerCase() === base) ?? available.find((a) => a.toLowerCase().startsWith(`${base}-`)) ?? null
}

function savedLanguage(): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(localStorageKey.settingGeneral)
    return raw ? (JSON.parse(raw) as { state?: { currentLanguage?: unknown } })?.state?.currentLanguage : undefined
  } catch {
    return undefined
  }
}

/** The language to show now, from what the app saved, then the phone. */
export function resolveLanguage(): string {
  const saved = matchLanguage(savedLanguage())
  if (saved) return saved
  const nav = globalThis.navigator
  for (const tag of nav?.languages?.length ? nav.languages : nav?.language ? [nav.language] : []) {
    const found = matchLanguage(tag)
    if (found) return found
  }
  return FALLBACK_LANGUAGE
}

let language = resolveLanguage()
const listeners = new Set<(language: string) => void>()

export const getLanguage = () => language

/** Calls `fn` whenever the language changes (the app mirrors it for the service worker). */
export function onLanguageChange(fn: (language: string) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function change(next: string) {
  if (next === language) return
  language = next
  for (const fn of listeners) fn(next)
}

/** Switches language (a locale folder name). Unknown ones are ignored. */
export function setLanguage(next: string | null | undefined): void {
  const found = matchLanguage(next)
  if (found) change(found)
}

/** Remembers `next` where the app keeps its language, and switches to it. */
export function saveLanguage(next: string): void {
  const found = matchLanguage(next)
  if (!found) return
  change(found)
  try {
    const raw = globalThis.localStorage?.getItem(localStorageKey.settingGeneral)
    const parsed = raw ? JSON.parse(raw) : {}
    parsed.state = { ...(parsed.state ?? {}), currentLanguage: found }
    globalThis.localStorage?.setItem(localStorageKey.settingGeneral, JSON.stringify(parsed))
  } catch {
    // Storage is optional: the language still applies for this page.
  }
}

function lookup(tree: Tree | undefined, key: string): string | undefined {
  let node: string | Tree | undefined = tree
  for (const part of key.split('.')) {
    if (!node || typeof node === 'string') return undefined
    node = node[part]
  }
  return typeof node === 'string' ? node : undefined
}

function pluralForm(lng: string, count: number): string {
  try {
    return new Intl.PluralRules(lng).select(count)
  } catch {
    return count === 1 ? 'one' : 'other'
  }
}

export type Vars = Record<string, string | number | undefined>

/** The text for `key` (dotted path in the mobile namespace), with `{{name}}`
 * values filled in. With a numeric `count`, the plural form `key_one`,
 * `key_other`, ... is chosen, as the desktop's translator does. */
export function t(key: string, vars?: Vars): string {
  const forms = (lng: string): string | undefined => {
    const tree = resources[lng]
    if (typeof vars?.count !== 'number') return lookup(tree, key)
    return lookup(tree, `${key}_${pluralForm(lng, vars.count)}`) ?? lookup(tree, key) ?? lookup(tree, `${key}_other`)
  }
  const text = forms(language) ?? (language === FALLBACK_LANGUAGE ? undefined : forms(FALLBACK_LANGUAGE)) ?? key
  if (!vars) return text
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => (vars[name] === undefined ? whole : String(vars[name])))
}
