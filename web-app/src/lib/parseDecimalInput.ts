/**
 * Parsing for free-typed decimal numbers in settings fields.
 *
 * Text fields have to keep what the person typed ("0.", "0,", "-", ".5")
 * while they are still typing. Only a complete number is turned into a real
 * value. Both "." and "," count as the decimal separator.
 */

export type DecimalParse =
  /** Nothing typed. */
  | { status: 'empty' }
  /** A valid beginning of a number that is not a number yet: "-", "0.", ",". */
  | { status: 'partial' }
  /** A complete finite number. */
  | { status: 'valid'; value: number }
  /** Not a number and not the start of one: "1e", "abc", "1.2.3". */
  | { status: 'invalid' }

const PARTIAL = /^[+-]?(\d*[.,])?$/
const COMPLETE = /^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/

export function parseDecimalInput(raw: string | null | undefined): DecimalParse {
  const text = (raw ?? '').trim()
  if (text === '') return { status: 'empty' }
  if (COMPLETE.test(text)) {
    // "0." and "0," are complete enough to read as 0 but are still being
    // typed; callers keep the raw text, so reading them as a number is fine.
    const value = Number(text.replace(',', '.'))
    if (Number.isFinite(value)) {
      return /[.,]$/.test(text) ? { status: 'partial' } : { status: 'valid', value }
    }
    return { status: 'invalid' }
  }
  if (PARTIAL.test(text) || text === '+' || text === '-') return { status: 'partial' }
  return { status: 'invalid' }
}

/**
 * The number a finished edit means, or null when there is none ("", "-",
 * "1e"). "0." and "5," read as 0 and 5 once editing is over.
 */
export function readCommittedDecimal(raw: string | null | undefined): number | null {
  const text = (raw ?? '').trim().replace(/[.,]$/, '')
  const parsed = parseDecimalInput(text)
  return parsed.status === 'valid' ? parsed.value : null
}

/** Whether `raw` may stay in the field while typing (empty, partial or valid). */
export function isDecimalDraft(raw: string): boolean {
  return parseDecimalInput(raw).status !== 'invalid'
}

/** Clamp to optional bounds. Never returns NaN for a finite input. */
export function clampDecimal(value: number, min?: number, max?: number): number {
  let out = value
  if (min !== undefined && Number.isFinite(min) && out < min) out = min
  if (max !== undefined && Number.isFinite(max) && out > max) out = max
  return out
}

/** Whether a number sits inside optional bounds. */
export function withinBounds(value: number, min?: number, max?: number): boolean {
  return clampDecimal(value, min, max) === value
}
