import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Brush, Eraser, FlipHorizontal2, RectangleHorizontal, Trash2, Undo2 } from 'lucide-react'
import { Slider } from '@/components/ui/slider'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import {
  containRect,
  hasPaint,
  paintedBounds,
  toPictureRect,
  invertOverlay,
  maskSize,
  overlayToMask,
  rectBetween,
  toMaskPoint,
  type Rect,
  type Size,
} from '@/lib/studio/mask'

export type SelectionTool = 'brush' | 'eraser' | 'rect'

export type SelectionEditorHandle = {
  /** The selection as a PNG data URL (white is repainted), or null when nothing is selected. */
  exportMask: () => string | null
  /** The box around what is painted, in the picture's own pixels, or null when nothing is. */
  selectionRect: () => Rect | null
}

/** What is painted, drawn opaque; the canvas itself is shown half see-through. */
const PAINT: readonly [number, number, number, number] = [139, 92, 246, 255]
const PAINT_CSS = `rgb(${PAINT[0]} ${PAINT[1]} ${PAINT[2]})`
const UNDO_LIMIT = 12
const MIN_BRUSH = 4
const MAX_BRUSH = 160

type Point = { x: number; y: number }

/**
 * A picture with a selection painted over it: a brush, an eraser and a
 * rectangle, with undo, invert and clear. What is painted is what an edit
 * repaints; the rest of the picture is kept.
 *
 * The tools render into `toolbarHost` when given, so they never cover the
 * part of the picture being painted.
 */
export const SelectionEditor = forwardRef<
  SelectionEditorHandle,
  {
    src: string
    alt: string
    onPaintedChange: (painted: boolean) => void
    onDone: () => void
    /** An edit is running: keep the selection but take no input. */
    inert?: boolean
    toolbarHost?: HTMLElement | null
  }
>(function SelectionEditor({ src, alt, onPaintedChange, onDone, inert = false, toolbarHost }, ref) {
  const { t } = useTranslation()
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [natural, setNatural] = useState<Size | null>(null)
  const [box, setBox] = useState<Size>({ width: 0, height: 0 })
  const [tool, setTool] = useState<SelectionTool>('brush')
  const [brush, setBrush] = useState(36)
  const [cursor, setCursor] = useState<Point | null>(null)
  const [dragRect, setDragRectState] = useState<Rect | null>(null)
  // Read on pointer-up, which can come before React has drawn the last move.
  const dragRectRef = useRef<Rect | null>(null)
  const setDragRect = (rect: Rect | null) => {
    dragRectRef.current = rect
    setDragRectState(rect)
  }
  const [undoCount, setUndoCount] = useState(0)
  const undo = useRef<ImageData[]>([])
  const stroke = useRef<{ id: number; last: Point; start: Point; before: ImageData | null } | null>(null)
  const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

  const mask = natural ? maskSize(natural) : null
  const shown = natural ? containRect(box, natural) : null

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    // Nothing is painted yet, whatever the page thought before; and the keys
    // work at once, without clicking the picture first.
    onPaintedChange(false)
    el.focus({ preventScroll: true })
    const observer = new ResizeObserver(([entry]) => {
      setBox({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
    // Once per picture: the parent remounts this for a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const context = () => canvasRef.current?.getContext('2d', { willReadFrequently: true }) ?? null
  const read = () => {
    const ctx = context()
    const canvas = canvasRef.current
    return ctx && canvas ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null
  }

  const report = () => {
    const data = read()
    if (data) onPaintedChange(hasPaint(data.data))
  }

  const remember = (before: ImageData | null) => {
    if (!before) return
    undo.current = [...undo.current, before].slice(-UNDO_LIMIT)
    setUndoCount(undo.current.length)
  }

  const scale = mask && shown && shown.width > 0 ? mask.width / shown.width : 1

  const prepare = (ctx: CanvasRenderingContext2D) => {
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over'
    ctx.strokeStyle = PAINT_CSS
    ctx.fillStyle = PAINT_CSS
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = brush * scale
  }

  const paintDot = (p: Point) => {
    const ctx = context()
    if (!ctx) return
    prepare(ctx)
    ctx.beginPath()
    ctx.arc(p.x, p.y, (brush * scale) / 2, 0, Math.PI * 2)
    ctx.fill()
  }

  const paintLine = (from: Point, to: Point) => {
    const ctx = context()
    if (!ctx) return
    prepare(ctx)
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // One finger, one stroke: a second touch must not draw a line across.
    if (inert || e.button !== 0 || !e.isPrimary || stroke.current || !mask) return
    const p = toMaskPoint({ x: e.clientX, y: e.clientY }, e.currentTarget.getBoundingClientRect(), mask)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // A pointer the browser does not count as active (some pens, synthetic
      // input) cannot be captured; the stroke still works inside the picture.
    }
    stroke.current = { id: e.pointerId, last: p, start: p, before: read() }
    if (tool === 'rect') setDragRect(rectBetween(p, p))
    else paintDot(p)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setCursor(e.pointerType === 'mouse' ? { x: e.clientX - r.left, y: e.clientY - r.top } : null)
    const current = stroke.current
    if (!current || current.id !== e.pointerId || !mask) return
    // Some engines hand back an empty list rather than the event itself.
    const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? []
    const events = coalesced.length ? coalesced : [e.nativeEvent]
    for (const ev of events) {
      const p = toMaskPoint({ x: ev.clientX, y: ev.clientY }, r, mask)
      if (tool === 'rect') setDragRect(rectBetween(current.start, p))
      else paintLine(current.last, p)
      current.last = p
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const current = stroke.current
    if (!current || current.id !== e.pointerId) return
    stroke.current = null
    if (tool === 'rect') {
      const rect = dragRectRef.current
      setDragRect(null)
      // A click without a drag selects nothing, and leaves nothing to undo.
      if (!rect || rect.width < 1 || rect.height < 1) return
      const ctx = context()
      if (ctx) {
        ctx.globalCompositeOperation = 'source-over'
        ctx.fillStyle = PAINT_CSS
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
      }
    }
    remember(current.before)
    report()
  }

  const change = (apply: (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => void) => {
    const ctx = context()
    const canvas = canvasRef.current
    if (inert || !ctx || !canvas) return
    remember(read())
    apply(ctx, canvas)
    report()
  }

  const clear = () => change((ctx, canvas) => ctx.clearRect(0, 0, canvas.width, canvas.height))

  const invert = () =>
    change((ctx, canvas) => {
      const current = ctx.getImageData(0, 0, canvas.width, canvas.height)
      ctx.putImageData(new ImageData(invertOverlay(current.data, PAINT), canvas.width, canvas.height), 0, 0)
    })

  const undoLast = () => {
    const ctx = context()
    const last = undo.current.at(-1)
    if (inert || !ctx || !last) return
    undo.current = undo.current.slice(0, -1)
    setUndoCount(undo.current.length)
    ctx.putImageData(last, 0, 0)
    report()
  }

  useImperativeHandle(ref, () => ({
    exportMask: () => {
      const canvas = canvasRef.current
      const data = read()
      if (!canvas || !data) return null
      const { pixels, painted } = overlayToMask(data.data)
      if (!painted) return null
      const out = document.createElement('canvas')
      out.width = canvas.width
      out.height = canvas.height
      out.getContext('2d')?.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0)
      return out.toDataURL('image/png')
    },
    selectionRect: () => {
      const data = read()
      if (!data || !mask || !natural) return null
      const bounds = paintedBounds(data.data, data.width, data.height)
      return bounds ? toPictureRect(bounds, mask, natural) : null
    },
  }))

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (inert) return
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      undoLast()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onDone()
    } else if (e.key === '[') {
      setBrush((b) => Math.max(MIN_BRUSH, b - 8))
    } else if (e.key === ']') {
      setBrush((b) => Math.min(MAX_BRUSH, b + 8))
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const next = ({ b: 'brush', e: 'eraser', r: 'rect' } as const)[e.key.toLowerCase() as 'b' | 'e' | 'r']
      if (next) setTool(next)
    }
  }

  const toolButton =
    'grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-40 aria-pressed:bg-accent aria-pressed:text-foreground pointer-coarse:size-10'
  const tools: { id: SelectionTool; icon: typeof Brush; label: string }[] = [
    { id: 'brush', icon: Brush, label: t('studio:select.brush') },
    { id: 'eraser', icon: Eraser, label: t('studio:select.eraser') },
    { id: 'rect', icon: RectangleHorizontal, label: t('studio:select.rect') },
  ]
  const undoLabel = t('studio:select.undo', { keys: mac ? '⌘Z' : 'Ctrl+Z' })

  const toolbar = (
    <div
      role="toolbar"
      aria-label={t('studio:select.tools')}
      // Toasts move aside instead of covering the tools.
      data-toast-avoid
      className="flex flex-wrap items-center gap-1 rounded-xl border-[0.8px] border-border bg-card p-1.5 motion-safe:animate-rise-in"
    >
      {tools.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          type="button"
          aria-pressed={tool === id}
          disabled={inert}
          title={label}
          aria-label={label}
          onClick={() => setTool(id)}
          className={toolButton}
        >
          <Icon className="size-4" aria-hidden />
        </button>
      ))}
      {tool !== 'rect' && (
        <div className="mx-1 flex w-28 items-center">
          <Slider
            aria-label={t('studio:select.size')}
            min={MIN_BRUSH}
            max={MAX_BRUSH}
            step={2}
            value={[brush]}
            disabled={inert}
            onValueChange={([v]) => setBrush(v)}
          />
        </div>
      )}
      <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />
      <button type="button" title={undoLabel} aria-label={undoLabel} disabled={inert || undoCount === 0} onClick={undoLast} className={toolButton}>
        <Undo2 className="size-4" aria-hidden />
      </button>
      <button type="button" title={t('studio:select.invert')} aria-label={t('studio:select.invert')} disabled={inert} onClick={invert} className={toolButton}>
        <FlipHorizontal2 className="size-4" aria-hidden />
      </button>
      <button type="button" title={t('studio:select.clear')} aria-label={t('studio:select.clear')} disabled={inert} onClick={clear} className={toolButton}>
        <Trash2 className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        onClick={onDone}
        disabled={inert}
        className="ml-auto h-8 rounded-lg px-3 text-xs font-medium text-secondary-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-hidden disabled:opacity-40"
      >
        {t('studio:select.exit')}
      </button>
    </div>
  )

  return (
    <>
      <div
        ref={boxRef}
        role="application"
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-label={t('studio:select.area')}
        aria-disabled={inert || undefined}
        className={cn(
          'absolute inset-0 rounded-xl outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset',
          inert && 'pointer-events-none'
        )}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          className="img-outline size-full object-contain select-none"
        />
        {mask && shown && (
          <canvas
            ref={canvasRef}
            width={mask.width}
            height={mask.height}
            data-testid="selection-canvas"
            aria-label={t('studio:select.area')}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => setCursor(null)}
            className={cn('absolute touch-none opacity-50', tool === 'rect' ? 'cursor-crosshair' : 'cursor-none')}
            style={{ left: shown.x, top: shown.y, width: shown.width, height: shown.height }}
          />
        )}
        {shown && dragRect && mask && (
          <div
            aria-hidden
            className="pointer-events-none absolute border-2 border-dashed border-white bg-white/10 shadow-[0_0_0_1px_rgb(0_0_0/0.6)]"
            style={{
              left: shown.x + (dragRect.x / mask.width) * shown.width,
              top: shown.y + (dragRect.y / mask.height) * shown.height,
              width: (dragRect.width / mask.width) * shown.width,
              height: (dragRect.height / mask.height) * shown.height,
            }}
          />
        )}
        {shown && cursor && tool !== 'rect' && !inert && (
          <div
            aria-hidden
            className="pointer-events-none absolute rounded-full border border-white shadow-[0_0_0_1px_rgb(0_0_0/0.5)]"
            style={{
              left: shown.x + cursor.x - brush / 2,
              top: shown.y + cursor.y - brush / 2,
              width: brush,
              height: brush,
            }}
          />
        )}
      </div>
      {toolbarHost ? createPortal(toolbar, toolbarHost) : null}
    </>
  )
})
