import { useEffect, useRef, useState } from 'react'
import type { ComponentProps, KeyboardEvent } from 'react'
import { Input } from '@/components/ui/input'
import {
  clampDecimal,
  isDecimalDraft,
  parseDecimalInput,
  readCommittedDecimal,
  withinBounds,
} from '@/lib/parseDecimalInput'

type DecimalInputProps = Omit<
  ComponentProps<typeof Input>,
  'value' | 'onChange' | 'type' | 'min' | 'max' | 'step'
> & {
  /** The committed value. Anything that is not a finite number shows as empty. */
  value: number | string | null | undefined
  /**
   * Called with a finished number, or null when the field was emptied. Fires
   * while typing only for complete, in-range numbers; the final (clamped)
   * number comes on blur or Enter. Never called with NaN.
   */
  onValueChange: (value: number | null) => void
  min?: number
  max?: number
}

function textOf(value: DecimalInputProps['value']): string {
  if (value === null || value === undefined || value === '') return ''
  const n = typeof value === 'number' ? value : readCommittedDecimal(value)
  return n !== null && Number.isFinite(n) ? String(n) : ''
}

/**
 * A number field that keeps the raw text while it is being edited, so "0.",
 * "0,", "-" and ".5" survive on the way to a full number. Accepts "." and ","
 * as the decimal separator.
 */
export function DecimalInput({
  value,
  onValueChange,
  min,
  max,
  onBlur,
  onKeyDown,
  ...rest
}: DecimalInputProps) {
  const committedText = textOf(value)
  const [draft, setDraft] = useState(committedText)
  const draftRef = useRef(draft)
  draftRef.current = draft

  // Follow outside changes (reset, other control, detection) unless the draft
  // already means that same number.
  useEffect(() => {
    const parsed = parseDecimalInput(draftRef.current)
    if (parsed.status === 'valid' && String(parsed.value) === committedText) return
    if (parsed.status === 'empty' && committedText === '') return
    if (parsed.status === 'partial' && readCommittedDecimal(draftRef.current) === (committedText === '' ? null : Number(committedText))) return
    setDraft(committedText)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedText])

  const commit = () => {
    const text = draftRef.current
    if (parseDecimalInput(text).status === 'empty') return
    const n = readCommittedDecimal(text)
    if (n === null) {
      // "-", "." or similar: nothing to commit, show what is stored.
      setDraft(committedText)
      return
    }
    const clamped = clampDecimal(n, min, max)
    setDraft(String(clamped))
    if (String(clamped) !== committedText) onValueChange(clamped)
  }

  return (
    <Input
      {...rest}
      type="text"
      inputMode="decimal"
      value={draft}
      onChange={(e) => {
        const next = e.target.value
        // Ignore keystrokes that can never become a number ("1e", letters).
        if (!isDecimalDraft(next)) return
        setDraft(next)
        const parsed = parseDecimalInput(next)
        if (parsed.status === 'empty') onValueChange(null)
        else if (parsed.status === 'valid' && withinBounds(parsed.value, min, max))
          onValueChange(parsed.value)
      }}
      onBlur={(e) => {
        commit()
        onBlur?.(e)
      }}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') commit()
        onKeyDown?.(e)
      }}
    />
  )
}
