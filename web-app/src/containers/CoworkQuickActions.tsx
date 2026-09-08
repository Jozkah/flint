import { Search, Settings } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { PlatformMetaKey } from '@/containers/PlatformMetaKey'
import { PlatformShortcuts, ShortcutAction } from '@/lib/shortcuts'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * Search and Settings, reachable from Cowork as they are from everywhere else.
 *
 * Both are the shared surfaces: Search opens the same dialog the sidebar opens
 * (it is mounted once, in `NavMain`, and driven by the same store), and
 * Settings is the ordinary Settings route. Nothing about either is
 * reimplemented here, so the shortcuts and behaviour stay in one place.
 *
 * Leaving Cowork unmounts the route, so the session's rail and scroll position
 * are kept in `useCoworkView` and the composer draft in `usePrompt` -- coming
 * back returns to the session as it was.
 */
export function CoworkQuickActions() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const openSearch = useSearchDialog((s) => s.setOpen)

  const button =
    'flex size-7 items-center justify-center rounded-md text-main-view-fg/60 hover:bg-main-view-fg/5 hover:text-main-view-fg focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'

  return (
    // `no-drag` matters on macOS: the header is a window drag region, and a
    // control inside one swallows its own clicks without this.
    <div className="no-drag flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('common:search')}
            data-testid="cowork-search"
            className={button}
            onClick={() => openSearch(true)}
          >
            <Search size={15} />
          </button>
        </TooltipTrigger>
        <TooltipContent className="flex items-center gap-1.5">
          {t('common:search')}
          <KbdGroup className="scale-90 gap-0">
            <Kbd className="bg-transparent size-3">
              <PlatformMetaKey />
            </Kbd>
            <Kbd className="bg-transparent size-3 uppercase">
              {PlatformShortcuts[ShortcutAction.SEARCH].key}
            </Kbd>
          </KbdGroup>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('common:settings')}
            data-testid="cowork-settings"
            className={button}
            onClick={() => navigate({ to: route.settings.index })}
          >
            <Settings size={15} />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('common:settings')}</TooltipContent>
      </Tooltip>
    </div>
  )
}

export default CoworkQuickActions
