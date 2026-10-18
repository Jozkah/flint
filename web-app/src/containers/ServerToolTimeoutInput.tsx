import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'

/**
 * Per-server tool call timeout in whole seconds. Typed text stays a string
 * until blur or Enter; a usable entry is floored to an integer >= 1 and shown
 * as saved, empty clears the override (the global value applies), and anything
 * else reverts, so the field never shows a value that was not stored.
 */
export function ServerToolTimeoutInput({
  seconds,
  placeholder,
  ariaLabel,
  onCommit,
}: {
  seconds: number | undefined
  placeholder: string
  ariaLabel: string
  onCommit: (seconds: number | undefined) => void
}) {
  const shown = seconds === undefined ? '' : String(seconds)
  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])
  const commit = () => {
    if (draft.trim() === '') {
      setDraft('')
      if (seconds !== undefined) onCommit(undefined)
      return
    }
    const whole = Math.floor(Number(draft))
    if (Number.isFinite(whole) && whole >= 1) {
      setDraft(String(whole))
      if (whole !== seconds) onCommit(whole)
    } else {
      setDraft(shown)
    }
  }
  return (
    <Input
      type="number"
      min={1}
      step={1}
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
      onBlur={commit}
      className="h-7 w-20 text-xs"
    />
  )
}
