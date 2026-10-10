import { route } from '@/constants/routes'
import { SETTINGS_PAGES } from '@/lib/settingsSearch'

/**
 * The top header's "Parent / Current" trail for a path. The parent is the
 * sidebar section the page belongs to; `to` is where clicking it goes. The
 * current label is an i18n key, except where the page supplies a name (a
 * thread, project, room or provider), which the header fills in.
 */
export type Crumb = {
  parentKey: string
  parentTo: string
  /** i18n key for the current page, or null when `dynamic` names it. */
  currentKey: string | null
  dynamic?: 'thread' | 'project' | 'room' | 'provider' | 'session'
  param?: string
}

const within = (path: string, base: string) =>
  path === base || path.startsWith(`${base}/`)

export function crumbForPath(pathname: string): Crumb {
  const path = pathname.replace(/\/+$/, '') || '/'
  const ws = { parentKey: 'common:appRail.workspace', parentTo: route.home }
  const engine = {
    parentKey: 'common:shell.engine',
    parentTo: route.settings.model_providers,
  }
  const support = { parentKey: 'common:shell.support', parentTo: route.appLogs }

  if (path === '/') return { ...ws, currentKey: 'common:newChat' }
  if (path === route.overview) return { ...ws, currentKey: 'common:shell.usageOverview' }
  if (path.startsWith('/threads/'))
    return {
      parentKey: 'common:chats',
      parentTo: route.home,
      currentKey: null,
      dynamic: 'thread',
      param: path.slice('/threads/'.length),
    }
  if (path.startsWith('/project/'))
    return {
      parentKey: 'common:chats',
      parentTo: route.home,
      currentKey: null,
      dynamic: 'project',
      param: path.slice('/project/'.length),
    }
  if (path === route.cowork)
    return {
      parentKey: 'common:cowork',
      parentTo: route.cowork,
      currentKey: null,
      dynamic: 'session',
    }
  if (path === route.artifacts) return { ...ws, currentKey: 'common:appRail.library' }
  if (path === route.archive) return { ...ws, currentKey: 'archive:nav' }
  if (path === '/hub' || path.startsWith('/hub/'))
    return { ...ws, currentKey: 'common:shell.discover' }
  if (path === route.studio) return { ...ws, currentKey: 'archive:kind.studio' }
  if (path === route.rooms) return { ...ws, currentKey: 'common:appRail.rooms' }
  if (path.startsWith(`${route.rooms}/`))
    return {
      parentKey: 'common:appRail.rooms',
      parentTo: route.rooms,
      currentKey: null,
      dynamic: 'room',
      param: path.slice(route.rooms.length + 1),
    }
  if (path === route.settings.model_providers)
    return { ...engine, currentKey: 'common:appRail.models' }
  if (path.startsWith(`${route.settings.model_providers}/`))
    return {
      parentKey: 'common:appRail.models',
      parentTo: route.settings.model_providers,
      currentKey: null,
      dynamic: 'provider',
      param: decodeURIComponent(path.slice(route.settings.model_providers.length + 1)),
    }
  if (within(path, route.settings.mcp_servers))
    return { ...engine, currentKey: 'common:shell.toolsAndMcp' }
  if (within(path, route.extensions))
    return { ...engine, currentKey: 'common:appRail.extensions' }
  if (within(path, route.systemMonitor))
    return { ...engine, currentKey: 'common:shell.systemMonitor' }
  if (within(path, route.localApiServerlogs))
    return { ...support, currentKey: 'common:local_api_server' }
  if (within(path, route.appLogs)) return { ...support, currentKey: 'common:shell.logs' }
  if (within(path, route.settings.index)) {
    const page = SETTINGS_PAGES.find((p) => p.route === path)
    return {
      parentKey: 'common:settings',
      parentTo: route.settings.general,
      currentKey: page?.titleKey ?? 'common:general',
    }
  }
  return { ...ws, currentKey: 'common:appRail.workspace' }
}
