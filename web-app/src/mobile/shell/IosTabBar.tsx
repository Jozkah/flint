import { D } from '../ui/bits'
import { go, useApp } from '../state/app'
import { IOS_TABS, isTabRoot, tabForRoute, tabRoute, type IosTab } from './iosTabs'
import { t } from '../i18n'

const ICON = {
  chat: 'x-edit',
  cowork: 'x-cowork',
  rooms: 'x-rooms',
  studio: 'x-palette',
  more: 'sb-settings',
} as const

const LABEL: Record<IosTab, () => string> = {
  chat: () => t('home.title'),
  cowork: () => t('home.modes.cowork'),
  rooms: () => t('rooms.title'),
  studio: () => t('studio.title'),
  more: () => t('settings.title'),
}

/** The iOS bottom tab bar; only mounted on iOS, only visible on tab roots. */
export function IosTabBar() {
  const route = useApp((s) => s.route)
  const homeMode = useApp((s) => s.homeMode)
  const visible = isTabRoot(route)
  const active = tabForRoute(route, homeMode)
  return (
    <nav className={`ios-tabbar${visible ? '' : ' hidden'}`} aria-label={t('shell.navigation')} inert={!visible}>
      {IOS_TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          className={`ios-tab${tab === active ? ' on' : ''}`}
          aria-current={tab === active ? 'page' : undefined}
          onClick={() => go(tabRoute(tab))}
        >
          <D n={ICON[tab]} size={24} />
          <span>{LABEL[tab]()}</span>
        </button>
      ))}
    </nav>
  )
}
