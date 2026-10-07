import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Download, X, ZoomIn, ZoomOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'

export type ViewerImage = { url: string; name?: string }

const MIN_ZOOM = 1
const MAX_ZOOM = 6

/** A file name for saving an image: its own, else one made from its type. */
export function downloadNameOf(image: ViewerImage, index: number): string {
  const own = image.name?.trim()
  if (own && /\.\w{2,5}$/.test(own)) return own
  const type = /^data:image\/([\w+.-]+)/.exec(image.url)?.[1] ?? 'png'
  const ext = type === 'jpeg' ? 'jpg' : type.replace(/\+.*$/, '')
  return `${own || `image-${index + 1}`}.${ext}`
}

/**
 * Full-screen look at an attached image, for as long as wanted.
 *
 * Opens on the image that was clicked and steps through the others of the same
 * message (arrow keys or the side buttons). Zoom with the buttons, `+`/`-`/`0`,
 * or the wheel; drag to move a zoomed image. `Esc` or a click outside closes it.
 * The image can be saved with its own name.
 */
export function ImageViewer({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  images: readonly ViewerImage[]
  index: number
  onIndexChange: (index: number) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const image = images[index]

  const reset = useCallback(() => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }, [])
  const zoomBy = useCallback((factor: number) => {
    setZoom((z) => {
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor))
      if (next === MIN_ZOOM) setOffset({ x: 0, y: 0 })
      return next
    })
  }, [])
  const step = useCallback(
    (dir: -1 | 1) => {
      if (images.length < 2) return
      reset()
      onIndexChange((index + dir + images.length) % images.length)
    },
    [images.length, index, onIndexChange, reset]
  )

  useEffect(() => {
    // Hand focus back to whatever opened the viewer once it closes.
    const opener = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => {
      if (opener && opener.isConnected) opener.focus()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        // Keep Tab inside the dialog: it is modal.
        const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled])'
        )
        if (!nodes || nodes.length === 0) return
        const first = nodes[0]
        const last = nodes[nodes.length - 1]
        const active = document.activeElement
        if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
          last.focus()
          e.preventDefault()
        } else if (!e.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
          first.focus()
          e.preventDefault()
        }
        return
      }
      // Shortcuts must not steal keys typed into a field behind the viewer.
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      ) {
        return
      }
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
      else if (e.key === '+' || e.key === '=') zoomBy(1.25)
      else if (e.key === '-') zoomBy(0.8)
      else if (e.key === '0') reset()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, step, zoomBy, reset])

  if (!image) return null

  const toolButton =
    'grid size-9 place-items-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-white pointer-coarse:size-11'

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={
        image.name ??
        t('common:imageViewer.imageNOfM', { n: index + 1, total: images.length })
      }
      data-testid="image-viewer"
      className="fixed inset-0 z-[200] flex flex-col bg-black/85 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="min-w-0">
          <div className="truncate font-medium">{image.name ?? t('common:imageViewer.imageN', { n: index + 1 })}</div>
          {images.length > 1 && (
            <div className="text-xs text-white/70">
              {t('common:imageViewer.nOfM', { n: index + 1, total: images.length })}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className={toolButton} onClick={() => zoomBy(0.8)} aria-label={t('common:imageViewer.zoomOut')} disabled={zoom <= MIN_ZOOM}>
            <ZoomOut className="size-4" />
          </button>
          <span className="w-10 text-center text-xs tabular-nums text-white/80" data-testid="viewer-zoom">
            {Math.round(zoom * 100)}%
          </span>
          <button type="button" className={toolButton} onClick={() => zoomBy(1.25)} aria-label={t('common:imageViewer.zoomIn')} disabled={zoom >= MAX_ZOOM}>
            <ZoomIn className="size-4" />
          </button>
          <a
            className={toolButton}
            href={image.url}
            download={downloadNameOf(image, index)}
            aria-label={t('common:imageViewer.save')}
            title={t('common:imageViewer.save')}
          >
            <Download className="size-4" />
          </a>
          <button ref={closeRef} type="button" className={toolButton} onClick={onClose} aria-label={t('common:imageViewer.close')}>
            <X className="size-4" />
          </button>
        </div>
      </div>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-4 pb-6"
        onWheel={(e) => zoomBy(e.deltaY < 0 ? 1.15 : 0.87)}
      >
        {images.length > 1 && (
          <button
            type="button"
            className={cn(toolButton, 'absolute left-4 z-10')}
            onClick={(e) => {
              e.stopPropagation()
              step(-1)
            }}
            aria-label={t('common:imageViewer.previous')}
          >
            <ChevronLeft className="size-5" />
          </button>
        )}
        <img
          src={image.url}
          alt={image.name ?? t('common:imageViewer.imageN', { n: index + 1 })}
          draggable={false}
          className={cn(
            'max-h-full max-w-full select-none rounded-lg object-contain shadow-2xl',
            zoom > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'
          )}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
          onClick={(e) => {
            e.stopPropagation()
            if (zoom === 1) zoomBy(2)
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            reset()
          }}
          onPointerDown={(e) => {
            if (zoom <= 1) return
            drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (!d) return
            setOffset({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y })
          }}
          onPointerUp={() => {
            drag.current = null
          }}
        />
        {images.length > 1 && (
          <button
            type="button"
            className={cn(toolButton, 'absolute right-4 z-10')}
            onClick={(e) => {
              e.stopPropagation()
              step(1)
            }}
            aria-label={t('common:imageViewer.next')}
          >
            <ChevronRight className="size-5" />
          </button>
        )}
      </div>
    </div>,
    document.body
  )
}
