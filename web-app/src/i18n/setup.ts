import { localStorageKey } from '@/constants/localStorage'

// Types for our i18n implementation
export interface TranslationResources {
  [language: string]: {
    [namespace: string]: {
      [key: string]: string
    }
  }
}

export interface I18nInstance {
  language: string
  fallbackLng: string
  resources: TranslationResources
  namespaces: string[]
  defaultNS: string
  /** Resolves once the language's strings are loaded and it is in use. */
  changeLanguage: (lng: string) => Promise<void>
  /** Resolves once the stored language's strings are loaded. */
  ready: Promise<void>
  t: (key: string, options?: Record<string, unknown>) => string
}

// Global i18n instance
let i18nInstance: I18nInstance

// English is the fallback language and is always bundled with the app. Every
// other language is loaded on demand, when it is the stored language or the
// person picks it: all 19 languages eager is ~650 JSON modules, which the dev
// server serves one request each before the first screen, and which a built app
// parses on every start for nothing.
const englishFiles = import.meta.glob('../locales/en/*.json', { eager: true })
const lazyLocaleFiles = import.meta.glob('../locales/*/*.json')

const resources: TranslationResources = {}
const namespaces: string[] = []

const LOCALE_PATH = /\.\.\/locales\/([^/]+)\/([^/]+)\.json/

const addLocale = (path: string, module: unknown) => {
  const match = path.match(LOCALE_PATH)
  if (!match) return
  // Example path: '../locales/en/common.json' -> language: 'en', namespace: 'common'
  const [, language, namespace] = match
  if (!resources[language]) resources[language] = {}
  if (!namespaces.includes(namespace)) namespaces.push(namespace)
  resources[language][namespace] =
    (module as { default: { [key: string]: string } }).default ||
    (module as { [key: string]: string })
}

Object.entries(englishFiles).forEach(([path, module]) => addLocale(path, module))

/** How one locale file is fetched; a seam so a test can make it fail. */
export const languageLoader = {
  load: (path: string): Promise<unknown> => lazyLocaleFiles[path](),
}

const loading = new Map<string, Promise<void>>()

/** Load every namespace of a language (a no-op when it is already loaded). */
export const ensureLanguage = (lng: string): Promise<void> => {
  const prefix = `../locales/${lng}/`
  const paths = Object.keys(lazyLocaleFiles).filter((p) => p.startsWith(prefix))
  if (paths.length === 0 || resources[lng]) return Promise.resolve()
  let pending = loading.get(lng)
  if (!pending) {
    pending = Promise.all(
      paths.map((p) => languageLoader.load(p).then((m) => addLocale(p, m)))
    ).then(() => undefined)
    loading.set(lng, pending)
    // A failed download must not stay cached, or every later attempt at this
    // language would fail the same way until a reload.
    pending.catch(() => {
      if (loading.get(lng) === pending) loading.delete(lng)
    })
  }
  return pending
}

// Get stored language preference
const getStoredLanguage = (): string => {
  try {
    const stored = localStorage.getItem(localStorageKey.settingGeneral)
    const parsed = stored ? JSON.parse(stored) : {}
    return parsed?.state?.currentLanguage || 'en'
  } catch {
    return 'en'
  }
}

// Translation function
const translate = (key: string, options: Record<string, unknown> = {}): string => {
  const { language, fallbackLng, resources: res, defaultNS } = i18nInstance
  
  // Parse key to extract namespace and actual key
  let namespace = defaultNS
  let translationKey = key
  
  if (key.includes(':')) {
    const parts = key.split(':')
    namespace = parts[0]
    translationKey = parts[1]
  }
  
  // Helper function to get nested value from object using dot notation
  const getNestedValue = (obj: Record<string, unknown>, path: string): string | undefined => {
    return path.split('.').reduce((current, key) => {
      return current && typeof current === 'object' && current !== null && key in current
        ? (current as Record<string, unknown>)[key]
        : undefined
    }, obj as unknown) as string | undefined
  }
  
  // Plural forms, as i18next names them: `key_one`, `key_other`, ... chosen by
  // the language's own rule for `count`. Without this every plural key
  // rendered as its raw key ("common:tasks.summaryNoTokens").
  const lookup = (lng: string): string | undefined => {
    const table = res[lng]?.[namespace]
    if (typeof options.count !== 'number') return getNestedValue(table, translationKey)
    let form = 'other'
    try {
      form = new Intl.PluralRules(lng).select(options.count)
    } catch {
      form = options.count === 1 ? 'one' : 'other'
    }
    // The exact plural form first. The bare key is the singular (en, ru, pl),
    // so it only serves "one" ahead of `_other`; any other form that has no
    // key of its own reads `_other` before the bare key (5 -> "5 событий").
    const exact = getNestedValue(table, `${translationKey}_${form}`)
    if (exact !== undefined) return exact
    const bare = getNestedValue(table, translationKey)
    const other = getNestedValue(table, `${translationKey}_other`)
    return form === 'one' ? bare ?? other : other ?? bare
  }

  // Try to get translation from current language
  let translation = lookup(language)

  // Fallback to fallback language if not found
  if (translation === undefined && language !== fallbackLng) {
    translation = lookup(fallbackLng)
  }
  
  // Callers may supply an inline `defaultValue`, as i18next allows. Honour it
  // before giving up, so a missing key degrades to real copy rather than
  // rendering the key itself at the user.
  if (translation === undefined) {
    if (typeof options.defaultValue === 'string') {
      translation = options.defaultValue
    } else {
      console.warn(`Translation missing for key: ${key}`)
      return key
    }
  }
  
  // Handle interpolation
  if (typeof translation === 'string' && options) {
    return translation.replace(/\{\{(\w+)\}\}/g, (match, variable) => {
      return options[variable] !== undefined ? String(options[variable]) : match
    })
  }
  
  return String(translation)
}

// Change language function
const changeLanguage = async (lng: string): Promise<void> => {
  if (!i18nInstance) return
  await ensureLanguage(lng)
  if (!resources[lng]) return
  i18nInstance.language = lng

  // Update localStorage
  try {
    const stored = localStorage.getItem(localStorageKey.settingGeneral)
    const parsed = stored ? JSON.parse(stored) : { state: {} }
    parsed.state.currentLanguage = lng
    localStorage.setItem(localStorageKey.settingGeneral, JSON.stringify(parsed))
  } catch (error) {
    console.error('Failed to save language preference:', error)
  }
}

// Initialize i18n instance
const initI18n = (): I18nInstance => {
  const currentLanguage = getStoredLanguage()
  
  i18nInstance = {
    language: currentLanguage,
    fallbackLng: 'en',
    resources,
    namespaces,
    defaultNS: 'common',
    changeLanguage,
    ready: ensureLanguage(currentLanguage),
    t: translate,
  }
  
  return i18nInstance
}

// Load translations function (for compatibility with reference implementation)
export const loadTranslations = (): void => {
  // English is bundled; the others load on demand (see ensureLanguage).
  console.log('Translations loaded:', Object.keys(resources))
}

// Initialize and export the i18n instance
const i18n = initI18n()

export default i18n
