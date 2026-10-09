import { X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { clampPipRect, type PipRect } from '@/lib/webPreview'
import { useTranslation } from '@/i18n/react-i18next-compat'

type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const MIN_W = 280
const MIN_H = 200
// Invisible hit areas on every edge and corner, like a normal window frame.
const HANDLES: { edge: ResizeEdge; cls: string }[] = [
  { edge: 'n', cls: 'top-0 left-3 right-3 h-1.5 cursor-n-resize' },
  { edge: 's', cls: 'bottom-0 left-3 right-3 h-1.5 cursor-s-resize' },
  { edge: 'w', cls: 'left-0 top-3 bottom-3 w-1.5 cursor-w-resize' },
  { edge: 'e', cls: 'right-0 top-3 bottom-3 w-1.5 cursor-e-resize' },
  { edge: 'nw', cls: 'top-0 left-0 size-3 cursor-nw-resize' },
  { edge: 'ne', cls: 'top-0 right-0 size-3 cursor-ne-resize' },
  { edge: 'sw', cls: 'bottom-0 left-0 size-3 cursor-sw-resize' },
  { edge: 'se', cls: 'bottom-0 right-0 size-4 cursor-se-resize' },
]

const vp = () => ({ w: window.innerWidth, h: window.innerHeight })

const initialRect = (): PipRect => {
  const v = vp()
  const w = Math.min(480, v.w - 32)
  const h = Math.min(360, v.h - 32)
  return { x: v.w - w - 16, y: v.h - h - 16, w, h }
}

/**
 * A floating, draggable, resizable container for the web preview. Position and
 * size are held locally for the session and clamped to the viewport on every
 * move and on window resize.
 */
export function WebPreviewPip({
  title,
  onClose,
  children,
}: {
  title: React.ReactNode
  onClose: () => void
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const [rect, setRect] = useState<PipRect>(initialRect)
  const drag = useRef<{ dx: number; dy: number } | null>(null)

  useEffect(() => {
    const onResize = () => setRect((r) => clampPipRect(r, vp()))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const onDragDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      drag.current = { dx: e.clientX - rect.x, dy: e.clientY - rect.y }
      const move = (ev: PointerEvent) => {
        // Read the offset now: the updater runs later, after a pointerup may
        // already have cleared the ref, and reading it then crashed the app.
        const d = drag.current
        if (!d) return
        const x = ev.clientX - d.dx
        const y = ev.clientY - d.dy
        setRect((r) => clampPipRect({ ...r, x, y }, vp()))
      }
      const up = () => {
        drag.current = null
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [rect.x, rect.y]
  )

  const onResizeDown = useCallback(
    (edge: ResizeEdge) => (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const start = { sx: e.clientX, sy: e.clientY, ...rect }
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - start.sx
        const dy = ev.clientY - start.sy
        const v = vp()
        let { x, y, w, h } = start
        if (edge.includes('e')) w = start.w + dx
        if (edge.includes('s')) h = start.h + dy
        if (edge.includes('w')) {
          w = start.w - dx
          x = start.x + start.w - Math.max(MIN_W, Math.min(w, v.w))
        }
        if (edge.includes('n')) {
          h = start.h - dy
          y = start.y + start.h - Math.max(MIN_H, Math.min(h, v.h))
        }
        setRect(clampPipRect({ x, y, w, h }, v, MIN_W, MIN_H))
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [rect]
  )

  return (
    <div
      data-testid="web-preview-pip"
      className="fixed z-[60] flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-pop"
      style={{
        position: 'fixed',
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
      }}
    >
      <div
        data-testid="pip-drag"
        onPointerDown={onDragDown}
        aria-label={t('common:webPreview.pipDrag')}
        className="flex h-9 shrink-0 cursor-move items-center gap-2 border-b border-border px-2 text-sm font-medium"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
          {title}
        </span>
        <button
          type="button"
          data-testid="pip-close"
          aria-label={t('common:webPreview.close')}
          title={t('common:webPreview.close')}
          // The bar starts a drag on pointerdown; keep the click for the button.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
      {HANDLES.map(({ edge, cls }) => (
        <div
          key={edge}
          data-testid={edge === 'se' ? 'pip-resize' : `pip-resize-${edge}`}
          onPointerDown={onResizeDown(edge)}
          aria-label={t('common:webPreview.pipResize')}
          className={`absolute z-10 ${cls}`}
        />
      ))}
    </div>
  )
}
