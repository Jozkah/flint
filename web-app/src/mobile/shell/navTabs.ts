// The drawer's Chat | Cowork tabs, mirroring the desktop sidebar: which tab a
// route belongs to, which one is remembered, and which destinations each tab
// lists. Pure, so the sets are testable without rendering.

import type { Route } from '../state/router'

export type NavTab = 'chat' | 'cowork'

export const TAB_KEY = 'flint.mobile.navTab'

/** Pages that belong to one tab. Everything else shows whichever tab is open. */
export function tabForRoute(route: Route): NavTab | null {
  switch (route.name) {
    case 'home':
      return route.mode === 'cowork' || route.mode === 'room' ? 'cowork' : route.mode === 'chat' ? 'chat' : null
    case 'chat':
    case 'library':
      return 'chat'
    case 'cowork':
    case 'campaigns':
    case 'campaign':
    case 'rooms':
    case 'room':
    case 'studio':
    case 'tools':
    case 'archive':
    case 'system':
      return 'cowork'
    default:
      return null
  }
}

export function readTab(): NavTab {
  try {
    return localStorage.getItem(TAB_KEY) === 'cowork' ? 'cowork' : 'chat'
  } catch {
    return 'chat'
  }
}

export function writeTab(tab: NavTab): void {
  try {
    localStorage.setItem(TAB_KEY, tab)
  } catch {
    /* storage unavailable: the tab is simply not remembered */
  }
}

/** The tab the drawer opens on: the route's own, else the remembered one. */
export const initialTab = (route: Route): NavTab => tabForRoute(route) ?? readTab()

export type NavItemId =
  | 'resume'
  | 'models'
  | 'discover'
  | 'settings'
  | 'newChat'
  | 'library'
  | 'newSession'
  | 'campaigns'
  | 'rooms'
  | 'studio'
  | 'tools'
  | 'more'

/** Top-to-bottom destinations per tab (the chats and sessions lists follow). */
export const TAB_ITEMS: Record<NavTab, NavItemId[]> = {
  chat: ['resume', 'newChat', 'library', 'models', 'discover', 'settings'],
  cowork: ['resume', 'newSession', 'campaigns', 'rooms', 'studio', 'tools', 'models', 'discover', 'more', 'settings'],
}

/** Behind the Cowork tab's one folded More row. */
export const MORE_ROUTES: Route[] = [{ name: 'archive' }, { name: 'system' }, { name: 'settings-sub', sub: 'localapi' }]
