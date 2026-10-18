import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'

/**
 * Minutes before an idle server stops. Typed text stays a string until blur or
 * Enter, so the field can be cleared and retyped; an unusable entry reverts.
 * Absent means the backend default of 15 minutes; 0 means never stop.
 */
export function IdleShutdownInput({
  minutes,
  onCommit,
  onBlur,
}: {
  minutes: number
  onCommit: (minutes: number) => void
  onBlur: () => void
}) {
  const [draft, setDraft] = useState(String(minutes))
  useEffect(() => setDraft(String(minutes)), [minutes])
  const commit = () => {
    const parsed = Number(draft)
    if (draft.trim() !== '' && Number.isFinite(parsed) && parsed >= 0) {
      const whole = Math.floor(parsed)
      setDraft(String(whole))
      if (whole !== minutes) onCommit(whole)
    } else {
      setDraft(String(minutes))
    }
  }
  return (
    <Input
      type="number"
      min={0}
      step={1}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
      onBlur={() => {
        commit()
        onBlur()
      }}
      className="w-28"
    />
  )
}
