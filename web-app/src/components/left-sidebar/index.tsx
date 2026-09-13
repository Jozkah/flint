import { NavChats } from './NavChats'
import { NavCowork } from './NavCowork'
import { NavMain } from './NavMain'
import { NavProjects } from './NavProjects'
import { NavTabs } from './NavTabs'

import {
  Sidebar,
  SidebarContent,
  SidebarTrigger,
  SidebarHeader,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { useTitlebarLayout } from '@/stores/titlebar-layout-store'
import { detectMacOverlay, resolveSidebarTitlebar } from '@/lib/titlebar'
import { useMemo } from 'react'
import { useLocation } from '@tanstack/react-router'
import { isCoworkRoute } from '@/constants/routes'
import { areaForPath, isSettingsArea } from '@/lib/shellNavigation'
import { AppRail } from '@/components/shell/AppRail'
import SettingsMenu from '@/containers/SettingsMenu'

/**
 * The contextual sidebar (256px, resizable 220-300px). Its contents follow the
 * current rail area: the workspace navigation (chats, projects or Cowork
 * sessions) for Workspace and Library, and the settings navigation for Models,
 * Tools and Settings. On phones it is the second column of the navigation
 * sheet, beside the rail.
 */
export function LeftSidebar() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const { setOpenMobile } = useSidebar()
  const area = areaForPath(pathname)
  const isCowork = isCoworkRoute(pathname)
  const settingsNav = isSettingsArea(area)
  // Right-align the header when native controls own the top-left (macOS, or a
  // Linux DE placing buttons left).
  const leftButtons = useTitlebarLayout((s) => s.layout.left.length)
  const macOverlay = useMemo(() => detectMacOverlay(), [])
  const { reserveLeft } = resolveSidebarTitlebar(macOverlay, leftButtons)

  return (
    <Sidebar
      variant="sidebar"
      collapsible="offcanvas"
      mobileLabel={t('common:appRail.label')}
      mobileLeading={
        <AppRail className="h-full" onNavigate={() => setOpenMobile(false)} />
      }
    >
      <SidebarHeader className="h-[72px] shrink-0 justify-center gap-0 px-4 py-0">
        <div
          className={cn(
            'flex w-full items-center justify-between gap-2',
            reserveLeft && 'pl-16'
          )}
        >
          <span className="truncate text-[11px] font-medium uppercase tracking-[0.14em] text-ink-2">
            {t(`common:appRail.${area}`)}
          </span>
          <SidebarTrigger className="text-muted-foreground hover:bg-sunken pointer-coarse:size-11" />
        </div>
      </SidebarHeader>
      {settingsNav ? (
        <SidebarContent className="px-2 pb-3">
          <SettingsMenu variant="sidebar" />
        </SidebarContent>
      ) : (
        <>
          <div className="flex flex-col gap-1 px-2 pb-2">
            <NavTabs />
            {isCowork ? <NavCowork /> : <NavMain />}
          </div>
          <SidebarContent className="px-2 pb-3">
            {!isCowork && (
              <>
                <NavProjects />
                <NavChats />
              </>
            )}
          </SidebarContent>
        </>
      )}
      <SidebarRail />
    </Sidebar>
  )
}
