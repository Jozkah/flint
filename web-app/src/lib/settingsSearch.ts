// The settings-search registry: one typed, static description of Jan's
// settings surface, driving both the Settings sidebar and the search field.
//
// Only stable metadata lives here — routes, i18n keys, anchors and keyword
// synonyms. Never current values: indexing what a setting is set to (an API
// key, a folder path, a token) would put private data one keystroke away.

import Fuse from 'fuse.js'
import { route } from '@/constants/routes'
import { getProviderTitle } from '@/lib/utils'

/** One searchable entry of the registry, as specified for the search index. */
export type SettingsSearchItem = {
  id: string
  route: string
  section: string
  titleKey: string
  descriptionKey?: string
  keywords?: string[]
  anchor?: string
  providerName?: string
}

/** One settings page. The same list renders the sidebar, so a page added here
 * appears in navigation and search together. */
export type SettingsPage = {
  id: string
  route: string
  titleKey: string
  group: 'core' | 'integrations'
  keywords?: readonly string[]
}

/**
 * `as const satisfies` so the ids stay literal: {@link SettingsPageId} is
 * derived from this list, and anything keyed by it — the sidebar's icon map —
 * then fails to compile when a page is added or renamed, instead of silently
 * falling back to a default.
 */
export const SETTINGS_PAGES = [
  {
    id: 'general',
    route: route.settings.general,
    titleKey: 'common:general',
    group: 'core',
    keywords: ['updates', 'data folder', 'language'],
  },
  {
    id: 'appearance',
    route: route.settings.interface,
    titleKey: 'common:appearance',
    group: 'core',
    keywords: ['interface', 'theme', 'font'],
  },
  {
    id: 'assistants',
    route: route.settings.assistant,
    titleKey: 'common:assistants',
    group: 'core',
    keywords: ['persona', 'instructions'],
  },
  {
    id: 'attachments',
    route: route.settings.attachments,
    titleKey: 'common:attachments',
    group: 'core',
    keywords: ['files', 'documents', 'rag'],
  },
  {
    id: 'local-api-server',
    route: route.settings.local_api_server,
    titleKey: 'common:local_api_server',
    group: 'core',
    keywords: ['server', 'openai compatible', 'port'],
  },
  {
    id: 'https-proxy',
    route: route.settings.https_proxy,
    titleKey: 'common:https_proxy',
    group: 'core',
    keywords: ['proxy', 'network', 'ssl'],
  },
  {
    id: 'web-search',
    route: route.settings.web_search,
    titleKey: 'common:web_search',
    group: 'core',
    keywords: ['internet', 'browse', 'search engine'],
  },
  {
    id: 'agent-tools',
    route: route.settings.agent_tools,
    titleKey: 'common:agent_tools',
    group: 'core',
    keywords: ['sandbox', 'shell', 'memory', 'skills'],
  },
  {
    id: 'shortcuts',
    route: route.settings.shortcuts,
    titleKey: 'common:keyboardShortcuts',
    group: 'core',
    keywords: ['keyboard', 'hotkeys', 'keybindings'],
  },
  {
    id: 'hardware',
    route: route.settings.hardware,
    titleKey: 'common:hardware',
    group: 'core',
    keywords: ['gpu', 'cpu', 'ram', 'vram'],
  },
  {
    id: 'privacy',
    route: route.settings.privacy,
    titleKey: 'common:privacy',
    group: 'core',
    keywords: ['analytics', 'telemetry', 'data'],
  },
  {
    id: 'mcp-servers',
    route: route.settings.mcp_servers,
    titleKey: 'common:mcp-servers',
    group: 'integrations',
    keywords: ['mcp', 'model context protocol', 'tools'],
  },
  {
    id: 'claude-code',
    route: route.settings.claude_code,
    titleKey: 'common:claude_code',
    group: 'integrations',
    keywords: ['claude', 'cli', 'code'],
  },
  {
    id: 'extensions',
    route: route.settings.extensions,
    titleKey: 'common:extensions',
    group: 'integrations',
    keywords: ['plugins', 'add-ons'],
  },
] as const satisfies readonly SettingsPage[]

/** Every page id in the registry, as a literal union. */
export type SettingsPageId = (typeof SETTINGS_PAGES)[number]['id']

/**
 * Anchor for the web-search provider configuration group.
 *
 * A provider takes an instance URL (SearXNG) or an API key (Exa, Tavily),
 * never both, so the page renders one control or the other. Anchoring each
 * entry to its own control would leave whichever is unmounted navigating to a
 * page where nothing scrolls or highlights, so both point here instead — at
 * the group that wraps the conditional and is therefore always rendered.
 *
 * Exported so `routes/settings/web-search.tsx` renders this exact id and the
 * two cannot drift apart under a rename.
 */
export const WEB_SEARCH_PROVIDER_CONFIG_ANCHOR =
  'settings-web-search-provider-config'

const sectionOf = (pageId: string): string =>
  SETTINGS_PAGES.find((p) => p.id === pageId)?.titleKey ?? 'common:settings'

const item = (
  pageId: string,
  name: string,
  titleKey: string,
  extras?: Partial<SettingsSearchItem>
): SettingsSearchItem => ({
  id: `settings-${pageId}-${name}`,
  anchor: `settings-${pageId}-${name}`,
  route:
    SETTINGS_PAGES.find((p) => p.id === pageId)?.route ?? route.settings.index,
  section: sectionOf(pageId),
  titleKey,
  ...extras,
})

/**
 * Individual settings, keyed by stable anchor ids (never translated strings).
 * `keywords` carry common synonyms so "dark mode" finds Theme and "telemetry"
 * finds analytics regardless of the active language.
 */
export const SETTINGS_ITEMS: SettingsSearchItem[] = [
  // General
  item('general', 'language', 'common:language', {
    keywords: ['locale', 'translation', 'idioma', 'sprache', 'langue'],
  }),
  item('general', 'data-folder', 'common:dataFolder', {
    descriptionKey: 'settings:dataFolder.appDataDesc',
    keywords: ['storage', 'location', 'move data', 'disk'],
  }),
  item('general', 'auto-update', 'settings:general.autoUpdateCheck', {
    descriptionKey: 'settings:general.autoUpdateCheckDesc',
    keywords: ['updates', 'version', 'upgrade'],
  }),
  item('general', 'spell-check', 'settings:others.spellCheck', {
    descriptionKey: 'settings:others.spellCheckDesc',
    keywords: ['spelling', 'typo'],
  }),
  item('general', 'factory-reset', 'settings:others.resetFactory', {
    descriptionKey: 'settings:others.resetFactoryDesc',
    keywords: ['reset', 'defaults', 'wipe'],
  }),
  // Appearance
  item('appearance', 'theme', 'settings:interface.theme', {
    descriptionKey: 'settings:interface.themeDesc',
    keywords: ['dark mode', 'light mode', 'color scheme', 'appearance'],
  }),
  item('appearance', 'font-size', 'settings:interface.fontSize', {
    descriptionKey: 'settings:interface.fontSizeDesc',
    keywords: ['text size', 'zoom', 'typography'],
  }),
  item(
    'appearance',
    'notification-position',
    'settings:interface.notificationPosition',
    {
      descriptionKey: 'settings:interface.notificationPositionDesc',
      keywords: ['toast', 'alerts'],
    }
  ),
  item('appearance', 'token-speed', 'settings:interface.showTokenSpeed', {
    descriptionKey: 'settings:interface.showTokenSpeedDesc',
    keywords: ['tokens per second', 'performance'],
  }),
  item(
    'appearance',
    'html-artifacts',
    'settings:interface.renderHtmlArtifacts',
    {
      descriptionKey: 'settings:interface.renderHtmlArtifactsDesc',
      keywords: ['html', 'preview', 'artifacts'],
    }
  ),
  item('appearance', 'auto-title', 'settings:interface.autoGenerateTitle', {
    descriptionKey: 'settings:interface.autoGenerateTitleDesc',
    keywords: ['thread title', 'naming'],
  }),
  // Privacy
  item('privacy', 'analytics', 'settings:privacy.helpUsImprove', {
    descriptionKey: 'settings:privacy.helpUsImproveDesc',
    keywords: ['analytics', 'telemetry', 'tracking', 'usage data'],
  }),
  // HTTPS proxy
  item('https-proxy', 'proxy-url', 'settings:httpsProxy.proxyUrl', {
    descriptionKey: 'settings:httpsProxy.proxyUrlDesc',
    keywords: ['proxy url', 'http proxy', 'network'],
  }),
  item('https-proxy', 'no-proxy', 'settings:httpsProxy.noProxy', {
    descriptionKey: 'settings:httpsProxy.noProxyDesc',
    keywords: ['bypass', 'exclusions'],
  }),
  item('https-proxy', 'ignore-ssl', 'settings:httpsProxy.ignoreSsl', {
    descriptionKey: 'settings:httpsProxy.ignoreSslDesc',
    keywords: ['certificates', 'tls', 'ssl verification'],
  }),
  // Web search
  item('web-search', 'enable', 'settings:webSearch.enable', {
    descriptionKey: 'settings:webSearch.enableDesc',
    keywords: ['web search', 'internet access'],
  }),
  // Two names for one conditional slot: both stay separately searchable, and
  // both land on the group. See WEB_SEARCH_PROVIDER_CONFIG_ANCHOR.
  item('web-search', 'api-key', 'settings:webSearch.apiKey', {
    anchor: WEB_SEARCH_PROVIDER_CONFIG_ANCHOR,
    keywords: ['api key', 'credentials', 'search provider'],
  }),
  item('web-search', 'endpoint', 'settings:webSearch.endpoint', {
    anchor: WEB_SEARCH_PROVIDER_CONFIG_ANCHOR,
    descriptionKey: 'settings:webSearch.endpointDesc',
    keywords: ['url', 'searxng'],
  }),
  // Agent tools
  item('agent-tools', 'enable', 'settings:agentTools.enable', {
    descriptionKey: 'settings:agentTools.enableDesc',
    keywords: ['agent', 'tools', 'filesystem'],
  }),
  item('agent-tools', 'network', 'settings:agentTools.network', {
    descriptionKey: 'settings:agentTools.networkDesc',
    keywords: ['bash network', 'sandbox network'],
  }),
  // Local API server.
  //
  // Host and port live inside the page's "Configuration" popover, which is
  // closed on arrival and unmounts its content. There is nothing on the page
  // to scroll to, so these carry no anchor: the result still finds them and
  // opens the page, and the search stops promising a highlight it cannot
  // deliver. Give them an anchor again if the controls move into the page.
  item('local-api-server', 'host', 'settings:localApiServer.serverHost', {
    anchor: undefined,
    descriptionKey: 'settings:localApiServer.serverHostDesc',
    keywords: ['host', 'address', 'bind'],
  }),
  item('local-api-server', 'port', 'settings:localApiServer.serverPort', {
    anchor: undefined,
    descriptionKey: 'settings:localApiServer.serverPortDesc',
    keywords: ['port', 'listen'],
  }),
  item(
    'local-api-server',
    'run-on-startup',
    'settings:localApiServer.runOnStartup',
    {
      descriptionKey: 'settings:localApiServer.runOnStartupDesc',
      keywords: ['autostart', 'boot'],
    }
  ),
  // Attachments
  item('attachments', 'enable', 'settings:attachments.enable', {
    descriptionKey: 'settings:attachments.enableDesc',
    keywords: ['attachments', 'files'],
  }),
  item('attachments', 'parse-mode', 'settings:attachments.parseMode', {
    descriptionKey: 'settings:attachments.parseModeDesc',
    keywords: ['embeddings', 'inline', 'rag'],
  }),
  item('attachments', 'max-file', 'settings:attachments.maxFile', {
    descriptionKey: 'settings:attachments.maxFileDesc',
    keywords: ['file size', 'limit'],
  }),
  // Hardware has no individual entries: the page is a read-out of the
  // detected CPU, RAM and GPUs plus a switch per device, none of which is a
  // named setting with a stable anchor. It stays findable as a page, with
  // "gpu"/"cpu"/"ram"/"vram" as its keywords.
  //
  // `settings:hardware.enableVulkan` was listed here, but the Vulkan toggle
  // it named has no UI anywhere — only a persisted store nothing reads. A
  // result for a control that does not exist is worse than no result.
]

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
 * Resolve the static registry plus the currently active providers into a flat,
 * translated index. Rebuilt whenever providers or the language change, so
 * providers added or removed at runtime appear and disappear with them.
 */
export function buildSettingsIndex(
  t: Translate,
  providers: ProviderForIndex[] = []
): SettingsIndexEntry[] {
  const entries: SettingsIndexEntry[] = []
  for (const page of SETTINGS_PAGES) {
    entries.push({
      kind: 'page',
      id: `page-${page.id}`,
      route: page.route,
      title: t(page.titleKey),
      section: t(page.titleKey),
      keywords: [...(page.keywords ?? [])],
    })
  }
  for (const setting of SETTINGS_ITEMS) {
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
      })
    }
  }
  return entries
}

/** Typo-tolerant search over the index. Case-insensitive by Fuse default. */
export function searchSettings(
  index: SettingsIndexEntry[],
  query: string,
  limit = 20
): SettingsIndexEntry[] {
  const trimmed = query.trim()
  if (!trimmed) return []
  const fuse = new Fuse(index, {
    keys: [
      { name: 'title', weight: 0.6 },
      { name: 'keywords', weight: 0.25 },
      { name: 'section', weight: 0.1 },
      { name: 'description', weight: 0.05 },
    ],
    threshold: 0.35,
    ignoreLocation: true,
  })
  return fuse.search(trimmed, { limit }).map((result) => result.item)
}
