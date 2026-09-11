import { useLeftPanel } from '@/hooks/useLeftPanel'
import { cn } from '@/lib/utils'
import {
  IconLayoutSidebar,
} from '@tabler/icons-react'
import { ReactNode, memo, useMemo } from 'react'
import { Button } from "@/components/ui/button"
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
const HeaderPage = memo(function HeaderPage({ children }: HeaderPageProps) {
  const { open, setLeftPanel } = useLeftPanel()
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
      className={cn(
        'h-15 flex items-center shrink-0',
        drags && 'cursor-grab active:cursor-grabbing',
        inset.macLeftPad ? 'pl-24' : ' pl-4',
        children === undefined && 'border-none'
      )}
      style={{
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
          'flex items-center w-full gap-1',
        )}
      >
        {!open && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              className='rounded-full relative z-50'
              onClick={() => setLeftPanel(!open)}
              aria-label="Toggle sidebar"
            >
              <IconLayoutSidebar
                className="text-muted-foreground relative size-4.5"
              />
            </Button>
          </>
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
