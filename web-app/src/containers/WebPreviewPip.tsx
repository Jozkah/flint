import { useCallback, useEffect, useRef, useState } from 'react'
import { clampPipRect, type PipRect } from '@/lib/webPreview'
import { useTranslation } from '@/i18n/react-i18next-compat'

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
  children,
}: {
  title: React.ReactNode
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const [rect, setRect] = useState<PipRect>(initialRect)
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  const resize = useRef<{ sx: number; sy: number; sw: number; sh: number } | null>(
    null
  )

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
        if (!drag.current) return
        setRect((r) =>
          clampPipRect(
            {
              ...r,
              x: ev.clientX - drag.current!.dx,
              y: ev.clientY - drag.current!.dy,
            },
            vp()
          )
        )
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
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      resize.current = { sx: e.clientX, sy: e.clientY, sw: rect.w, sh: rect.h }
      const move = (ev: PointerEvent) => {
        if (!resize.current) return
        const { sx, sy, sw, sh } = resize.current
        setRect((r) =>
          clampPipRect(
            { ...r, w: sw + (ev.clientX - sx), h: sh + (ev.clientY - sy) },
            vp()
          )
        )
      }
      const up = () => {
        resize.current = null
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [rect.w, rect.h]
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
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
      <div
        data-testid="pip-resize"
        onPointerDown={onResizeDown}
        aria-label={t('common:webPreview.pipResize')}
        className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize"
      />
    </div>
  )
}
