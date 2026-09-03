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
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { useTitlebarLayout } from '@/stores/titlebar-layout-store'
import { detectMacOverlay, resolveSidebarTitlebar } from '@/lib/titlebar'
import { useMemo } from 'react'
import { useLocation } from '@tanstack/react-router'
import { isCoworkRoute } from '@/constants/routes'

export function LeftSidebar() {
  const { pathname } = useLocation()
  const isCowork = isCoworkRoute(pathname)
  // Right-align the header when native controls own the top-left (macOS, or a Linux
  // DE placing buttons left); "Jan" moves into the right cluster except on macOS.
  const leftButtons = useTitlebarLayout((s) => s.layout.left.length)
  const macOverlay = useMemo(() => detectMacOverlay(), [])
  const { reserveLeft, showWordmarkLeft, showWordmarkRight } =
    resolveSidebarTitlebar(macOverlay, leftButtons)
  return (
    <div className='relative z-50'>
      <Sidebar variant="floating" collapsible="offcanvas">
        <SidebarHeader className="flex px-1">
          <div className={cn("flex items-center w-full justify-between", reserveLeft && "justify-end")}>
            {showWordmarkLeft && <span className="ml-2 font-medium font-studio">Jan</span>}
            <div className="flex items-center">
              {showWordmarkRight && (
                <span className="mr-2 font-medium font-studio">Jan</span>
              )}
              <SidebarTrigger className="text-muted-foreground rounded-full hover:bg-sidebar-foreground/8! -mt-0.5 relative z-50 ml-0.5" />
            </div>
          </div>
          <NavTabs />
          {isCowork ? <NavCowork /> : <NavMain />}
        </SidebarHeader>
        <SidebarContent className="mask-b-from-95% mask-t-from-98%">
          {!isCowork && (
            <>
              <NavProjects />
              <NavChats />
            </>
          )}
        </SidebarContent>
        <SidebarRail />
      </Sidebar>
    </div>
  )
}
