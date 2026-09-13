import { Link, useLocation } from '@tanstack/react-router'
import {
  Activity,
  BookOpen,
  Box,
  Folder,
  Search,
  Settings,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { RAIL_ITEMS, areaForPath, type RailArea, type RailItem } from '@/lib/shellNavigation'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useCoworkRun } from '@/hooks/useCoworkRun'

const ICONS: Record<RailArea, LucideIcon> = {
  workspace: Folder,
  library: BookOpen,
  models: Box,
  tools: Wrench,
  search: Search,
  system: Activity,
  settings: Settings,
}

/** Test hooks the real-app harness already relies on. */
const LEGACY_TEST_IDS: Partial<Record<RailArea, string>> = {
  settings: 'cowork-settings',
}

type AppRailProps = {
  /** Called after an item is chosen, so the phone sheet can close. */
  onNavigate?: () => void
  className?: string
}

/**
 * The 80px graphite rail: one wordmark, a separate activity indicator, the
 * four work areas on top and Search, System and Settings at the bottom.
 */
export function AppRail({ onNavigate, className }: AppRailProps) {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const current = areaForPath(pathname)
  // Real state: a Cowork run is in progress in some session.
  const working = useCoworkRun((s) => Object.keys(s.runs ?? {}).length > 0)

  const renderItem = (item: RailItem) => {
    const Icon = ICONS[item.id]
    const label = t(item.labelKey)
    const isCurrent = item.id === current
    const itemClass = cn(
      'relative flex w-full flex-col items-center justify-center gap-1.5 text-[12px] font-medium leading-none outline-none',
      'h-[72px] shrink-0 text-rail-muted hover:bg-rail-hover hover:text-rail-foreground',
      'focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-brand-rail',
      '[@media(max-height:620px)]:h-14 [@media(max-height:620px)]:gap-1',
      isCurrent &&
        'bg-rail-active text-rail-foreground before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-brand-rail'
    )
    const content = (
      <>
        <Icon className="size-[22px]!" strokeWidth={1.5} aria-hidden />
        <span>{label}</span>
      </>
    )
    const testId = LEGACY_TEST_IDS[item.id] ?? `rail-${item.id}`
    if (!item.to) {
      return (
        <button
          key={item.id}
          type="button"
          data-testid={testId}
          className={itemClass}
          onClick={() => {
            useSearchDialog.getState().setOpen(true)
            onNavigate?.()
          }}
        >
          {content}
        </button>
      )
    }
    return (
      <Link
        key={item.id}
        to={item.to}
        data-testid={testId}
        aria-current={isCurrent ? 'page' : undefined}
        className={itemClass}
        onClick={() => onNavigate?.()}
      >
        {content}
      </Link>
    )
  }

  return (
    <nav
      aria-label={t('common:appRail.label')}
      data-testid="app-rail"
      className={cn(
        'flex h-full w-(--rail-w) shrink-0 flex-col overflow-y-auto overflow-x-hidden bg-rail text-rail-foreground [scrollbar-width:none]',
        className
      )}
    >
      <Link
        to="/"
        aria-label={t('common:appRail.home')}
        onClick={() => onNavigate?.()}
        className="relative flex h-[72px] shrink-0 items-center justify-center font-display text-[26px] leading-none tracking-tight text-rail-foreground outline-none focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-brand-rail [@media(max-height:620px)]:h-12"
      >
        JAN
        {working && (
          <span
            role="status"
            aria-label={t('common:appRail.working')}
            title={t('common:appRail.working')}
            className="absolute right-4 top-6 size-1.5 rounded-full bg-brand-rail motion-safe:animate-pulse"
          />
        )}
      </Link>
      <div className="flex flex-col">{RAIL_ITEMS.filter((i) => i.group === 'top').map(renderItem)}</div>
      <div className="min-h-2 flex-1" />
      <div className="flex flex-col">
        {RAIL_ITEMS.filter((i) => i.group === 'bottom').map(renderItem)}
      </div>
    </nav>
  )
}
