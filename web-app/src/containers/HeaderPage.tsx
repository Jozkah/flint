import { useLeftPanel } from '@/hooks/useLeftPanel'
import { cn } from '@/lib/utils'
import { Menu, PanelLeft } from 'lucide-react'
import { ReactNode, memo, useMemo } from 'react'
import { Button } from "@/components/ui/button"
import { useOptionalSidebar } from '@/components/ui/sidebar'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useTitlebarLayout } from '@/stores/titlebar-layout-store'
import {
  appDrawnButtonCounts,
  detectMacOverlay,
  detectWindowChrome,
  headerDragsWindow,
  resolveHeaderInset,
} from '@/lib/titlebar'

type HeaderPageProps = {
  children?: ReactNode
}

/**
 * The 52px context bar at the top of every page: the page's identity and its
 * primary controls. On phones it also carries the button that opens the
 * navigation sheet, since the rail and sidebar are not on screen.
 */
const HeaderPage = memo(function HeaderPage({ children }: HeaderPageProps) {
  const { t } = useTranslation()
  const { open, setLeftPanel } = useLeftPanel()
  const sidebar = useOptionalSidebar()
  // Collapsed, this header owns the top-left strip and must clear the window
  // controls. The reservation is resolved centrally (see lib/titlebar) so the
  // sidebar and this header can never disagree, and so the macOS traffic-light
  // indent survives a web bundle built without TAURI_ENV_PLATFORM.
  const layoutLeft = useTitlebarLayout((s) => s.layout.left.length)
  const layoutRight = useTitlebarLayout((s) => s.layout.right.length)
  const macOverlay = useMemo(() => detectMacOverlay(), [])
  const chrome = useMemo(() => detectWindowChrome({ macOverlay }), [macOverlay])
  const buttons = appDrawnButtonCounts(chrome, {
    left: layoutLeft,
    right: layoutRight,
  })
  const inset = resolveHeaderInset({
    macOverlay,
    sidebarOpen: open,
    leftButtonCount: buttons.left,
    rightButtonCount: buttons.right,
  })
  // With a native title bar the operating system owns dragging; a drag region
  // down here would only turn presses on the page into window moves.
  const drags = headerDragsWindow(chrome)
  const dragRegion = drags ? { 'data-tauri-drag-region': true } : {}

  return (
    <div
      // Where the app draws its own chrome, the window drags from the header's
      // empty space. Tauri drags only when the pressed element *is* the drag
      // region, so the controls inside this bar keep working.
      {...dragRegion}
      data-testid="context-bar"
      className={cn(
        'flex items-center shrink-0 border-b border-border bg-card pr-3',
        drags && 'cursor-grab active:cursor-grabbing',
        inset.macLeftPad ? 'pl-24' : 'pl-3 md:pl-6',
        children === undefined && 'border-none'
      )}
      style={{
        // The shell's context bar height (52px), from one token.
        height: 'var(--ctx-h)',
        minHeight: 'var(--ctx-h)',
        ...(inset.leftPx ? { paddingLeft: inset.leftPx } : {}),
        ...(inset.rightPx ? { paddingRight: inset.rightPx } : {}),
      }}
    >
      <div
        // Also a drag region. Tauri drags only when the pressed element *is*
        // one, and this row is `w-full`, so it covered the header end to end
        // and swallowed every press the outer div was supposed to receive.
        // Buttons inside remain unaffected: they are their own elements and do
        // not carry the attribute.
        {...dragRegion}
        className={cn(
          'flex items-center w-full min-w-0 gap-1',
        )}
      >
        {sidebar && (
          <Button
            variant="ghost"
            size="icon"
            className="relative z-50 shrink-0 md:hidden pointer-coarse:size-11"
            onClick={() => sidebar.setOpenMobile(true)}
            aria-label={t('common:shell.openNavigation')}
            data-testid="open-navigation"
          >
            <Menu className="size-5 text-foreground" />
          </Button>
        )}
        {!open && (
          <Button
            variant="ghost"
            size="icon-sm"
            className='relative z-50 hidden md:inline-flex'
            onClick={() => setLeftPanel(!open)}
            aria-label="Toggle sidebar"
          >
            <PanelLeft className="text-muted-foreground relative size-4.5" />
          </Button>
        )}
        <div
          // The stretch that fills the rest of the bar. Whatever a page puts
          // in `children` keeps its own hit area; the empty remainder drags.
          {...dragRegion}
          className={cn(
            'flex-1 min-w-0'
          )}
        >
          {children}
        </div>
      </div>
    </div>
  )
})

export default HeaderPage
