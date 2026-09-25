// The settings-search registry: one typed, static description of Flint's
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
  /**
   * Required when `anchor` is absent: why this setting cannot carry one.
   *
   * A setting inside a popover or a conditional branch is not in the document
   * when a search result arrives, so an anchor would promise a scroll and a
   * highlight that never happen. Such an entry stays findable and navigable —
   * it opens the right page — and says so here. The structural coverage test
   * holds every other entry to having an anchor.
   */
  anchorNote?: string
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
  /**
   * How this page is searchable.
   *
   * `'items'` — the default — means the page must contribute at least one
   * entry to {@link SETTINGS_ITEMS}, each with its own stable anchor. A page
   * that renders only a list built at runtime cannot, and declares
   * `'page-only'` with a `coverageNote` saying why: the structural coverage
   * test holds every other page to the stronger rule, so a page added without
   * search coverage fails rather than being quietly unreachable.
   */
  coverage?: 'items' | 'page-only'
  /** Required with `coverage: 'page-only'`: why this page has no entries. */
  coverageNote?: string
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
    id: 'memory',
    route: route.settings.memory,
    titleKey: 'common:memory',
    group: 'core',
    keywords: [
      'remember',
      'forget',
      'recall',
      'across chats',
      'project memory',
      'personalisation',
    ],
  },
  {
    id: 'permissions',
    route: route.settings.permissions,
    titleKey: 'permissions:settings.title',
    group: 'core',
    keywords: [
      'approval',
      'allow',
      'always allow',
      'trust',
      'revoke',
      'tool permissions',
    ],
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
    coverage: 'page-only',
    coverageNote:
      'The page lists the extensions actually installed, which is runtime ' +
      'state; there is no static setting to anchor. Reached by page title.',
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

/** Anchors on the Memory page, so a search result can scroll to the control it
 * names rather than dropping the reader at the top of the page. */
export const MEMORY_AUTOSAVE_ANCHOR = 'settings-memory-automatically-save'
export const MEMORY_STORAGE_ANCHOR = 'settings-memory-stored'
export const MEMORY_LIST_ANCHOR = 'settings-memory-remembered'

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
  item('appearance', 'reduce-motion', 'settings:appearance.reduceMotion', {
    descriptionKey: 'settings:appearance.reduceMotionDesc',
    keywords: ['animation', 'motion', 'accessibility', 'transitions'],
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
  // Search-only labels: the page's own strings interpolate the chosen
  // provider's name, and the index resolves keys with no options, so those
  // would render a literal "{{provider}}" in the results.
  item('web-search', 'api-key', 'settings:webSearch.apiKeySearch', {
    anchor: WEB_SEARCH_PROVIDER_CONFIG_ANCHOR,
    keywords: ['api key', 'credentials', 'search provider'],
  }),
  item('web-search', 'endpoint', 'settings:webSearch.endpointSearch', {
    anchor: WEB_SEARCH_PROVIDER_CONFIG_ANCHOR,
    descriptionKey: 'settings:webSearch.endpointSearchDesc',
    keywords: ['url', 'searxng'],
  }),
  // Memory
  item('memory', 'automatically-save', 'settings:memory.automaticallySave', {
    anchor: MEMORY_AUTOSAVE_ANCHOR,
    descriptionKey: 'settings:memory.automaticallySaveDesc',
    keywords: ['remember automatically', 'inferred', 'approval', 'consent'],
  }),
  item('memory', 'stored', 'settings:memory.stored', {
    anchor: MEMORY_STORAGE_ANCHOR,
    descriptionKey: 'settings:memory.storedDesc',
    keywords: ['storage', 'size', 'how many'],
  }),
  item('memory', 'remembered', 'settings:memory.remembered', {
    anchor: MEMORY_LIST_ANCHOR,
    descriptionKey: 'settings:memory.rememberedDesc',
    keywords: ['edit memory', 'forget', 'pin', 'across chats', 'this project'],
  }),
  // Permissions
  item('permissions', 'conversations', 'permissions:settings.conversations', {
    descriptionKey: 'permissions:settings.conversationsDesc',
    keywords: ['allow in thread', 'this conversation', 'revoke'],
  }),
  item('permissions', 'everywhere', 'permissions:settings.everywhere', {
    descriptionKey: 'permissions:settings.everywhereDesc',
    keywords: ['always allow', 'trusted servers', 'mcp trust', 'revoke'],
  }),
  item('permissions', 'history', 'permissions:settings.history', {
    descriptionKey: 'permissions:settings.historyDesc',
    keywords: ['audit', 'log', 'decisions', 'denied'],
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
    anchorNote:
      'Rendered inside the Configuration popover, which is unmounted until it ' +
      'is opened, so there is nothing to scroll to on arrival.',
    descriptionKey: 'settings:localApiServer.serverHostDesc',
    keywords: ['host', 'address', 'bind'],
  }),
  item('local-api-server', 'port', 'settings:localApiServer.serverPort', {
    anchor: undefined,
    anchorNote:
      'Rendered inside the Configuration popover, which is unmounted until it ' +
      'is opened, so there is nothing to scroll to on arrival.',
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

  // Assistants
  item('assistants', 'default', 'assistants:defaultAssistantSection', {
    keywords: ['persona', 'instructions', 'system prompt'],
  }),

  // Shortcuts
  item('shortcuts', 'new-chat', 'settings:shortcuts.newChat', {
    keywords: ['keybinding', 'hotkey', 'start chat'],
  }),
  item('shortcuts', 'new-project', 'settings:shortcuts.newProject', {
    keywords: ['keybinding', 'hotkey'],
  }),
  item('shortcuts', 'toggle-sidebar', 'settings:shortcuts.toggleSidebar', {
    keywords: ['keybinding', 'hotkey', 'hide panel', 'show panel'],
  }),
  item('shortcuts', 'zoom-in', 'settings:shortcuts.zoomIn', {
    keywords: ['keybinding', 'hotkey', 'bigger', 'enlarge'],
  }),
  item('shortcuts', 'zoom-out', 'settings:shortcuts.zoomOut', {
    keywords: ['keybinding', 'hotkey', 'smaller'],
  }),
  item('shortcuts', 'send-message', 'settings:shortcuts.sendMessage', {
    keywords: ['keybinding', 'hotkey', 'enter', 'submit'],
  }),
  item('shortcuts', 'new-line', 'settings:shortcuts.newLine', {
    keywords: ['keybinding', 'hotkey', 'shift enter'],
  }),
  item(
    'shortcuts',
    'switch-assistant',
    'settings:shortcuts.switchAssistant',
    { keywords: ['keybinding', 'hotkey', 'change assistant'] }
  ),
  item('shortcuts', 'search', 'settings:shortcuts.search', {
    keywords: ['keybinding', 'hotkey', 'find'],
  }),
  item('shortcuts', 'go-to-settings', 'settings:shortcuts.goToSettings', {
    keywords: ['keybinding', 'hotkey', 'preferences'],
  }),

  // Hardware — read-only sections, but the headings are what a user looks for.
  item('hardware', 'os', 'settings:hardware.os', {
    keywords: ['operating system', 'platform', 'version'],
  }),
  item('hardware', 'cpu', 'settings:hardware.cpu', {
    keywords: ['processor', 'cores', 'architecture'],
  }),
  item('hardware', 'memory', 'settings:hardware.memory', {
    keywords: ['ram', 'gb', 'available memory'],
  }),

  // MCP servers
  item('mcp-servers', 'allow-permissions', 'mcp-servers:allowPermissions', {
    keywords: ['approve', 'tool permission', 'trust'],
  }),
  item(
    'mcp-servers',
    'tool-call-timeout',
    'mcp-servers:runtimeSettings.toolCallTimeout',
    { keywords: ['timeout', 'seconds', 'slow tool'] }
  ),
  item(
    'mcp-servers',
    'max-tool-output',
    'mcp-servers:runtimeSettings.maxToolOutputChars',
    { keywords: ['truncate', 'characters', 'output limit'] }
  ),
  item(
    'mcp-servers',
    'smart-tool-routing',
    'mcp-servers:runtimeSettings.smartToolRouting',
    { keywords: ['routing', 'tool selection'] }
  ),
  item(
    'mcp-servers',
    'lightweight-router',
    'mcp-servers:runtimeSettings.useLightweightRouterModel',
    { keywords: ['router model', 'small model', 'routing'] }
  ),
  item('mcp-servers', 'router-model', 'mcp-servers:runtimeSettings.routerModel', {
    keywords: ['router', 'model selection'],
  }),

  // Claude Code
  item('claude-code', 'large-model', 'settings:claudeCode.largeModel', {
    descriptionKey: 'settings:claudeCode.largeModelDesc',
    keywords: ['opus', 'model', 'claude code'],
  }),
  item('claude-code', 'medium-model', 'settings:claudeCode.mediumModel', {
    descriptionKey: 'settings:claudeCode.mediumModelDesc',
    keywords: ['sonnet', 'model', 'claude code'],
  }),
  item('claude-code', 'small-model', 'settings:claudeCode.smallModel', {
    descriptionKey: 'settings:claudeCode.smallModelDesc',
    keywords: ['haiku', 'model', 'claude code'],
  }),
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
