import { route } from '@/constants/routes'
import type { LucideIcon } from 'lucide-react'
import { Languages, Workflow } from 'lucide-react'
import type { IconName } from '@/components/ui/icon'

/**
 * Every sidebar destination the person can hide, as one list.
 *
 * The sidebar, the Settings card, the command palette and the first-run guide
 * all read this, so an item added here shows up in each of them. Items are
 * visible by default: a new entry appears for everyone until they hide it, and
 * a saved id the app no longer knows is ignored.
 */

export type SidebarSection = 'workspace' | 'cowork' | 'more' | 'header'

export type SidebarItem = {
  /** Stable id, saved in settings. Never rename one. */
  id: string
  /** i18n key of the label the sidebar already shows. */
  labelKey: string
  section: SidebarSection
  /** Resolved on use, so importing the list needs no routes yet. */
  to: () => string
  icon: IconName
  /** A lucide glyph drawn instead of `icon`; the one place the choice lives. */
  lucide?: LucideIcon
  /** False for what the app cannot be driven without. */
  canHide: boolean
}

export const SIDEBAR_SECTIONS: readonly SidebarSection[] = [
  'workspace',
  'cowork',
  'more',
  'header',
]

export const SIDEBAR_ITEMS: readonly SidebarItem[] = [
  { id: 'new-chat', labelKey: 'common:newChat', section: 'workspace', to: () => route.home, icon: 'comment', canHide: false },
  { id: 'library', labelKey: 'common:appRail.library', section: 'workspace', to: () => route.artifacts, icon: 'x-library', canHide: true },
  { id: 'translate', labelKey: 'common:translate.title', section: 'workspace', to: () => route.translate, icon: 'x-library', lucide: Languages, canHide: true },
  { id: 'models', labelKey: 'common:appRail.models', section: 'workspace', to: () => route.settings.model_providers, icon: 'x-cube', canHide: true },
  { id: 'discover', labelKey: 'common:shell.discover', section: 'workspace', to: () => route.hub.index, icon: 'search', canHide: true },
  { id: 'campaigns', labelKey: 'settings:campaigns.nav', section: 'cowork', to: () => route.campaigns, icon: 'x-cowork', lucide: Workflow, canHide: true },
  { id: 'studio', labelKey: 'common:shell.studio', section: 'cowork', to: () => route.studio, icon: 'x-palette', canHide: true },
  { id: 'tools', labelKey: 'common:shell.toolsAndMcp', section: 'cowork', to: () => route.settings.mcp_servers, icon: 'flow', canHide: true },
  { id: 'extensions', labelKey: 'common:appRail.extensions', section: 'cowork', to: () => route.extensions, icon: 'x-puzzle', canHide: true },
  { id: 'schedules', labelKey: 'common:shell.schedules', section: 'cowork', to: () => route.settings.schedules, icon: 'x-refresh', canHide: true },
  { id: 'logs', labelKey: 'common:shell.logs', section: 'more', to: () => route.appLogs, icon: 'x-terminal', canHide: true },
  { id: 'archive', labelKey: 'archive:nav', section: 'more', to: () => route.archive, icon: 'x-disk', canHide: true },
  { id: 'local-api', labelKey: 'common:shell.localApi', section: 'more', to: () => route.settings.local_api_server, icon: 'x-server', canHide: true },
  { id: 'system-monitor', labelKey: 'common:shell.systemMonitor', section: 'more', to: () => route.systemMonitor, icon: 'x-monitor', canHide: true },
  { id: 'overview', labelKey: 'common:shell.resume', section: 'header', to: () => route.overview, icon: 'sb-dashboard', canHide: true },
  { id: 'settings', labelKey: 'common:appRail.settings', section: 'header', to: () => route.settings.general, icon: 'sb-settings', canHide: false },
]

export const getSidebarItem = (id: string): SidebarItem | undefined =>
  BY_ID.get(id)

const BY_ID = new Map(SIDEBAR_ITEMS.map((item) => [item.id, item]))

export const hideableSidebarIds = (): string[] =>
  SIDEBAR_ITEMS.filter((i) => i.canHide).map((i) => i.id)

/** Keep only strings, once each: what a saved or hand-edited value may hold. */
export function sanitizeHiddenSidebarItems(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((v): v is string => typeof v === 'string'))]
}

/**
 * Whether the sidebar leaves an item out. Unknown ids and items that cannot be
 * hidden never count, so a stale or hand-edited setting cannot strand anyone.
 */
export function isSidebarItemHidden(
  hidden: readonly string[] | undefined,
  id: string
): boolean {
  const item = BY_ID.get(id)
  return Boolean(item?.canHide && hidden?.includes(id))
}
