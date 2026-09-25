import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { ArrowLeft, Maximize2, Minimize2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'

type CoworkSidePanelProps = {
  title: ReactNode
  leading?: ReactNode
  summary?: ReactNode
  /** Right-aligned beside the title, e.g. the branch the changes are on. */
  aside?: ReactNode
  children: ReactNode
  onClose: () => void
  /** Lets a panel identify itself to the smoke harness. */
  'data-testid'?: string
}

/**
 * How the Cowork output panel sits on the page.
 *
 * - `docked`: beside the conversation (wide windows).
 * - `drawer`: over the conversation from the right edge (below 1100px).
 * - `full`: the whole width, one view at a time (phones).
 */
export type InspectorLayout = 'docked' | 'drawer' | 'full'

type InspectorState = {
  layout: InspectorLayout
  /** Shared by every panel, so switching tabs keeps the chosen width. */
  width: number
  setWidth: (width: number) => void
  expanded: boolean
  setExpanded: (next: boolean | ((value: boolean) => boolean)) => void
}

export const PANEL_MIN_W = 240
export const PANEL_MAX_W = 640
export const PANEL_DEFAULT_W = 430
const KEY_STEP = 24

const clampWidth = (value: number) =>
  Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, value))

const InspectorContext = createContext<InspectorState | null>(null)

/**
 * Holds the output panel's layout, width and expansion for the page. Mounted
 * for as long as Cowork is, so closing and reopening a panel keeps its width.
 * Panels rendered without it (their own tests) keep their original docked,
 * self-sized behaviour.
 */
export function CoworkInspectorProvider({
  layout,
  children,
}: {
  layout: InspectorLayout
  children: ReactNode
}) {
  const [width, setWidthState] = useState(PANEL_DEFAULT_W)
  const [expanded, setExpanded] = useState(false)
  const setWidth = useCallback(
    (next: number) => setWidthState(clampWidth(next)),
    []
  )
  return (
    <InspectorContext.Provider
      value={{ layout, width, setWidth, expanded, setExpanded }}
    >
      {children}
    </InspectorContext.Provider>
  )
}

/** Pointer and keyboard resizing for the panel's left edge. */
function useResizeHandle(state: {
  width: number
  setWidth: (width: number) => void
  expanded: boolean
  setExpanded: (next: boolean) => void
}) {
  const { width, setWidth, expanded, setExpanded } = state
  const dragging = useRef(false)
  const startX = useRef(0)
  const startW = useRef(0)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      dragging.current = true
      startX.current = e.clientX
      startW.current = expanded ? PANEL_MAX_W : width
      if (expanded) setExpanded(false)
      const onMove = (ev: PointerEvent) => {
        if (!dragging.current) return
        const delta = startX.current - ev.clientX // left edge -> drag left = wider
        setWidth(startW.current + delta)
      }
      const onUp = () => {
        dragging.current = false
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [expanded, width, setWidth, setExpanded]
  )

  // The keyboard alternative to dragging: the handle is focusable and moves
  // with the arrow keys, Home and End, like any other separator.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP
    let next: number | null = null
    if (e.key === 'ArrowLeft') next = width + step
    else if (e.key === 'ArrowRight') next = width - step
    else if (e.key === 'Home') next = PANEL_MIN_W
    else if (e.key === 'End') next = PANEL_MAX_W
    if (next === null) return
    e.preventDefault()
    setExpanded(false)
    setWidth(next)
  }

  return { onPointerDown, onKeyDown }
}

function ResizeHandle({
  width,
  expanded,
  onPointerDown,
  onKeyDown,
}: {
  width: number
  expanded: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onKeyDown: (e: React.KeyboardEvent) => void
}) {
  const { t } = useTranslation()
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('common:rail.resize')}
      aria-valuemin={PANEL_MIN_W}
      aria-valuemax={PANEL_MAX_W}
      aria-valuenow={expanded ? PANEL_MAX_W : width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className="absolute inset-y-3 -left-2.5 z-10 w-2 cursor-col-resize touch-none rounded-full bg-transparent outline-none transition-colors hover:bg-border-strong/60 focus-visible:bg-ring/40"
    />
  )
}

/**
 * The output panel's frame: the rail tabs over whichever panel is open, docked
 * beside the conversation, as a drawer over it, or as the whole view.
 */
export function CoworkInspectorFrame({
  tabs,
  onBack,
  onDismiss,
  children,
}: {
  tabs: ReactNode
  /** Returns to the conversation in the `full` layout. */
  onBack?: () => void
  /** Closes the panel: the drawer's scrim and Escape. */
  onDismiss: () => void
  children: ReactNode
}) {
  const { t } = useTranslation()
  const state = useContext(InspectorContext)
  const layout = state?.layout ?? 'docked'
  const width = state?.width ?? PANEL_DEFAULT_W
  const expanded = state?.expanded ?? false
  const resize = useResizeHandle({
    width,
    setWidth: state?.setWidth ?? (() => {}),
    expanded,
    setExpanded: state?.setExpanded ?? (() => {}),
  })
  const full = layout === 'full'
  const drawer = layout === 'drawer'

  return (
    <>
      {drawer && (
        // Pointer-only convenience; the panel's own close button and Escape
        // are the keyboard routes, so the scrim stays out of the tab order.
        <button
          type="button"
          tabIndex={-1}
          aria-label={t('common:rail.closeOverlay')}
          onClick={onDismiss}
          className="absolute inset-0 z-20 cursor-default bg-scrim motion-safe:animate-in motion-safe:fade-in-0"
        />
      )}
      <Frame
        data-testid="cowork-inspector"
        data-layout={layout}
        onKeyDown={
          drawer
            ? (e) => {
                // Only for keys pressed inside the drawer itself: a menu
                // portalled out of it handles its own Escape.
                if (
                  e.key === 'Escape' &&
                  !e.defaultPrevented &&
                  e.currentTarget.contains(e.target as Node)
                ) {
                  e.stopPropagation()
                  onDismiss()
                }
              }
            : undefined
        }
        className={cn(
          'h-full min-h-0 overflow-visible motion-safe:animate-rise-in [animation-delay:60ms]',
          full ? 'w-full flex-1' : 'max-w-full shrink-0',
          drawer &&
            'absolute inset-y-3 right-1 z-30 shadow-pop motion-safe:animate-in motion-safe:slide-in-from-right-8',
          !full && expanded && 'w-[40rem]',
          layout === 'docked' && expanded && 'max-w-[60%]'
        )}
        style={full || expanded ? undefined : { width: `${width}px` }}
      >
        {!full && (
          <ResizeHandle
            width={width}
            expanded={expanded}
            onPointerDown={resize.onPointerDown}
            onKeyDown={resize.onKeyDown}
          />
        )}
        <FrameHeader
          className="pointer-coarse:min-h-12"
          icon={
            full && onBack ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="-my-1 -ml-1 pointer-coarse:size-11"
                onClick={onBack}
                aria-label={t('common:coworkLayout.back')}
                title={t('common:coworkLayout.back')}
              >
                <ArrowLeft className="size-4" aria-hidden />
              </Button>
            ) : (
              <Icon name="x-library" size={16} />
            )
          }
          title={t('common:coworkLayout.output')}
          // Expand and close belong to the output panel as a whole, so they
          // sit on its header rather than on whichever tab is open.
          actions={
            full ? undefined : (
              <span className="-my-1 flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-foreground pointer-coarse:size-11"
                  onClick={() => state?.setExpanded((value) => !value)}
                  aria-label={expanded ? t('common:collapse') : t('common:expand')}
                  title={expanded ? t('common:collapse') : t('common:expand')}
                >
                  {expanded ? (
                    <Minimize2 className="size-4" aria-hidden />
                  ) : (
                    <Maximize2 className="size-4" aria-hidden />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-foreground pointer-coarse:size-11"
                  onClick={onDismiss}
                  aria-label={t('common:close')}
                  title={t('common:close')}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </span>
            )
          }
        />
        <FrameBody className="min-h-0 overflow-hidden">
          {/* The panel switch: a muted well of tabs over the open panel. */}
          <div className="shrink-0 border-b border-dashed border-border bg-muted p-1.5">
            {tabs}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
        </FrameBody>
      </Frame>
    </>
  )
}

export function CoworkSidePanel({
  title,
  leading,
  summary,
  aside,
  children,
  onClose,
  'data-testid': testId,
}: CoworkSidePanelProps): React.ReactElement {
  const { t } = useTranslation()
  const framed = useContext(InspectorContext)
  const [localExpanded, setLocalExpanded] = useState(false)
  const [localWidth, setLocalWidth] = useState(PANEL_DEFAULT_W)
  const expanded = framed?.expanded ?? localExpanded
  const setExpanded = framed?.setExpanded ?? setLocalExpanded
  const resize = useResizeHandle({
    width: localWidth,
    setWidth: (w) => setLocalWidth(clampWidth(w)),
    expanded: localExpanded,
    setExpanded: setLocalExpanded,
  })
  const iconButton =
    'text-muted-foreground hover:text-foreground pointer-coarse:size-11'

  return (
    <aside
      data-testid={testId}
      className={cn(
        'relative flex h-full min-w-0 flex-col bg-card',
        // Inside the frame the frame owns width, border and resizing.
        framed
          ? 'w-full'
          : cn(
              'max-w-full shrink-0 rounded-xl border-[0.8px] border-input',
              expanded && 'w-[40rem] max-w-[60%]'
            )
      )}
      style={framed || expanded ? undefined : { width: `${localWidth}px` }}
    >
      {!framed && (
        <ResizeHandle
          width={localWidth}
          expanded={localExpanded}
          onPointerDown={resize.onPointerDown}
          onKeyDown={resize.onKeyDown}
        />
      )}
      {framed ? (
        // Inside the output frame the panel's own row is a quiet sub-header:
        // what is shown, its totals, and one fact on the right. Expand and
        // close are on the frame.
        <div className="flex min-h-[41px] shrink-0 items-center gap-2 border-b border-dashed border-border px-3 py-2 text-[13px] pointer-coarse:min-h-12">
          {leading}
          <span className="min-w-0 truncate font-semibold text-foreground">
            {title}
          </span>
          {summary}
          <span className="flex-1" />
          {aside}
        </div>
      ) : (
        <div className="flex min-h-[41px] shrink-0 items-center gap-2 border-b border-dashed border-border px-3 py-1.5 text-[13px] pointer-coarse:h-12">
          {leading}
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
            {title}
          </span>
          {summary}
          {aside}
          <Button
            variant="ghost"
            size="icon-xs"
            className={iconButton}
            onClick={() => setExpanded((value) => !value)}
            aria-label={expanded ? t('common:collapse') : t('common:expand')}
            title={expanded ? t('common:collapse') : t('common:expand')}
          >
            {expanded ? (
              <Minimize2 className="size-4" aria-hidden />
            ) : (
              <Maximize2 className="size-4" aria-hidden />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className={iconButton}
            onClick={onClose}
            aria-label={t('common:close')}
          >
            <X className="size-4" aria-hidden />
          </Button>
        </div>
      )}
      {/* Each panel scrolls inside itself; the page never does. */}
      <div className="min-h-0 flex-1 overflow-auto [scrollbar-width:thin]">{children}</div>
    </aside>
  )
}
