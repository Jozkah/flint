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
import enAssistants from '@/locales/en/assistants.json'
import enMcpServers from '@/locales/en/mcp-servers.json'

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
  'common:mcp-servers': 'MCP Servers',
  'common:claude_code': 'Claude Code',
  'common:modelProviders': 'Model Providers',
  'common:language': 'Language',
  'common:dataFolder': 'Data Folder',
  'settings:interface.theme': 'Theme',
  'settings:interface.themeDesc': 'Choose a light or dark look.',
  'settings:interface.fontSize': 'Font Size',
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
    // "dark mode" appears in no title; only the synonym lists carry it, which
    // is what makes the search usable in any language.
    expect(ids(find('dark mode'))).toContain('settings-appearance-theme')
  })

  it('tolerates typos in the query', () => {
    expect(ids(find('langauge'))).toContain('settings-general-language')
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
    // The anchor is optional — a setting whose control has nowhere to scroll
    // to carries none — but when present it is always a stable id.
    for (const item of SETTINGS_ITEMS) {
      if (item.anchor === undefined) continue
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
      if (item.anchor === undefined) continue
      expect(item.anchor, item.id).toBe(item.id)
    }
  })
})

describe('registry i18n keys', () => {
  // An unresolvable key does not fail loudly: i18next echoes the key back, so
  // the result row would read "settings:autoUpdateCheck" instead of a label.
  // Only the real locale files can catch that.
  // Every namespace the registry names. A key in a namespace this map does
  // not carry would resolve to undefined and be reported as missing, which is
  // the point: the registry may not reference a bundle nothing loads.
  const bundles: Record<string, unknown> = {
    common: enCommon,
    settings: enSettings,
    assistants: enAssistants,
    'mcp-servers': enMcpServers,
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

/**
 * Structural coverage.
 *
 * These fail when the registry and the app drift apart, which is the failure
 * mode that matters: a page added without search coverage is unreachable from
 * the search field, and nothing else would notice.
 */
describe('structural coverage of the settings surface', () => {
  const itemsByPage = new Map<string, typeof SETTINGS_ITEMS>()
  for (const page of SETTINGS_PAGES) {
    itemsByPage.set(
      page.id,
      SETTINGS_ITEMS.filter((entry) => entry.id.startsWith(`settings-${page.id}-`))
    )
  }

  it('gives every page searchable entries, or says why it cannot', () => {
    for (const page of SETTINGS_PAGES) {
      const entries = itemsByPage.get(page.id) ?? []
      if (page.coverage === 'page-only') {
        expect(page.coverageNote, `${page.id} must say why`).toBeTruthy()
        continue
      }
      expect(entries.length, `${page.id} has no searchable settings`).toBeGreaterThan(0)
    }
  })

  it('gives every searchable setting a stable anchor, or says why not', () => {
    for (const entry of SETTINGS_ITEMS) {
      if (!entry.anchor) {
        // Only a setting that genuinely cannot be scrolled to — one inside a
        // popover or a conditional branch — may go without, and it has to say
        // so rather than being quietly unhighlightable.
        expect(
          entry.anchorNote,
          `${entry.id} has no anchor and no reason given`
        ).toBeTruthy()
        continue
      }
      // An anchor is an id, never a translated string: a label that changed
      // with the language would break every link into it.
      expect(entry.anchor, `${entry.id} anchor must be an id`).toMatch(
        /^[a-z0-9-]+$/
      )
    }
  })

  it('uses each id exactly once', () => {
    const ids = SETTINGS_ITEMS.map((entry) => entry.id)
    expect(new Set(ids).size, 'duplicate setting ids').toBe(ids.length)
    const pageIds = SETTINGS_PAGES.map((page) => page.id)
    expect(new Set(pageIds).size, 'duplicate page ids').toBe(pageIds.length)
  })

  it('shares an anchor only where sharing is deliberate', () => {
    // Two entries may point at one anchor when the controls they describe are
    // mutually exclusive, so only one is ever mounted; that anchor is an
    // exported constant precisely so both ends stay in step. Any *other*
    // repeat is two settings that would navigate to the same place.
    const shared = new Set([WEB_SEARCH_PROVIDER_CONFIG_ANCHOR])
    const seen = new Map<string, string[]>()
    for (const entry of SETTINGS_ITEMS) {
      if (!entry.anchor) continue
      seen.set(entry.anchor, [...(seen.get(entry.anchor) ?? []), entry.id])
    }
    for (const [anchor, owners] of seen) {
      if (owners.length === 1) continue
      expect(
        shared.has(anchor),
        `${anchor} is shared by ${owners.join(', ')} but is not a declared shared anchor`
      ).toBe(true)
    }
  })

  it('points every setting at a page that exists', () => {
    const routes = new Set(SETTINGS_PAGES.map((page) => page.route))
    for (const entry of SETTINGS_ITEMS) {
      expect(routes.has(entry.route), `${entry.id} has an unknown route`).toBe(
        true
      )
    }
  })

  it('names a page in every setting id, so coverage can be counted', () => {
    // `settings-<page>-<name>`: the prefix is how a setting is attributed to
    // its page, and a stray id would silently count for nothing.
    const pageIds = SETTINGS_PAGES.map((page) => page.id)
    for (const entry of SETTINGS_ITEMS) {
      const owner = pageIds.find((id) => entry.id.startsWith(`settings-${id}-`))
      expect(owner, `${entry.id} belongs to no page`).toBeTruthy()
    }
  })

  it('anchors every setting inside the page that claims it', async () => {
    // The anchor has to exist in the source of the route it points at, or the
    // result would open the page and then fail to scroll anywhere.
    const { readFileSync } = await import('node:fs')
    const { dirname, resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    // Resolved against this file, not the working directory: the suite runs
    // from the repo root in CI and from `web-app` locally, and a cwd-relative
    // path only works in one of them.
    const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
    const sources = new Map<string, string>()
    const sourceFor = (file: string) => {
      if (!sources.has(file)) {
        sources.set(file, readFileSync(resolve(srcDir, file), 'utf8'))
      }
      return sources.get(file)!
    }

    for (const entry of SETTINGS_ITEMS) {
      // Provider entries are generated from runtime state, not from a page;
      // an entry that declared why it has no anchor has nothing to find.
      if (entry.providerName || !entry.anchor) continue
      const pageId = SETTINGS_PAGES.map((page) => page.id).find((id) =>
        entry.id.startsWith(`settings-${id}-`)
      )!
      const file = ROUTE_FILES[pageId]
      if (!file) continue
      const source = sourceFor(file)
      // Written literally in either quoting style — a page that renders its
      // rows from a schema maps the anchors in a plain object — or referenced
      // through the exported constant that keeps the two ends in step.
      const anchored =
        source.includes(`"${entry.anchor}"`) ||
        source.includes(`'${entry.anchor}'`) ||
        (entry.anchor === WEB_SEARCH_PROVIDER_CONFIG_ANCHOR &&
          source.includes('WEB_SEARCH_PROVIDER_CONFIG_ANCHOR'))
      expect(
        anchored,
        `${entry.anchor} is not anchored in ${file}`
      ).toBe(true)
    }
  })
})

/** Where each page's source lives, relative to `web-app/src`. */
const ROUTE_FILES: Record<string, string> = {
  general: 'routes/settings/general.tsx',
  appearance: 'routes/settings/interface.tsx',
  assistants: 'routes/settings/assistant.tsx',
  attachments: 'routes/settings/attachments.tsx',
  'local-api-server': 'routes/settings/local-api-server.tsx',
  'https-proxy': 'routes/settings/https-proxy.tsx',
  'web-search': 'routes/settings/web-search.tsx',
  'agent-tools': 'routes/settings/agent-tools.tsx',
  shortcuts: 'routes/settings/shortcuts.tsx',
  hardware: 'routes/settings/hardware.tsx',
  'mcp-servers': 'routes/settings/mcp-servers.tsx',
  'claude-code': 'routes/settings/claude-code.tsx',
}
