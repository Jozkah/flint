import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useReducedMotion } from 'motion/react'
import { AlertCircle, LoaderCircle, RefreshCw, Square } from 'lucide-react'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import {
  mosaicPosition,
  REFINE_ACTIVE,
  REFINE_EDGE,
  REFINE_LEVELS,
  type RefineStatus,
} from '@/lib/refine-frame'
import { cn } from '@/lib/utils'

export type RefineFrameLabels = {
  queued: string
  generating: string
  refining: string
  complete: string
  error: string
  stop: string
  retry: string
}

const DEFAULT_LABELS: RefineFrameLabels = {
  queued: 'Queued',
  generating: 'Generating',
  refining: 'Refining',
  complete: 'Ready',
  error: 'Failed',
  stop: 'Stop',
  retry: 'Retry',
}

const STAGES: Record<
  RefineStatus,
  { blur: number; sat: number; scale: number; opacity: number }
> = {
  queued: { blur: 4, sat: 0.6, scale: 1.04, opacity: 0.55 },
  generating: { blur: 1.5, sat: 0.8, scale: 1.02, opacity: 0.85 },
  refining: { blur: 0.5, sat: 0.95, scale: 1.005, opacity: 1 },
  complete: { blur: 0, sat: 1, scale: 1, opacity: 1 },
  error: { blur: 2, sat: 0.5, scale: 1, opacity: 0.28 },
}

const STRIPS = 14
/** Seconds the sweep takes to cross the whole mosaic when it has to catch up. */
const CATCH_UP_SECONDS = 1.1

type Levels = {
  key: string
  w: number
  h: number
  canvases: HTMLCanvasElement[]
  glint: CanvasGradient
}

function levelsKey(
  img: HTMLImageElement,
  canvas: HTMLCanvasElement,
  dpr: number
): string {
  const rect = canvas.getBoundingClientRect()
  return `${img.currentSrc}|${Math.max(1, Math.round(rect.width * dpr))}x${Math.max(1, Math.round(rect.height * dpr))}`
}

function buildLevels(
  img: HTMLImageElement,
  canvas: HTMLCanvasElement,
  dpr: number
): Levels | null {
  const rect = canvas.getBoundingClientRect()
  const w = Math.max(1, Math.round(rect.width * dpr))
  const h = Math.max(1, Math.round(rect.height * dpr))
  const iw = img.naturalWidth
  const ih = img.naturalHeight
  if (!iw || !ih) return null
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  // The picture is letterboxed (object-contain): find where it lands.
  const fit = Math.min(w / iw, h / ih)
  const dw = Math.max(1, Math.round(iw * fit))
  const dh = Math.max(1, Math.round(ih * fit))
  const dx = Math.round((w - dw) / 2)
  const dy = Math.round((h - dh) / 2)
  const glint = ctx.createLinearGradient(0, 0, w, 0)
  const stops: Array<[number, number]> = [
    [0, 0],
    [0.08, 0.1],
    [0.2, 0.7],
    [0.32, 1],
    [0.68, 1],
    [0.8, 0.7],
    [0.92, 0.1],
    [1, 0],
  ]
  for (const [at, a] of stops) glint.addColorStop(at, `rgba(255,255,255,${a})`)
  const canvases = REFINE_LEVELS.map((block) => {
    const full = document.createElement('canvas')
    full.width = w
    full.height = h
    const fc = full.getContext('2d')
    if (!fc) return full
    if (block === 1) {
      fc.imageSmoothingEnabled = true
      fc.imageSmoothingQuality = 'high'
      fc.drawImage(img, dx, dy, dw, dh)
      return full
    }
    const b = Math.max(2, Math.round(block * dpr))
    const small = document.createElement('canvas')
    small.width = Math.max(1, Math.round(dw / b))
    small.height = Math.max(1, Math.round(dh / b))
    const sc = small.getContext('2d')
    if (!sc) return full
    sc.imageSmoothingEnabled = true
    sc.imageSmoothingQuality = 'high'
    sc.drawImage(img, 0, 0, small.width, small.height)
    fc.imageSmoothingEnabled = false
    fc.drawImage(small, dx, dy, dw, dh)
    return full
  })
  return { key: levelsKey(img, canvas, dpr), w, h, canvases, glint }
}

export type RefineFrameProps = {
  /** The picture to reveal. Without one a shimmer holds the place. */
  src?: string | null
  alt: string
  status: RefineStatus
  /** Real progress, 0..1. Drives the mosaic while the job is active. */
  fraction?: number
  onStop?: () => void
  onRetry?: () => void
  labels?: Partial<RefineFrameLabels>
  /** Small text under the status chip, e.g. phase, percent and ETA. */
  detail?: ReactNode
  className?: string
  /** Extra controls, positioned by the caller. */
  children?: ReactNode
}

/**
 * Shows a generated picture sharpening from big blocks to the final image,
 * following the real job progress, with a status chip and Stop / Retry.
 */
export function RefineFrame({
  src,
  alt,
  status,
  fraction = 0,
  onStop,
  onRetry,
  labels,
  detail,
  className,
  children,
}: RefineFrameProps) {
  const text = { ...DEFAULT_LABELS, ...labels }
  const osReduce = useReducedMotion()
  const storeReduce = useInterfaceSettings((s) => s.reduceMotion)
  const reduce = Boolean(osReduce || storeReduce)
  const active = REFINE_ACTIVE.has(status)

  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [loaded, setLoaded] = useState(false)
  const [resolved, setResolved] = useState(!active)
  // Latest inputs for the animation loop, which must not re-subscribe per tick.
  const live = useRef({ fraction, reduce, active })
  const sim = useRef({
    p: 1,
    raf: 0,
    last: 0,
    levels: null as Levels | null,
    wasActive: active,
  })
  useEffect(() => {
    live.current = { fraction, reduce, active }
  })

  // A new picture arriving after a job reveals itself from the blocks again.
  const lastSrc = useRef(src)
  useEffect(() => {
    if (lastSrc.current === src) return
    lastSrc.current = src
    sim.current.levels = null
    setLoaded(false)
    if (sim.current.wasActive) {
      sim.current.p = 0
      setResolved(false)
    }
  }, [src])

  useEffect(() => {
    if (!active) return
    sim.current.wasActive = true
    setResolved(false)
  }, [active])

  useEffect(() => {
    const s = sim.current
    const img = imgRef.current
    const canvas = canvasRef.current
    if (!loaded || !img || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      setResolved(true)
      return
    }
    const tick = (now: number) => {
      const cur = live.current
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const dt = Math.min(0.05, s.last ? (now - s.last) / 1000 : 0.016)
      s.last = now
      if (!s.levels || s.levels.key !== levelsKey(img, canvas, dpr))
        s.levels = buildLevels(img, canvas, dpr)
      const lv = s.levels
      if (!lv) {
        s.raf = 0
        return
      }
      const target = cur.active ? Math.min(0.999, Math.max(0, cur.fraction)) : 1
      const step = cur.reduce ? 1 : dt / CATCH_UP_SECONDS
      if (cur.active && target < s.p) s.p = target
      else if (target - s.p <= step) s.p = target
      else s.p += step
      const { level, frac } = mosaicPosition(s.p)
      ctx.clearRect(0, 0, lv.w, lv.h)
      ctx.globalAlpha = 1
      ctx.drawImage(lv.canvases[level], 0, 0)
      const next = lv.canvases[level + 1]
      if (next && frac > 0) {
        const edge = REFINE_EDGE * dpr
        const front = frac * (lv.h + edge) - edge / 2
        const top = Math.max(0, Math.floor(front - edge / 2))
        if (top > 0) ctx.drawImage(next, 0, 0, lv.w, top, 0, 0, lv.w, top)
        const sh = edge / STRIPS
        for (let k = 0; k < STRIPS; k++) {
          const y = front - edge / 2 + k * sh
          if (y + sh <= 0 || y >= lv.h) continue
          const t = 1 - (k + 0.5) / STRIPS
          ctx.globalAlpha = t * t * (3 - 2 * t)
          const y0 = Math.max(0, y)
          const h0 = Math.min(lv.h, y + sh) - y0
          if (h0 > 0) ctx.drawImage(next, 0, y0, lv.w, h0, 0, y0, lv.w, h0)
        }
        ctx.globalAlpha = 1
        if (!cur.reduce && front > 0 && front < lv.h) {
          ctx.fillStyle = lv.glint
          ctx.globalAlpha = 0.12
          ctx.fillRect(0, front - 2 * dpr, lv.w, 4 * dpr)
          ctx.globalAlpha = 0.3
          ctx.fillRect(0, front - dpr, lv.w, 2 * dpr)
          ctx.globalAlpha = 1
        }
      }
      if (s.p >= 1 && !cur.active) {
        s.wasActive = false
        setResolved(true)
      }
      if (cur.active || Math.abs(target - s.p) > 0.0005) {
        s.raf = requestAnimationFrame(tick)
      } else {
        s.raf = 0
        s.last = 0
      }
    }
    s.raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(s.raf)
      s.raf = 0
      s.last = 0
    }
  }, [loaded, active, fraction, src])

  const stage = STAGES[status]
  const mosaic = loaded && !resolved
  const label = text[status]

  return (
    <div
      role="img"
      aria-label={label}
      aria-busy={active || undefined}
      data-testid="refine-frame"
      data-status={status}
      data-mosaic={mosaic ? '' : undefined}
      data-resolved={resolved ? '' : undefined}
      className={cn(
        'rf-root relative isolate size-full overflow-hidden',
        className
      )}
    >
      {src ? (
        <div
          aria-hidden
          className="rf-in absolute inset-0"
          style={{
            opacity: stage.opacity,
            filter: `blur(${mosaic ? 0 : stage.blur}px) saturate(${stage.sat})`,
            transform: `scale(${mosaic ? 1 : stage.scale})`,
          }}
        >
          <img
            ref={imgRef}
            key={src}
            src={src}
            alt={alt}
            onLoad={() => setLoaded(true)}
            className={cn(
              'rf-print size-full object-contain',
              mosaic && 'opacity-0'
            )}
          />
          <canvas
            ref={canvasRef}
            className={cn(
              'rf-canvas pointer-events-none absolute inset-0 size-full',
              !mosaic && 'opacity-0'
            )}
          />
        </div>
      ) : (
        <div
          aria-hidden
          data-testid="refine-frame-shimmer"
          className="rf-shimmer absolute inset-0"
        />
      )}
      {active && !mosaic && (
        <div
          aria-hidden
          className="rf-sweep pointer-events-none absolute inset-0"
        />
      )}

      <div className="pointer-events-none absolute bottom-2.5 left-2.5 flex max-w-[calc(100%-6rem)] flex-col items-start gap-1">
        <div
          key={status}
          data-testid="refine-frame-chip"
          className="rf-chip inline-flex h-[26px] items-center gap-1.5 rounded-[13px] pr-2.5 pl-2 text-xs font-medium"
        >
          {active ? (
            <LoaderCircle aria-hidden className="rf-spin size-3.5" />
          ) : status === 'error' ? (
            <AlertCircle aria-hidden className="size-3.5 text-destructive" />
          ) : null}
          <span className="rf-label">{label}</span>
        </div>
        {detail && (
          <div className="rf-detail text-xs tabular-nums">{detail}</div>
        )}
      </div>

      {active && onStop && (
        <button
          type="button"
          onClick={onStop}
          className="rf-stop absolute right-2.5 bottom-2.5 inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-[13px] pr-2.5 pl-2 text-xs font-medium focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden pointer-coarse:h-11"
        >
          <Square aria-hidden className="size-3" /> {text.stop}
        </button>
      )}
      {status === 'error' && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rf-retry absolute top-1/2 left-1/2 inline-flex h-8 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center gap-1.5 rounded-2xl border-0 pr-3.5 pl-3 text-[13px] font-medium focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden"
        >
          <RefreshCw aria-hidden className="size-3.5" /> {text.retry}
        </button>
      )}
      {children}
    </div>
  )
}
