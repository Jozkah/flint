import { describe, it, expect } from 'vitest'
import {
  SETTINGS_PAGES,
  SETTINGS_ITEMS,
  buildSettingsIndex,
  searchSettings,
  WEB_SEARCH_PROVIDER_CONFIG_ANCHOR,
  type ProviderForIndex,
  type SettingsIndexEntry,
} from '@/lib/settingsSearch'
import { route } from '@/constants/routes'
import enCommon from '@/locales/en/common.json'
import enSettings from '@/locales/en/settings.json'

// A fake translator, so the tests control the translated text the index is
// built from and can tell "found the key" apart from "found the label".
const EN: Record<string, string> = {
  'common:general': 'General',
  'common:appearance': 'Appearance',
  'common:assistants': 'Assistants',
  'common:attachments': 'Attachments',
  'common:local_api_server': 'Local API Server',
  'common:https_proxy': 'HTTPS Proxy',
  'common:web_search': 'Web Search',
  'common:agent_tools': 'Agent Tools',
  'common:keyboardShortcuts': 'Keyboard Shortcuts',
  'common:hardware': 'Hardware',
  'common:privacy': 'Privacy',
  'common:mcp-servers': 'MCP Servers',
  'common:claude_code': 'Claude Code',
  'common:modelProviders': 'Model Providers',
  'common:language': 'Language',
  'common:dataFolder': 'Data Folder',
  'settings:interface.theme': 'Theme',
  'settings:interface.themeDesc': 'Choose a light or dark look.',
  'settings:interface.fontSize': 'Font Size',
  'settings:privacy.helpUsImprove': 'Help us improve',
  'settings:privacy.helpUsImproveDesc': 'Send anonymous usage data.',
  'settings:httpsProxy.proxyUrl': 'Proxy URL',
  'settings:httpsProxy.proxyUrlDesc': 'Route traffic through a proxy.',
  'settings:webSearch.apiKey': 'API Key',
}

const translator =
  (dictionary: Record<string, string> = EN) =>
  (key: string) =>
    dictionary[key] ?? key

const t = translator()

const ids = (entries: SettingsIndexEntry[]) => entries.map((e) => e.id)

const find = (query: string, providers: ProviderForIndex[] = []) =>
  searchSettings(buildSettingsIndex(t, providers), query)

describe('searchSettings', () => {
  it('finds a setting by its exact name', () => {
    expect(find('Theme')[0].id).toBe('settings-appearance-theme')
  })

  it('finds a setting by a keyword synonym rather than its label', () => {
    // "dark mode" and "telemetry" appear in no title; only the synonym lists
    // carry them, which is what makes the search usable in any language.
    expect(ids(find('dark mode'))).toContain('settings-appearance-theme')
    expect(ids(find('telemetry'))).toContain('settings-privacy-analytics')
  })

  it('tolerates typos in the query', () => {
    expect(ids(find('langauge'))).toContain('settings-general-language')
    expect(ids(find('telemtry'))).toContain('settings-privacy-analytics')
    expect(ids(find('proxi'))).toContain('settings-https-proxy-proxy-url')
    expect(ids(find('prxoy url'))).toContain('settings-https-proxy-proxy-url')
  })

  it('spends its typo budget in proportion to the query length', () => {
    // Fuse's error budget scales with the pattern (threshold 0.35), so a
    // five-letter query buys one typo, not two: "prxoy" transposes two
    // characters and falls outside it, while the same typo inside a longer
    // query still lands. Pinned so a threshold change is a deliberate one.
    expect(find('prxoy')).toEqual([])
    expect(ids(find('proxxy'))).toContain('settings-https-proxy-proxy-url')
  })

  it('matches case-insensitively', () => {
    expect(find('THEME')[0].id).toBe(find('theme')[0].id)
    expect(find('THEME')[0].id).toBe('settings-appearance-theme')
  })

  it('searches the translated label, not the i18n key', () => {
    // Same registry, a different language: the query only works if the index
    // was built from t(titleKey) rather than from the raw key.
    const es = translator({ ...EN, 'settings:interface.theme': 'Apariencia visual' })
    const index = buildSettingsIndex(es)

    const hit = searchSettings(index, 'Apariencia')[0]
    expect(hit.id).toBe('settings-appearance-theme')
    expect(hit.title).toBe('Apariencia visual')
    // The same query against the English index finds nothing, so it was the
    // translation — not the key, and not a keyword — that made it findable.
    expect(searchSettings(buildSettingsIndex(t), 'Apariencia')).toEqual([])
  })

  it('returns nothing for an empty or whitespace-only query', () => {
    const index = buildSettingsIndex(t)
    expect(searchSettings(index, '')).toEqual([])
    expect(searchSettings(index, '   ')).toEqual([])
    expect(searchSettings(index, '\n\t ')).toEqual([])
  })

  it('honours the result limit', () => {
    expect(searchSettings(buildSettingsIndex(t), 'e', 3).length).toBeLessThanOrEqual(3)
  })
})

describe('buildSettingsIndex', () => {
  it('emits a page-level entry for every settings page', () => {
    const pages = buildSettingsIndex(t).filter((e) => e.kind === 'page')

    expect(ids(pages)).toEqual(SETTINGS_PAGES.map((p) => `page-${p.id}`))
    for (const page of SETTINGS_PAGES) {
      const entry = pages.find((e) => e.id === `page-${page.id}`)!
      expect(entry.route).toBe(page.route)
      expect(entry.title).toBe(t(page.titleKey))
    }
  })

  it('indexes an active provider and its named settings', () => {
    const index = buildSettingsIndex(t, [
      {
        provider: 'openai',
        active: true,
        settings: [{ key: 'api-key', title: 'API Key' }],
      },
    ])

    const provider = index.find((e) => e.id === 'provider-openai')!
    expect(provider.kind).toBe('provider')
    expect(provider.route).toBe(route.settings.providers)
    expect(provider.params).toEqual({ providerName: 'openai' })

    const setting = index.find((e) => e.id === 'provider-openai-api-key')!
    expect(setting.kind).toBe('provider-setting')
    expect(setting.title).toBe('API Key')
    expect(setting.route).toBe(route.settings.providers)
    expect(setting.params).toEqual({ providerName: 'openai' })
  })

  it('finds a provider by name once it is indexed', () => {
    const results = find('openai', [
      {
        provider: 'openai',
        active: true,
        settings: [{ key: 'api-key', title: 'API Key' }],
      },
    ])
    expect(ids(results)).toContain('provider-openai')
  })

  it('drops a provider that was removed or deactivated', () => {
    const openai: ProviderForIndex = {
      provider: 'openai',
      active: true,
      settings: [{ key: 'api-key', title: 'API Key' }],
    }
    expect(ids(find('openai', [openai]))).toContain('provider-openai')

    // Removed from the list entirely.
    expect(ids(find('openai', []))).not.toContain('provider-openai')
    // Still listed, but switched off.
    const off = ids(find('openai', [{ ...openai, active: false }]))
    expect(off).not.toContain('provider-openai')
    expect(off).not.toContain('provider-openai-api-key')
  })

  it('skips a provider setting that has no label to show', () => {
    const index = buildSettingsIndex(t, [
      { provider: 'openai', active: true, settings: [{ key: 'api-key' }] },
    ])
    expect(ids(index)).not.toContain('provider-openai-api-key')
  })

  it('never puts secrets or current values in the index', () => {
    // controller_props carries what a setting is currently set to. Reading it
    // into the index would put an API key one keystroke away in the search UI.
    const index = buildSettingsIndex(t, [
      {
        provider: 'openai',
        active: true,
        settings: [
          {
            key: 'api-key',
            title: 'API Key',
            controller_props: { value: 'sk-test-SHOULD-NOT-APPEAR' },
          },
          {
            key: 'base-url',
            title: 'Base URL',
            controller_props: { value: 'https://internal.example/v1' },
          },
        ],
      },
    ] as unknown as ProviderForIndex[])

    expect(JSON.stringify(index)).not.toContain('sk-test-SHOULD-NOT-APPEAR')
    expect(JSON.stringify(index)).not.toContain('internal.example')
    for (const entry of index) {
      expect(Object.keys(entry)).not.toContain('value')
      expect(Object.keys(entry)).not.toContain('controller_props')
    }
  })
})

describe('SETTINGS_ITEMS', () => {
  it('anchors each setting to a stable id, never a translated string', () => {
    for (const item of SETTINGS_ITEMS) {
      expect(item.anchor).toMatch(/^settings-[a-z0-9-]+$/)
    }
  })

  it('has no duplicate ids', () => {
    const all = SETTINGS_ITEMS.map((i) => i.id)
    expect(new Set(all).size).toBe(all.length)
  })

  it('points the two web-search credential entries at one shared group', () => {
    // They are the branches of a single conditional — a provider takes an
    // instance URL or a key, never both — so at most one control is mounted.
    // Anchoring each to its own control left the other's result navigating to
    // a page where nothing scrolled or highlighted; both now address the
    // group around the conditional, which is always rendered.
    // web-search.test.tsx checks the page really renders it, for every shape.
    const credentials = SETTINGS_ITEMS.filter(
      (i) =>
        i.id === 'settings-web-search-api-key' ||
        i.id === 'settings-web-search-endpoint'
    )
    expect(credentials).toHaveLength(2)
    for (const item of credentials) {
      expect(item.anchor).toBe(WEB_SEARCH_PROVIDER_CONFIG_ANCHOR)
    }
  })

  it('gives every other setting an anchor of its own, equal to its id', () => {
    // Sharing an anchor is the documented exception, not licence to reuse
    // ids: everywhere else the anchor is still the entry's own stable id.
    for (const item of SETTINGS_ITEMS) {
      if (item.anchor === WEB_SEARCH_PROVIDER_CONFIG_ANCHOR) continue
      expect(item.anchor, item.id).toBe(item.id)
    }
  })
})

describe('registry i18n keys', () => {
  // An unresolvable key does not fail loudly: i18next echoes the key back, so
  // the result row would read "settings:autoUpdateCheck" instead of a label.
  // Only the real locale files can catch that.
  const bundles: Record<string, unknown> = {
    common: enCommon,
    settings: enSettings,
  }

  const resolve = (key: string): string | undefined => {
    const [namespace, path] = key.split(':')
    let node: unknown = bundles[namespace]
    for (const part of (path ?? '').split('.')) {
      if (typeof node !== 'object' || node === null) return undefined
      node = (node as Record<string, unknown>)[part]
    }
    return typeof node === 'string' ? node : undefined
  }

  it('resolves every page title against the English locale', () => {
    for (const page of SETTINGS_PAGES) {
      expect(resolve(page.titleKey), page.titleKey).toBeTypeOf('string')
    }
  })

  it('resolves every setting title and description', () => {
    for (const item of SETTINGS_ITEMS) {
      expect(resolve(item.titleKey), item.titleKey).toBeTypeOf('string')
      if (item.descriptionKey) {
        expect(resolve(item.descriptionKey), item.descriptionKey).toBeTypeOf(
          'string'
        )
      }
    }
  })
})
