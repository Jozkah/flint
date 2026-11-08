/**
 * Durations ("3:07", "1m 05s", "3 min") and ages ("2 hours ago") for every
 * surface. Each surface keeps its own look by passing explicit options; the
 * arithmetic lives here once.
 */

/**
 * Clock-style duration from whole seconds: "3:07", "1:02:03". Shared by the
 * room usage bar (ms input) and the artifact audio card (seconds input);
 * each caller keeps its own rounding and empty-value guards.
 */
export function formatClock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** A translator, as `useTranslation().t` or `i18n.t`. */
export type TimeTranslate = (key: string, options?: Record<string, unknown>) => string

export type DurationOptions =
  /** "3:07", "1:02:03". */
  | { style: 'clock'; rounding?: 'round' | 'floor' }
  /**
   * "2h 11m 30s", "1m 05s", "75s": every unit from the largest non-zero one
   * (at most `largest`) down to seconds.
   */
  | {
      style: 'units'
      rounding?: 'round' | 'floor'
      /** The largest unit shown; a longer time counts more of it. Default 'day'. */
      largest?: 'day' | 'hour' | 'minute' | 'second'
      /** Two digits for every unit after the first ("1m 05s"). */
      pad?: boolean
      /** Under a second reads "500ms" rather than "0s". */
      milliseconds?: boolean
    }
  /**
   * Short units in the reader's language: "45s", "1m 30s", "1h 20m 5s"
   * (keys `common:duration.seconds|minutes|hours`). A zero unit after the
   * first is left out.
   */
  | {
      style: 'words'
      t: TimeTranslate
      rounding?: 'round' | 'floor'
      /** The largest unit; 'minute' counts minutes past an hour. Default 'hour'. */
      largest?: 'hour' | 'minute'
      /** Past a minute, round to whole minutes instead of "1m 20s". */
      wholeMinutes?: boolean
      /** Under a second reads "1s" rather than "0s". */
      atLeastOneSecond?: boolean
    }

const round = (rounding: 'round' | 'floor' | undefined, n: number) =>
  rounding === 'floor' ? Math.floor(n) : Math.round(n)

const UNIT_SECONDS = { day: 86_400, hour: 3600, minute: 60, second: 1 } as const
const UNIT_SUFFIX = { day: 'd', hour: 'h', minute: 'm', second: 's' } as const
const UNIT_ORDER = ['day', 'hour', 'minute', 'second'] as const

function unitsText(
  ms: number,
  opts: Extract<DurationOptions, { style: 'units' }>
): string {
  const total = round(opts.rounding, ms / 1000)
  if (opts.milliseconds && total <= 0) return `${ms}ms`
  const units = UNIT_ORDER.slice(UNIT_ORDER.indexOf(opts.largest ?? 'day'))
  const parts: string[] = []
  let rest = total
  for (const unit of units) {
    const size = UNIT_SECONDS[unit]
    const value = Math.floor(rest / size)
    rest -= value * size
    if (parts.length === 0 && value === 0 && unit !== 'second') continue
    const shown =
      opts.pad && parts.length > 0 ? String(value).padStart(2, '0') : String(value)
    parts.push(`${shown}${UNIT_SUFFIX[unit]}`)
  }
  return parts.join(' ')
}

function wordsText(
  ms: number,
  opts: Extract<DurationOptions, { style: 'words' }>
): string {
  const { t } = opts
  const raw = Math.max(0, round(opts.rounding, ms / 1000))
  const total = opts.atLeastOneSecond ? Math.max(1, raw) : raw
  const seconds = (n: number) => t('common:duration.seconds', { count: n })
  const minutes = (n: number) => t('common:duration.minutes', { count: n })
  const hours = (n: number) => t('common:duration.hours', { count: n })
  if (total < 60) return seconds(total)
  const hoursShown = opts.largest !== 'minute'
  if (opts.wholeMinutes) {
    const m = Math.round(total / 60)
    if (m < 60 || !hoursShown) return minutes(m)
    return [hours(Math.floor(m / 60)), ...(m % 60 ? [minutes(m % 60)] : [])].join(' ')
  }
  const rest = total % 60
  if (total < 3600 || !hoursShown) {
    const m = minutes(Math.floor(total / 60))
    return rest === 0 ? m : `${m} ${seconds(rest)}`
  }
  const parts = [hours(Math.floor(total / 3600))]
  const m = Math.floor((total % 3600) / 60)
  if (m > 0) parts.push(minutes(m))
  if (rest > 0) parts.push(seconds(rest))
  return parts.join(' ')
}

/**
 * Elapsed whole seconds as short units: "45s", "1m 30s", "1h 20m". The
 * inline headers' and task panels' preset of `formatDuration`.
 */
export function formatCompactDuration(totalSeconds: number, t: TimeTranslate): string {
  return formatDuration(Math.floor(totalSeconds) * 1000, { style: 'words', t, rounding: 'floor' })
}

/** A length of time, in milliseconds, in the style the options name. */
export function formatDuration(ms: number, opts: DurationOptions): string {
  switch (opts.style) {
    case 'clock':
      return formatClock(Math.max(0, round(opts.rounding, ms / 1000)))
    case 'units':
      return unitsText(ms, opts)
    case 'words':
      return wordsText(ms, opts)
  }
}

/** One step of an age scale: a unit, its length, and where the next takes over. */
export type AgeUnit = {
  unit: Intl.RelativeTimeFormatUnit
  /** The unit's length in seconds. */
  seconds: number
  /** Stay in this unit while the age is under this many seconds. Default: the next unit's length. */
  until?: number
}

const DAY = 86_400
const WEEK = 7 * DAY
const MONTH = WEEK * 4.35

/** Second to year, each unit until the next one is reached. */
export const AGE_UNITS: readonly AgeUnit[] = [
  { unit: 'second', seconds: 1 },
  { unit: 'minute', seconds: 60 },
  { unit: 'hour', seconds: 3600 },
  { unit: 'day', seconds: DAY },
  { unit: 'week', seconds: WEEK },
  { unit: 'month', seconds: MONTH },
  { unit: 'year', seconds: MONTH * 12 },
]

export type AgeOptions = {
  /** The moment to measure from, in ms. Default: now. */
  now?: number
  /** The scale, smallest unit first. Default `AGE_UNITS`. */
  units?: readonly AgeUnit[]
  /** Default 'round'. */
  rounding?: 'round' | 'floor'
  /**
   * Round at every step: each unit counts the previous unit's rounded value
   * ("90 s" is 2 minutes, then 2 minutes is under an hour), the way a person
   * reads a clock. Default: one rounding of the exact age.
   */
  cascade?: boolean
  /** A moment in the future reads as now. */
  pastOnly?: boolean
  /** The smallest number reported (a non-zero age never reads "0 minutes"). */
  minValue?: number
}

/**
 * How long ago (or until) `at`, as a number and a unit, negative in the past.
 * Formatting is the caller's (`timeAgo` for Intl wording).
 */
export function ageParts(
  at: number,
  opts: AgeOptions = {}
): { value: number; unit: Intl.RelativeTimeFormatUnit } {
  const units = opts.units ?? AGE_UNITS
  const now = opts.now ?? Date.now()
  let diff = (at - now) / 1000
  if (opts.pastOnly) diff = Math.min(0, diff)
  const sign = diff < 0 ? -1 : 1
  const abs = Math.abs(diff)
  // The magnitude, rounded, with the sign put back; zero stays a plain zero.
  const signed = (magnitude: number) => {
    const shown =
      opts.minValue !== undefined ? Math.max(opts.minValue, magnitude) : magnitude
    return shown === 0 ? 0 : sign * shown
  }
  if (opts.cascade) {
    let value = round(opts.rounding, abs / units[0].seconds)
    for (let i = 0; i < units.length; i++) {
      const step = units[i]
      const next = units[i + 1]
      const limit = next ? (step.until ?? next.seconds) / step.seconds : Infinity
      if (value < limit) return { value: signed(value), unit: step.unit }
      value = round(opts.rounding, (value * step.seconds) / next.seconds)
    }
  }
  for (let i = 0; i < units.length; i++) {
    const step = units[i]
    const next = units[i + 1]
    if (!next || abs < (step.until ?? next.seconds)) {
      const exact = diff / step.seconds
      // 'round' rounds the signed age, as Math.round does; 'floor' counts whole
      // units of the magnitude.
      const value =
        opts.rounding === 'floor'
          ? signed(Math.floor(abs / step.seconds))
          : opts.minValue !== undefined
            ? signed(Math.round(abs / step.seconds))
            : Math.round(exact)
      return { value, unit: step.unit }
    }
  }
  return { value: 0, unit: units[0].unit }
}

export type TimeAgoOptions = AgeOptions & {
  /** The reader's language, e.g. `i18n.language`. Default 'en'. */
  locale?: string
  /** 'auto' says "yesterday"; 'always' says "1 day ago". Default 'auto'. */
  numeric?: 'auto' | 'always'
}

/** "2 minutes ago", "yesterday", "in 3 days", in the reader's language. */
export function timeAgo(at: number, opts: TimeAgoOptions = {}): string {
  const { value, unit } = ageParts(at, opts)
  return new Intl.RelativeTimeFormat(opts.locale ?? 'en', {
    numeric: opts.numeric ?? 'auto',
  }).format(value, unit)
}
