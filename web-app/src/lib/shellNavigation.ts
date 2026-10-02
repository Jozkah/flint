import { route } from '@/constants/routes'

/**
 * Which part of the app a path belongs to. The sidebar marks its current row
 * from this and settings pages decide whether to show their section list, so
 * the two cannot disagree.
 */
export type ShellArea =
  | 'workspace'
  | 'rooms'
  | 'library'
  | 'models'
  | 'tools'
  | 'extensions'
  | 'system'
  | 'settings'

/** @deprecated The rail is gone; kept as an alias for existing imports. */
export type RailArea = ShellArea

const within = (pathname: string, base: string) =>
  pathname === base || pathname.startsWith(`${base}/`)

export function areaForPath(pathname: string): ShellArea {
  const path = pathname.replace(/\/+$/, '') || '/'
  const systemPages = [route.systemMonitor, route.appLogs, route.localApiServerlogs]
  if (within(path, route.rooms)) return 'rooms'
  if (within(path, route.artifacts)) return 'library'
  if (within(path, route.extensions)) return 'extensions'
  if (within(path, route.hub.index.replace(/\/$/, ''))) return 'models'
  if (within(path, route.settings.model_providers)) return 'models'
  if (within(path, route.settings.mcp_servers)) return 'tools'
  if (systemPages.some((p) => within(path, p))) return 'system'
  if (within(path, route.settings.index)) return 'settings'
  return 'workspace'
}

/**
 * Whether a settings body shows its Sections list: every page under Settings,
 * model providers included (the list links to it, so it must stay).
 */
export function showsSettingsSections(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/'
  return within(path, route.settings.index)
}
