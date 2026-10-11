import { route } from '@/constants/routes'

export type SidebarTab = 'chat' | 'cowork'

/**
 * The tab a page belongs to, or null for pages both tabs share (Models,
 * Discover, Settings, Resume & usage), which keep whichever tab is showing.
 */
export function tabForPath(pathname: string): SidebarTab | null {
  const path = pathname.replace(/\/+$/, '') || '/'
  const within = (base: string) => path === base || path.startsWith(`${base}/`)
  if (
    path === '/' ||
    within('/threads') ||
    within('/project') ||
    within(route.artifacts)
  ) {
    return 'chat'
  }
  const cowork = [
    route.cowork,
    '/campaign',
    route.rooms,
    route.studio,
    route.extensions,
    route.archive,
    route.appLogs,
    route.systemMonitor,
    route.localApiServerlogs,
    route.settings.mcp_servers,
    route.settings.schedules,
    route.settings.local_api_server,
  ]
  return cowork.some(within) ? 'cowork' : null
}
