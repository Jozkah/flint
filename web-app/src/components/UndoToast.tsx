import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { toast } from 'sonner'
import { useReducedMotion } from 'motion/react'
import { useInterfaceSettings } from '@/hooks/useInterfaceSettings'
import { cn } from '@/lib/utils'

const DEFAULT_MS = 4000

export interface UndoToastProps {
  /** Sonner id of the toast hosting this card; dismissed on undo or timeout. */
  toastId: string | number
  message: string
  description?: string
  undoLabel: string
  onUndo: () => void
  /** How long the Undo stays on offer. */
  durationMs?: number
}

/**
 * Toast card with an amber outline that burns away around its edge while the
 * Undo is on offer. Hovering pauses both the burn and the auto-dismiss.
 */
export function UndoToast({
  toastId,
  message,
  description,
  undoLabel,
  onUndo,
  durationMs = DEFAULT_MS,
}: UndoToastProps) {
  const systemReduced = useReducedMotion()
  const storeReduced = useInterfaceSettings((s) => s.reduceMotion)
  const animated = !(Boolean(systemReduced) || storeReduced)
  const cardRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [paused, setPaused] = useState(false)
  const remaining = useRef(durationMs)
  const startedAt = useRef(0)
  const timer = useRef<number | undefined>(undefined)

  const dismiss = useCallback(() => toast.dismiss(toastId), [toastId])

  const start = useCallback(() => {
    startedAt.current = Date.now()
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(dismiss, remaining.current)
  }, [dismiss])

  const pause = useCallback(() => {
    if (timer.current === undefined) return
    window.clearTimeout(timer.current)
    timer.current = undefined
    remaining.current = Math.max(
      0,
      remaining.current - (Date.now() - startedAt.current)
    )
    setPaused(true)
  }, [])

  const resume = useCallback(() => {
    if (timer.current !== undefined) return
    setPaused(false)
    start()
  }, [start])

  useEffect(() => {
    start()
    return () => window.clearTimeout(timer.current)
  }, [start])

  useLayoutEffect(() => {
    const el = cardRef.current
    if (!el || !animated) return
    const measure = () => setSize({ w: el.offsetWidth, h: el.offsetHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [animated])

  const undo = () => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    dismiss()
    onUndo()
  }

  return (
    <div
      ref={cardRef}
      role="status"
      data-testid="undo-toast"
      data-paused={paused ? 'true' : 'false'}
      onPointerEnter={pause}
      onPointerLeave={resume}
      className="relative flex w-[356px] max-w-full items-center gap-3 rounded-xl bg-popover px-3.5 py-3 text-popover-foreground shadow-pop"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium leading-snug">{message}</p>
        {description ? (
          <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={undo}
        className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        {undoLabel}
      </button>
      {animated && size ? (
        <svg
          aria-hidden
          data-testid="undo-toast-rim"
          className="undo-rim pointer-events-none absolute inset-0 size-full overflow-visible"
        >
          <rect
            x={0.75}
            y={0.75}
            width={Math.max(0, size.w - 1.5)}
            height={Math.max(0, size.h - 1.5)}
            rx={11.25}
            pathLength={1}
            className={cn('undo-rim-path', paused && 'undo-rim-paused')}
            style={{ animationDuration: `${durationMs}ms` }}
          />
        </svg>
      ) : null}
    </div>
  )
}
