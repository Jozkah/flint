import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Loader } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatElapsed } from '@/lib/runStatus'

export type ModelLoaderStatus = 'loading' | 'done' | 'failed'

const WORDS: Record<ModelLoaderStatus, string> = {
  loading: 'Loading model…',
  done: 'Loaded in',
  failed: 'Failed after',
}

/**
 * Model load status card: spinner + label + live elapsed timer while loading,
 * then a green check ("Loaded in 4s") or an alert ("Failed after 4s"). The
 * timer freezes when the status leaves `loading`; `elapsedMs` pins it instead.
 */
export function ModelLoader({
  status = 'loading',
  elapsedMs,
  label,
  className,
}: {
  status?: ModelLoaderStatus
  elapsedMs?: number
  /** Overrides the loading label (e.g. a percentage). */
  label?: string
  className?: string
}) {
  const start = useRef(Date.now())
  const frozen = useRef<number | undefined>(undefined)
  const [, tick] = useState(0)
  useEffect(() => {
    if (status !== 'loading' || elapsedMs !== undefined) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [status, elapsedMs])

  if (status === 'loading') frozen.current = undefined
  else if (frozen.current === undefined)
    frozen.current = Date.now() - start.current
  const ms = elapsedMs ?? frozen.current ?? Date.now() - start.current

  const Icon =
    status === 'done' ? Check : status === 'failed' ? AlertCircle : Loader
  const text = status === 'loading' && label ? label : WORDS[status]

  return (
    <div
      role="status"
      data-testid="model-loader"
      data-status={status}
      className={cn(
        'inline-flex flex-col gap-2 rounded-lg border border-border/40 bg-muted/30 px-3 py-2',
        status !== 'loading' && 'pp-state',
        className
      )}
    >
      <div className="flex items-center gap-2 text-sm">
        <Icon
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0',
            status === 'loading' && 'animate-spin text-primary',
            status === 'done' && 'text-success',
            status === 'failed' && 'text-destructive'
          )}
        />
        <span key={status} className="pp-swap font-medium text-foreground">
          {text}
        </span>
        <span
          className="text-xs text-muted-foreground tabular-nums"
          data-testid="model-loader-elapsed"
        >
          {formatElapsed(ms)}
        </span>
      </div>
    </div>
  )
}
