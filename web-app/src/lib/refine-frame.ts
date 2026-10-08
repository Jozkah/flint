/** Block sizes (CSS px) of the mosaic, coarse to sharp. */
export const REFINE_LEVELS = [48, 32, 20, 12, 8, 5, 3, 2, 1] as const

export type RefineStatus =
  | 'queued'
  | 'generating'
  | 'refining'
  | 'complete'
  | 'error'

/** Height of the soft band between two levels, in CSS px. */
export const REFINE_EDGE = 28

/**
 * Where a 0..1 progress value sits in the mosaic: the level shown above the
 * sweeping edge, and how far the edge has travelled towards the next level.
 */
export function mosaicPosition(progress: number): {
  level: number
  frac: number
} {
  const n = REFINE_LEVELS.length - 1
  const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0))
  const at = p * n
  const level = Math.min(n, Math.floor(at + 1e-6))
  return { level, frac: level >= n ? 0 : Math.max(0, at - level) }
}

/** Map a real job to the chip state: waiting, drawing, or the last stretch. */
export function refineStatusFor(
  job:
    | {
        phase: string
        fraction: number
        remote?: string
      }
    | null
    | undefined
): RefineStatus {
  if (!job) return 'complete'
  if (job.remote || job.phase === 'queued') return 'queued'
  if (
    job.phase === 'decoding' ||
    job.phase === 'saving' ||
    job.fraction >= 0.85
  )
    return 'refining'
  return 'generating'
}

export const REFINE_ACTIVE: ReadonlySet<RefineStatus> = new Set<RefineStatus>([
  'queued',
  'generating',
  'refining',
])
