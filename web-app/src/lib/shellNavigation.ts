import { route } from '@/constants/routes'

/**
 * The global rail of the Flint Atelier shell. Every destination is an existing
 * route (or, for Search, the existing search dialog); the rail only groups
 * them. `areaForPath` decides which rail item is current, so the rail, the
 * sidebar title and the phone navigation sheet cannot disagree.
 */
export type RailArea =
  | 'workspace'
  | 'rooms'
  | 'library'
  | 'models'
  | 'tools'
  | 'extensions'
  | 'search'
  | 'system'
  | 'settings'

export type RailItem = {
  id: RailArea
  /** i18n key in the `common` namespace. */
  labelKey: string
  group: 'top' | 'bottom'
  /** Route opened by the item; Search opens the search dialog instead. */
  to?: string
}

export const RAIL_ITEMS: readonly RailItem[] = [
  { id: 'workspace', labelKey: 'common:appRail.workspace', group: 'top', to: route.home },
  { id: 'rooms', labelKey: 'common:appRail.rooms', group: 'top', to: route.rooms },
  { id: 'library', labelKey: 'common:appRail.library', group: 'top', to: route.artifacts },
  {
    id: 'models',
    labelKey: 'common:appRail.models',
    group: 'top',
    to: route.settings.model_providers,
  },
  { id: 'tools', labelKey: 'common:appRail.tools', group: 'top', to: route.settings.mcp_servers },
  { id: 'extensions', labelKey: 'common:appRail.extensions', group: 'top', to: route.extensions },
  { id: 'search', labelKey: 'common:appRail.search', group: 'bottom' },
  { id: 'system', labelKey: 'common:appRail.system', group: 'bottom', to: route.systemMonitor },
  { id: 'settings', labelKey: 'common:appRail.settings', group: 'bottom', to: route.settings.general },
]

/** Settings pages that configure what the agent can call. */
const TOOLS_PAGES = [
  route.settings.mcp_servers,
  route.settings.agent_tools,
  route.settings.web_search,
  route.settings.extensions,
  route.settings.claude_code,
]

const SYSTEM_PAGES = [route.systemMonitor, route.appLogs, route.localApiServerlogs]

const within = (pathname: string, base: string) =>
  pathname === base || pathname.startsWith(`${base}/`)

export function areaForPath(pathname: string): RailArea {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (within(path, route.rooms)) return 'rooms'
  if (within(path, route.artifacts)) return 'library'
  if (within(path, route.extensions)) return 'extensions'
  if (within(path, route.settings.model_providers) || within(path, route.settings.hardware))
    return 'models'
  if (TOOLS_PAGES.some((p) => within(path, p))) return 'tools'
  if (SYSTEM_PAGES.some((p) => within(path, p))) return 'system'
  if (within(path, route.settings.index)) return 'settings'
  return 'workspace'
}

/** Areas whose contextual sidebar is the settings navigation. */
export const isSettingsArea = (area: RailArea) =>
  area === 'models' || area === 'tools' || area === 'settings'
