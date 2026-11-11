// The settings-search registry: one typed, static description of Flint's
// settings surface, driving both the Settings sidebar and the search field.
//
// Only stable metadata lives here — routes, i18n keys, anchors and keyword
// synonyms. Never current values: indexing what a setting is set to (an API
// key, a folder path, a token) would put private data one keystroke away.

import Fuse from 'fuse.js'
import { route } from '@/constants/routes'
import { getProviderTitle } from '@/lib/utils'
import { isPlatformTauri } from '@/lib/platform/utils'

import {
  SETTINGS_ITEMS,
  SETTINGS_PAGES,
} from './settingsSearch.data'

export * from './settingsSearch.data'

// ---------------------------------------------------------------------------
// Index building and search
// ---------------------------------------------------------------------------

export type SettingsIndexEntry = {
  kind: 'page' | 'setting' | 'provider' | 'provider-setting'
  id: string
  route: string
  /** Router params, set for provider routes. */
  params?: Record<string, string>
  /** Translated title, searched by Fuse. */
  title: string
  /** Translated section (page) label, for grouping results. */
  section: string
  description?: string
  keywords: string[]
  anchor?: string
  providerName?: string
}

/** The slice of a ProviderObject the index needs. Values are never read. */
export type ProviderForIndex = {
  provider: string
  active?: boolean
  settings?: { key: string; title?: string; description?: string }[]
}

type Translate = (key: string) => string

/** Markdown links in provider descriptions read badly in a result row. */
const stripMarkdown = (text: string): string =>
  text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')

/**
 * Pages whose controls drive this machine through desktop-only commands (the
 * local API server, phone pairing, the HTTPS proxy, OS schedules,
 * agent tools). The browser client of `flint serve` has no route for them, so
 * they are left out of its menu and search rather than shown as dead controls.
 */
const DESKTOP_ONLY_PAGES: ReadonlySet<string> = new Set([
  'local-api-server',
  'remote-access',
  'https-proxy',
  'schedules',
  'agent-tools',
])

/**
 * Settings on a desktop-only tab of a page the browser client still shows
 * (Integrations keeps its Jev tab there), so the page stays but these go.
 */
const DESKTOP_ONLY_ITEM_PREFIXES: readonly string[] = [
  'settings-integrations-claude-code-',
]

/** Whether a settings page works on this platform. */
export function isSettingsPageAvailable(id: string): boolean {
  return isPlatformTauri() || !DESKTOP_ONLY_PAGES.has(id)
}

/** The anchor a provider page puts on one setting's row. */
export function providerSettingAnchor(provider: string, key: string): string {
  return `provider-setting-${provider}-${key}`.replace(/[^A-Za-z0-9_-]/g, '-')
}

/**
 * Resolve the static registry plus the currently active providers into a flat,
 * translated index. Rebuilt whenever providers or the language change, so
 * providers added or removed at runtime appear and disappear with them.
 */
export function buildSettingsIndex(
  t: Translate,
  providers: ProviderForIndex[] = []
): SettingsIndexEntry[] {
  const entries: SettingsIndexEntry[] = []
  const hiddenRoutes = new Set<string>(
    SETTINGS_PAGES.filter((p) => !isSettingsPageAvailable(p.id)).map(
      (p) => p.route
    )
  )
  for (const page of SETTINGS_PAGES) {
    if (hiddenRoutes.has(page.route)) continue
    entries.push({
      kind: 'page',
      id: `page-${page.id}`,
      route: page.route,
      title: t(page.titleKey),
      section: t(page.titleKey),
      keywords: [...(page.keywords ?? [])],
    })
  }
  const desktop = isPlatformTauri()
  for (const setting of SETTINGS_ITEMS) {
    if (hiddenRoutes.has(setting.route)) continue
    if (
      !desktop &&
      DESKTOP_ONLY_ITEM_PREFIXES.some((p) => setting.id.startsWith(p))
    )
      continue
    entries.push({
      kind: 'setting',
      id: setting.id,
      route: setting.route,
      title: t(setting.titleKey),
      section: t(setting.section),
      description: setting.descriptionKey
        ? t(setting.descriptionKey)
        : undefined,
      keywords: [...(setting.keywords ?? [])],
      anchor: setting.anchor,
    })
  }
  for (const provider of providers) {
    if (provider.active === false) continue
    const title = getProviderTitle(provider.provider)
    entries.push({
      kind: 'provider',
      id: `provider-${provider.provider}`,
      route: route.settings.providers,
      params: { providerName: provider.provider },
      title,
      section: t('common:modelProviders'),
      keywords: ['provider', 'model', provider.provider],
      providerName: provider.provider,
    })
    for (const setting of provider.settings ?? []) {
      // Labels only — `controller_props.value` (keys, URLs the user set) is
      // deliberately never read into the index.
      if (!setting.title) continue
      entries.push({
        kind: 'provider-setting',
        id: `provider-${provider.provider}-${setting.key}`,
        route: route.settings.providers,
        params: { providerName: provider.provider },
        title: setting.title,
        section: title,
        description: setting.description
          ? stripMarkdown(setting.description)
          : undefined,
        keywords: [setting.key.replace(/-/g, ' ')],
        providerName: provider.provider,
        anchor: providerSettingAnchor(provider.provider, setting.key),
      })
    }
  }
  return entries
}

// Fuse builds its index in the constructor; cache one per index array so a
// keystroke does not re-index every entry.
const fuseCache = new WeakMap<SettingsIndexEntry[], Fuse<SettingsIndexEntry>>()

/** Typo-tolerant search over the index. Case-insensitive by Fuse default. */
export function searchSettings(
  index: SettingsIndexEntry[],
  query: string,
  limit = 20
): SettingsIndexEntry[] {
  const trimmed = query.trim()
  if (!trimmed) return []
  let fuse = fuseCache.get(index)
  if (!fuse) {
    fuse = new Fuse(index, {
      keys: [
        { name: 'title', weight: 0.6 },
        { name: 'keywords', weight: 0.25 },
        { name: 'section', weight: 0.1 },
        { name: 'description', weight: 0.05 },
      ],
      threshold: 0.35,
      ignoreLocation: true,
    })
    fuseCache.set(index, fuse)
  }
  // Search everything, rank, then cut: a title naming the query must not be
  // lost because twenty loose fuzzy hits came first.
  const found = fuse.search(trimmed).map((result) => result.item)
  const q = trimmed.toLowerCase()
  const startsWord = (text: string) =>
    text.startsWith(q) || text.split(/[\s/(),.-]+/).some((w) => w.startsWith(q))
  const tier = (e: SettingsIndexEntry): number => {
    const title = e.title.toLowerCase()
    const keywords = (e.keywords ?? []).map((k) => k.toLowerCase())
    if (title === q) return 0
    if (startsWord(title)) return 1
    if (title.includes(q)) return 2
    if (keywords.some((k) => k === q || startsWord(k))) return 3
    if (keywords.some((k) => k.includes(q))) return 4
    return 5
  }
  return found
    .map((e, i) => ({ e, i, t: tier(e) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .slice(0, limit)
    .map(({ e }) => e)
}
