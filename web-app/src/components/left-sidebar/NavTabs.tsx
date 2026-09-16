import { Link, useLocation } from '@tanstack/react-router'
import { useRef } from 'react'
import { Handshake, MessageSquare } from 'lucide-react'
import { route, isCoworkRoute } from '@/constants/routes'
import { cn } from '@/lib/utils'
import { useThreads } from '@/hooks/useThreads'
import { useTranslation } from '@/i18n/react-i18next-compat'

type TabItem = {
  label: string
  to: string
  icon: typeof MessageSquare
  isActive: boolean
}

/**
 * Chat and Cowork are different ways of working in the same workspace. The
 * switch keeps them distinct: Home is ordinary chat, Cowork is agent work.
 *
 * The Home tab returns to the chat surface last viewed, not the base route, so
 * switching to Cowork and back does not throw away the open thread. The remembered
 * path is kept only while its thread still exists; a deleted one falls back to a
 * blank chat. `surfacePath` is injectable for tests; it defaults to the router.
 */
export function NavTabs({ surfacePath }: { surfacePath?: string } = {}) {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const currentPath = surfacePath ?? pathname

  const isCowork = isCoworkRoute(currentPath)
  // Home owns the chat surfaces (new chat, threads, projects); Cowork owns /cowork.
  const isHome =
    currentPath === route.home ||
    currentPath.startsWith('/threads') ||
    currentPath.startsWith('/project')

  // Remembered across route changes: this component stays mounted in the sidebar.
  const lastHomePath = useRef<string>(route.home)
  if (isHome) lastHomePath.current = currentPath
  const homePath = isHome ? currentPath : lastHomePath.current
  const threadId = homePath.startsWith('/threads/')
    ? homePath.slice('/threads/'.length)
    : undefined
  const threadExists = useThreads(
    (s) => !threadId || Boolean(s.threads[threadId])
  )

  const tabs: TabItem[] = [
    {
      label: t('common:home'),
      to: threadExists ? homePath : route.home,
      icon: MessageSquare,
      isActive: isHome,
    },
    { label: t('common:cowork'), to: route.cowork, icon: Handshake, isActive: isCowork },
  ]

  return (
    <div
      role="group"
      className="grid h-8 grid-cols-2 gap-0.5 rounded-md bg-sunken p-0.5 pointer-coarse:h-12"
    >
      {tabs.map((tab) => {
        const Icon = tab.icon
        return (
          <Link
            key={tab.label}
            to={tab.to}
            aria-current={tab.isActive ? 'page' : undefined}
            className={cn(
              // Selected is a raised neutral segment, not the accent: the
              // accent is kept for the current row and the primary action.
              'flex min-w-0 items-center justify-center gap-1.5 rounded-sm px-2 text-[13px] font-medium transition-colors outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring',
              tab.isActive
                ? 'bg-card text-foreground ring-1 ring-border'
                : 'text-ink-2 hover:text-foreground'
            )}
          >
            <Icon className="size-4" aria-hidden />
            <span>{tab.label}</span>
          </Link>
        )
      })}
    </div>
  )
}
