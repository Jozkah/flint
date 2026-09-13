import { Link } from '@tanstack/react-router'
import { Activity, FileText, Server } from 'lucide-react'
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useLocation } from '@tanstack/react-router'

/**
 * The System area's contextual navigation: the live monitor and the two logs.
 * Each is an existing route; this list only puts them one click away instead
 * of behind the command palette.
 */
export function NavSystem() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const items = [
    { to: route.systemMonitor, label: t('common:systemNav.monitor'), icon: Activity },
    { to: route.appLogs, label: t('common:systemNav.appLogs'), icon: FileText },
    { to: route.localApiServerlogs, label: t('common:systemNav.serverLogs'), icon: Server },
  ]
  return (
    <SidebarGroup className="px-0">
      <SidebarGroupLabel>{t('common:systemNav.label')}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const Icon = item.icon
          const active = pathname === item.to
          return (
            <SidebarMenuItem key={item.to}>
              <SidebarMenuButton asChild isActive={active}>
                <Link to={item.to} aria-current={active ? 'page' : undefined}>
                  <Icon aria-hidden />
                  <span>{item.label}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}
