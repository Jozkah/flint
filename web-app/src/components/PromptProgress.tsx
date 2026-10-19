import { useSecondClock } from '@/lib/sharedClock'
import { useAppState } from '@/hooks/useAppState'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { Hand, Loader } from 'lucide-react'
import { useParams } from '@tanstack/react-router'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { useTextOverflow } from '@/hooks/useTextOverflow'
import { useEffect, useRef, useState } from 'react'
import { formatElapsed, type RunStatus } from '@/lib/runStatus'
import { ModelLoader } from '@/containers/loaders/ModelLoader'

const LOADED_HOLD_MS = 1200
const FAILED_HOLD_MS = 6000

/**
 * When a model load ends, how long it took, for about a second, then null.
 * Derived from the loading flag alone, so no store logic is involved.
 */
function useLoadedFor(loading: boolean | undefined): number | null {
  const startedAt = useRef<number | null>(null)
  const [loadedMs, setLoadedMs] = useState<number | null>(null)
  useEffect(() => {
    if (loading) {
      startedAt.current = Date.now()
      setLoadedMs(null)
      return
    }
    if (startedAt.current === null) return
    setLoadedMs(Date.now() - startedAt.current)
    startedAt.current = null
    const id = setTimeout(() => setLoadedMs(null), LOADED_HOLD_MS)
    return () => clearTimeout(id)
  }, [loading])
  return loadedMs
}

/**
 * How long the model load ran before it failed, while the failure is still
 * worth showing, else null. The store stamps the failure; a new load clears it.
 */
function useFailedFor(failedAt: number | undefined, loading: boolean | undefined): number | null {
  const startedAt = useRef<number | null>(null)
  const lastMs = useRef<number>(0)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (loading) {
      startedAt.current = Date.now()
      return
    }
    if (startedAt.current !== null) {
      lastMs.current = Date.now() - startedAt.current
      startedAt.current = null
    }
  }, [loading])
  useEffect(() => {
    if (failedAt === undefined) {
      setVisible(false)
      return
    }
    setVisible(true)
    const id = setTimeout(() => setVisible(false), FAILED_HOLD_MS)
    return () => clearTimeout(id)
  }, [failedAt])
  return visible ? lastMs.current : null
}

/**
 * Milliseconds since `key` last changed, re-rendering once a second while
 * `active`. Drives the status line's timer and its escalating wording.
 */
function usePhaseElapsed(
  key: string | undefined,
  active: boolean,
  startedAt?: number
): number {
  const since = useRef<{ key?: string; at: number }>({ at: Date.now() })
  if (since.current.key !== key) since.current = { key, at: startedAt ?? Date.now() }
  useSecondClock(active)
  return Date.now() - since.current.at
}

export function PromptProgress({
  hideIdle = false,
  stateKey,
  status,
  since,
  waitingLabel,
}: {
  hideIdle?: boolean
  /**
   * The run is blocked on the user (an approval or a question): this label
   * replaces the phase, and the clock stops instead of counting a wait that
   * is not the model's.
   */
  waitingLabel?: string
  /**
   * What the run is doing (thinking, running a tool, ...). Replaces the
   * generic "Working…" with a named phase and how long it has lasted.
   */
  status?: RunStatus | null
  /**
   * When the phase really began, if before this component mounted (a reply
   * that went quiet some seconds ago). Defaults to the moment `status.key`
   * first appears.
   */
  since?: number
  /**
   * Identifies a caller outside the `/threads/:threadId` route — Cowork, keyed
   * by its own session id — overriding the auto-detected route param, and
   * switching the loading/progress read from useAppState's thread-keyed
   * Records to useCoworkRun's session-keyed mirror of the same shape. Prompt
   * progress has no Cowork equivalent, so it keeps the global fallback;
   * harmless, since Cowork never writes there.
   */
  stateKey?: string
}) {
  const params = useParams({ strict: false })
  const threadId = stateKey ?? (params as { threadId?: string })?.threadId
  const promptProgress = useAppState((state) =>
    (threadId ? state.promptProgresses[threadId] : undefined) ??
    state.promptProgress
  )
  const chatLoadingModel = useAppState((state) =>
    (threadId ? state.loadingModels[threadId] : undefined) ?? state.loadingModel
  )
  const coworkLoadingModel = useCoworkRun((state) =>
    stateKey ? state.loadingModels[stateKey] : undefined
  )
  const loadingModel = stateKey ? coworkLoadingModel : chatLoadingModel
  const chatLoadProgress = useAppState((state) =>
    (threadId ? state.modelLoadProgressByThread[threadId] : undefined) ??
    state.modelLoadProgress
  )
  const coworkLoadProgress = useCoworkRun((state) =>
    stateKey ? state.modelLoadProgress[stateKey] : undefined
  )
  const loadProgress = stateKey ? coworkLoadProgress : chatLoadProgress

  const percentage =
    promptProgress && promptProgress.total > 0
      ? Math.round((promptProgress.processed / promptProgress.total) * 100)
      : 0

  const showReading =
    promptProgress &&
    promptProgress.total > 0 &&
    percentage < 100

  // Nothing concrete to report (no model load, no prompt-reading progress).
  // Callers driving their own activity label (e.g. tool-call traces) pass
  // hideIdle to suppress the redundant generic "Working…" fallback.
  const waiting = Boolean(waitingLabel) && !!status
  const elapsed = usePhaseElapsed(
    waiting ? `${status?.key}:waiting` : status?.key,
    !!status && !waiting,
    since
  )
  const loadedMs = useLoadedFor(loadingModel)
  const failedAt = useAppState((state) =>
    stateKey || !threadId ? undefined : state.modelLoadFailures?.[threadId]
  )
  const failedMs = useFailedFor(failedAt, loadingModel)
  const labelRef = useRef<HTMLSpanElement>(null)
  useTextOverflow(labelRef)
  if (failedMs !== null && !loadingModel) {
    return (
      <ModelLoader status="failed" elapsedMs={failedMs} className="min-w-56" />
    )
  }
  if (loadedMs !== null && !loadingModel) {
    return (
      <ModelLoader status="done" elapsedMs={loadedMs} className="min-w-56" />
    )
  }
  if (hideIdle && !loadingModel && !showReading && !status) {
    return null
  }

  const loadPercentage =
    loadingModel && loadProgress ? Math.round(loadProgress.value * 100) : undefined

  // Only worth naming the stage when the load actually has more than one
  // (vision encoder and/or speculative-decoding draft model on top of the
  // main weights) - a plain text-only load is always a single "text_model"
  // stage for its entire duration, so calling that out would be noise.
  const stageLabel =
    loadingModel && loadProgress && (loadProgress.stages?.length ?? 0) > 1
      ? describeLoadStage(loadProgress.stage)
      : undefined

  const label = loadingModel
    ? loadPercentage !== undefined
      ? `Loading ${stageLabel ?? 'model'}: ${loadPercentage}%`
      : 'Loading model…'
    : showReading
      ? `Reading: ${percentage}%`
      : waiting
        ? waitingLabel!
        : status
        ? status.label(elapsed)
        : 'Waiting for the model…'

  const detail =
    showReading && !loadingModel ? buildDetail(promptProgress) : undefined

  // The floor keeps the box from resizing as the percentage and ETA change; a
  // bare "Working…" has nothing to stabilise, so it shrink-wraps instead of
  // sitting in a mostly-empty rectangle.
  const sized = loadingModel || showReading

  return (
    <div
      className={cn(
        'inline-flex max-w-full min-w-0 flex-col gap-2 rounded-lg border border-border/40 bg-muted/30 px-3 py-2',
        sized && 'min-w-56'
      )}
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        {waiting && !loadingModel && !showReading ? (
          <Hand aria-hidden className="w-3.5 h-3.5 text-warning shrink-0" />
        ) : (
          <Loader className="animate-spin w-3.5 h-3.5 text-primary shrink-0" />
        )}
        {/* One line at any width: the label fades rather than wrapping. */}
        <span
          ref={labelRef}
          className="text-fade font-medium text-foreground"
          data-testid="run-status-label"
        >
          {label}
        </span>
        {status && !waiting && !loadingModel && !showReading && (
          <span
            className="text-xs text-muted-foreground tabular-nums"
            data-testid="run-status-elapsed"
          >
            {formatElapsed(elapsed)}
          </span>
        )}
      </div>
      {showReading && !loadingModel && (
        <Progress value={percentage} className="h-1 bg-secondary/60" />
      )}
      {detail && (
        <div className="text-xs text-muted-foreground tabular-nums">
          {detail}
        </div>
      )}
    </div>
  )
}

function describeLoadStage(stage: string | undefined): string | undefined {
  switch (stage) {
    case 'text_model':
      return 'text model'
    case 'mmproj_model':
      return 'vision encoder'
    case 'spec_model':
      return 'draft model'
    default:
      return undefined
  }
}

function buildDetail(progress: {
  processed: number
  total: number
  time_ms: number
}): string {
  const parts = [
    `${formatTokens(progress.processed)} / ${formatTokens(progress.total)} tokens`,
  ]

  // Extrapolate remaining time from the processing rate so far.
  if (progress.time_ms > 0 && progress.processed > 0) {
    const remaining = progress.total - progress.processed
    const etaMs = (progress.time_ms / progress.processed) * remaining
    if (remaining > 0) parts.push(`~${formatEta(etaMs)} left`)
  }

  return parts.join(' · ')
}

function formatTokens(n: number): string {
  if (n >= 1000) {
    const k = n / 1000
    return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`
  }
  return `${n}`
}

function formatEta(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rem = seconds % 60
  return rem > 0 ? `${minutes}m ${rem}s` : `${minutes}m`
}
