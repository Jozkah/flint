// Pure tab logic for the iOS tab bar.
import type { HomeMode, Route } from '../state/router'

export type IosTab = 'chat' | 'cowork' | 'rooms' | 'studio' | 'more'

export const IOS_TABS: readonly IosTab[] = ['chat', 'cowork', 'rooms', 'studio', 'more']

/** The route a tab opens. */
export function tabRoute(tab: IosTab): Route {
  switch (tab) {
    case 'chat':
      return { name: 'home', mode: 'chat' }
    case 'cowork':
      return { name: 'home', mode: 'cowork' }
    case 'rooms':
      return { name: 'rooms' }
    case 'studio':
      return { name: 'studio' }
    default:
      return { name: 'settings' }
  }
}

/** Which tab a route belongs to; `homeMode` is the home screen's current mode. */
export function tabForRoute(route: Route, homeMode: HomeMode = 'chat'): IosTab {
  switch (route.name) {
    case 'home': {
      const mode = route.mode ?? homeMode
      return mode === 'cowork' ? 'cowork' : mode === 'room' ? 'rooms' : 'chat'
    }
    case 'chat':
      return 'chat'
    case 'cowork':
      return 'cowork'
    case 'room':
    case 'rooms':
      return 'rooms'
    case 'studio':
      return 'studio'
    default:
      return 'more'
  }
}

/** Tab roots show the tab bar; everything else is pushed with a back chevron. */
export function isTabRoot(route: Route): boolean {
  return route.name === 'home' || route.name === 'rooms' || route.name === 'studio' || route.name === 'settings'
}

/** Where a pushed screen's back goes when there is no in-app history. */
export function backFallback(route: Route): Route {
  if (route.name === 'chat') return { name: 'home', mode: 'chat' }
  if (route.name === 'cowork') return { name: 'home', mode: 'cowork' }
  if (route.name === 'room') return { name: 'rooms' }
  return { name: 'settings' }
}
