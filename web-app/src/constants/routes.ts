export const route = {
  // home as new chat or thread
  home: '/',
  overview: '/overview',
  cowork: '/cowork',
  artifacts: '/artifacts',
  studio: '/studio',
  translate: '/translate',
  archive: '/archive',
  extensions: '/extensions',
  appLogs: '/logs',
  project: '/project',
  projectDetail: '/project/$projectId',
  campaigns: '/campaigns',
  campaignDetail: '/campaign/$campaignId',
  rooms: '/rooms',
  roomDetail: '/rooms/$roomId',
  hub: {
    index: '/hub/',
    model: '/hub/$modelId',
  },
  settings: {
    index: '/settings',
    model_providers: '/settings/providers',
    providers: '/settings/providers/$providerName',
    general: '/settings/general',
    chat: '/settings/chat',
    data: '/settings/data',
    integrations: '/settings/integrations',
    attachments: '/settings/attachments',
    appearance: '/settings/appearance',
    /** Redirects to `appearance`; kept so old links and bookmarks still open. */
    interface: '/settings/interface',
    shortcuts: '/settings/shortcuts',
    extensions: '/settings/extensions',
    local_api_server: '/settings/local-api-server',
    mcp_servers: '/settings/mcp-servers',
    network_proxy: '/settings/network-proxy',
    /** Redirects to `network_proxy`. */
    https_proxy: '/settings/https-proxy',
    web_search: '/settings/web-search',
    agent: '/settings/agent',
    /** Redirects to `agent`. */
    agent_tools: '/settings/agent-tools',
    memory: '/settings/memory',
    schedules: '/settings/schedules',
    permissions: '/settings/permissions',
    assistant: '/settings/assistant',
    claude_code: '/settings/claude-code',
    jev: '/settings/jev',
    remote_access: '/settings/remote-access',
  },
  localApiServerlogs: '/local-api-server/logs',
  systemMonitor: '/system-monitor',
  threadsDetail: '/threads/$threadId',
} as const

/**
 * Routes belonging to the Cowork surface, so the sidebar keeps the Cowork nav
 * instead of falling back to Home. A new Cowork route only has to be added here.
 */
export const isCoworkRoute = (pathname: string): boolean =>
  pathname === route.cowork ||
  pathname === route.artifacts ||
  pathname === route.campaigns ||
  pathname.startsWith('/campaign/')
