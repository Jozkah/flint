import { useLeftPanel } from '@/hooks/useLeftPanel'
import { cn } from '@/lib/utils'
import {
  IconLayoutSidebar,
} from '@tabler/icons-react'
import { ReactNode, memo, useMemo } from 'react'
import { Button } from "@/components/ui/button"
import { useTitlebarLayout } from '@/stores/titlebar-layout-store'
import { detectMacOverlay, resolveHeaderInset } from '@/lib/titlebar'

type HeaderPageProps = {
  children?: ReactNode
}
const HeaderPage = memo(function HeaderPage({ children }: HeaderPageProps) {
  const { open, setLeftPanel } = useLeftPanel()
  // Collapsed, this header owns the top-left strip and must clear the window
  // controls. The reservation is resolved centrally (see lib/titlebar) so the
  // sidebar and this header can never disagree, and so the macOS traffic-light
  // indent survives a web bundle built without TAURI_ENV_PLATFORM.
  const leftButtons = useTitlebarLayout((s) => s.layout.left.length)
  const rightButtons = useTitlebarLayout((s) => s.layout.right.length)
  const macOverlay = useMemo(() => detectMacOverlay(), [])
  const inset = resolveHeaderInset({
    macOverlay,
    sidebarOpen: open,
    leftButtonCount: leftButtons,
    rightButtonCount: rightButtons,
  })

  return (
    <div
      // The window drags from the header's empty space.
      //
      // `deep` rather than a bare attribute: a bare one drags only when the
      // pressed element *is* this div, and every page fills the bar with its
      // own wrapper (PageHeaderRow, or a plain `w-full` div), so the press
      // always landed on a child instead. That left the outer padding as the
      // only draggable strip -- the window moved only near the edge.
      //
      // With `deep` the whole subtree drags, except that Tauri stops at the
      // first clickable element it meets walking up from the press: buttons,
      // links, inputs, and anything with an interactive `role` or a real
      // `tabindex` keep their own clicks. Nothing below may re-declare a bare
      // drag region, since that would answer "is this the pressed element?"
      // with no and block the drag before the walk ever reaches this `deep`.
      data-tauri-drag-region="deep"
      className={cn(
        'h-15 flex items-center shrink-0 cursor-grab active:cursor-grabbing',
        inset.macLeftPad ? 'pl-24' : ' pl-4',
        children === undefined && 'border-none'
      )}
      style={{
        ...(inset.leftPx ? { paddingLeft: inset.leftPx } : {}),
        ...(inset.rightPx ? { paddingRight: inset.rightPx } : {}),
      }}
    >
      <div
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
