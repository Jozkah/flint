import { formatTokenCount } from '@/lib/utils'

/**
 * How full the context window is: the one place "used / max input" is worked
 * out, so the composer's ring, the context bar and the Details meter cannot
 * disagree about it.
 *
 * `windowTokens` is the model's max input. Zero, negative, NaN and missing all
 * mean "not known": the answer then has no fraction at all, and a caller draws
 * an unknown state rather than a full or an empty bar.
 */

export const WARN_PCT = 85

export type ContextUsage = {
  known: boolean
  used: number
  /** The model's window, when known. */
  window: number | null
  /** Used share of the window, 0 to 1, clamped. 0 when the window is unknown. */
  fraction: number
  /** `fraction` as a percentage, 0 to 100. */
  pct: number
  /** More is in use than the window holds. */
  over: boolean
  tier: 'ok' | 'warn' | 'over'
  /**
   * What a segment of `tokens` is, as a share (0 to 1) of the bar. The bar is
   * the window; when usage runs past it, the bar is what is in use.
   */
  share: (tokens: number) => number
  /** Where auto-compact starts, as a share of the bar; null when it is off. */
  thresholdShare: number | null
  /** "25.5K / 262.1K (10%)", or "25.5K tokens (window unknown)". */
  label: string
}

const finiteNonNegative = (n: unknown): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0

export function contextUsage(
  usedTokens: number | null | undefined,
  windowTokens: number | null | undefined,
  /** Tokens held back for compaction to run in; 0 or absent when it is off. */
  compactBuffer?: number | null
): ContextUsage {
  const used = finiteNonNegative(usedTokens)
  const window = finiteNonNegative(windowTokens)
  if (window <= 0) {
    return {
      known: false,
      used,
      window: null,
      fraction: 0,
      pct: 0,
      over: false,
      tier: 'ok',
      share: () => 0,
      thresholdShare: null,
      label: `${formatTokenCount(used)} tokens (window unknown)`,
    }
  }
  const whole = Math.max(window, used)
  const fraction = Math.min(1, used / window)
  const pct = fraction * 100
  const buffer = Math.min(finiteNonNegative(compactBuffer), window)
  const over = used > window
  const pctText = pct > 0 && pct < 1 ? '<1' : pct.toFixed(0)
  return {
    known: true,
    used,
    window,
    fraction,
    pct,
    over,
    tier: used >= window ? 'over' : pct >= WARN_PCT ? 'warn' : 'ok',
    share: (tokens) => Math.min(1, finiteNonNegative(tokens) / whole),
    thresholdShare: buffer > 0 ? (window - buffer) / whole : null,
    label: `${formatTokenCount(used)} / ${formatTokenCount(window)} (${pctText}%)`,
  }
}
