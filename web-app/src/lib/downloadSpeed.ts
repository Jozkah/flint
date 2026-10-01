/**
 * Download speed and time remaining for a progress readout.
 *
 * Progress events arrive in bursts, so a raw bytes-over-time figure jumps. The
 * speed is an exponential moving average over the intervals between events,
 * and a stall (no bytes for a while) lets it fall rather than freezing.
 */

/** Weight of the newest interval in the average. */
const SMOOTHING = 0.25
/** An interval shorter than this is too noisy to measure. */
const MIN_INTERVAL_MS = 250

export type SpeedSample = {
  /** Smoothed bytes per second, or 0 until one has been measured. */
  bytesPerSecond: number
  /** When `downloaded` was last counted. */
  at: number
  downloaded: number
}

export function startSpeedSample(downloaded: number, now: number): SpeedSample {
  return { bytesPerSecond: 0, at: now, downloaded }
}

/** The sample after progress to `downloaded` at `now`. */
export function updateSpeedSample(
  prev: SpeedSample,
  downloaded: number,
  now: number
): SpeedSample {
  const elapsed = now - prev.at
  if (downloaded < prev.downloaded) return startSpeedSample(downloaded, now)
  if (elapsed < MIN_INTERVAL_MS) return prev
  const instant = ((downloaded - prev.downloaded) * 1000) / elapsed
  const bytesPerSecond =
    prev.bytesPerSecond > 0
      ? prev.bytesPerSecond * (1 - SMOOTHING) + instant * SMOOTHING
      : instant
  return { bytesPerSecond, at: now, downloaded }
}

/** Seconds left at the current speed, or null when it cannot be told. */
export function secondsRemaining(
  downloaded: number,
  total: number | undefined,
  bytesPerSecond: number
): number | null {
  if (!total || total <= downloaded || bytesPerSecond <= 0) return null
  return Math.ceil((total - downloaded) / bytesPerSecond)
}

/** `45 s`, `12 min`, `1 h 20 min`: coarse, because the estimate is. */
export function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}
